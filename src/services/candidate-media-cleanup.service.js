import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { deleteDamAsset } from "./dam.media.service.js";
export async function collectCandidateMedia(db, tenantId, candidate) {
  const [drafts, uploads, offers, photos, reports, packets] = await Promise.all(
    [
      db.applicationDraft.findMany({
        where: { tenantId, candidateId: candidate.id },
        select: { resumeMediaId: true },
      }),
      db.candidateDocumentUpload.findMany({
        where: { tenantId, candidateId: candidate.id },
        select: { mediaId: true },
      }),
      db.offer.findMany({
        where: { tenantId, candidateId: candidate.id },
        select: { offerLetterMediaId: true },
      }),
      db.candidateCheckIn.findMany({
        where: { tenantId, candidateId: candidate.id },
        select: { photoMediaId: true },
      }),
      db.candidateEvaluationSummary.findMany({
        where: {
          tenantId,
          applicationId: {
            in: (
              await db.application.findMany({
                where: { tenantId, candidateId: candidate.id },
                select: { id: true },
              })
            ).map((a) => a.id),
          },
        },
        select: { pdfMediaId: true },
      }),
      db.interviewPacketItem.findMany({
        where: {
          tenantId,
          docClass: { in: ["PORTFOLIO", "GENERAL_APPLICATION_DOC"] },
          interview: { application: { candidateId: candidate.id } },
        },
        select: { mediaId: true },
      }),
    ],
  );
  const ids = [
    candidate.resumeMediaId,
    ...drafts.map((x) => x.resumeMediaId),
    ...uploads.map((x) => x.mediaId),
    ...offers.map((x) => x.offerLetterMediaId),
    ...photos.map((x) => x.photoMediaId),
    ...reports.map((x) => x.pdfMediaId),
    ...packets.map((x) => x.mediaId),
  ]
    .filter((v) => v != null)
    .map(String);
  const owned = [];
  for (const id of new Set(ids)) {
    const numeric = Number(id);
    const shared =
      Number.isSafeInteger(numeric) && numeric > 0
        ? await db.candidate.findFirst({
            where: {
              tenantId,
              id: { not: candidate.id },
              resumeMediaId: numeric,
            },
            select: { id: true },
          })
        : null;
    const sharedPacket =
      Number.isSafeInteger(numeric) && numeric > 0
        ? await db.interviewPacketItem.findFirst({
            where: {
              tenantId,
              mediaId: numeric,
              interview: {
                application: { candidateId: { not: candidate.id } },
              },
            },
            select: { id: true },
          })
        : null;
    const sharedRequisition =
      Number.isSafeInteger(numeric) && numeric > 0
        ? await db.requisitionAttachment.findFirst({
            where: { tenantId, mediaId: numeric },
            select: { id: true },
          })
        : null;
    if (!shared && !sharedPacket && !sharedRequisition) owned.push(id);
  }
  return owned;
}
export async function runCandidateMediaCleanup({
  now = new Date(),
  remove = deleteDamAsset,
  limit = 50,
} = {}) {
  // The scheduler supplies SYSTEM context only for this bounded tenant discovery.
  const logs = await prisma.candidateAnonymizationLog.findMany({
    where: {
      OR: [
        { damCleanup: { path: ["state"], equals: "PENDING" } },
        { damCleanup: { path: ["state"], equals: "CLAIMED" } },
      ],
    },
    select: { id: true, tenantId: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  let completed = 0,
    retried = 0;
  for (const log of logs)
    await runWithRequestContext(
      { system: false, user: { tenantId: log.tenantId } },
      async () => {
        const claimed = await tenantTransaction(
          prisma,
          async (db) => {
            await db.$executeRaw`SELECT id FROM candidate_anonymization_logs WHERE id=${log.id} AND "tenantId"=${log.tenantId}::uuid FOR UPDATE`;
            const row = await db.candidateAnonymizationLog.findUnique({
              where: { id: log.id },
            });
            const work = row.damCleanup;
            if (
              !work ||
              work.state === "COMPLETE" ||
              (work.leaseUntil && new Date(work.leaseUntil) > now)
            )
              return null;
            const candidate = await db.candidate.findFirst({
              where: {
                id: row.candidateId,
                tenantId: log.tenantId,
                anonymizedAt: { not: null },
              },
            });
            if (!candidate) return null;
            const leaseUntil = new Date(
              now.getTime() + 15 * 60000,
            ).toISOString();
            await db.candidateAnonymizationLog.update({
              where: { id: row.id },
              data: {
                damCleanup: {
                  ...work,
                  state: "CLAIMED",
                  leaseUntil,
                  attempts: (work.attempts ?? 0) + 1,
                },
              },
            });
            return { ...work, leaseUntil, candidateId: row.candidateId };
          },
          { tenantId: log.tenantId },
        );
        if (!claimed) return;
        const deleted = new Set(claimed.deleted ?? []),
          failed = [];
        for (const mediaId of claimed.requested ?? []) {
          if (deleted.has(mediaId)) continue;
          let result;
          try {
            result = await remove(mediaId);
          } catch {
            result = { ok: false };
          }
          if (result.ok) deleted.add(mediaId);
          else failed.push({ mediaId, error: "DAM deletion will be retried" });
        }
        await tenantTransaction(
          prisma,
          async (db) => {
            await db.$executeRaw`SELECT id FROM candidate_anonymization_logs WHERE id=${log.id} AND "tenantId"=${log.tenantId}::uuid FOR UPDATE`;
            const row = await db.candidateAnonymizationLog.findUnique({
              where: { id: log.id },
            });
            if (row.damCleanup.leaseUntil !== claimed.leaseUntil) return;
            for (const id of row.damCleanup.requested ?? []) if (!deleted.has(id) && !failed.some(f=>f.mediaId===id)) failed.push({mediaId:id,error:"Awaiting deletion"});
            await db.candidateAnonymizationLog.update({
              where: { id: log.id },
              data: {
                damCleanup: {
                  ...row.damCleanup,
                  state: failed.length ? "PENDING" : "COMPLETE",
                  deleted: [...deleted],
                  failed,
                  leaseUntil: null,
                },
              },
            });
            if (!failed.length)
              await db.candidateDocumentUpload.updateMany({
                where: {
                  tenantId: log.tenantId,
                  candidateId: claimed.candidateId,
                  status: "DELETE_PENDING",
                  mediaId: { in: [...deleted].map(Number).filter(Number.isSafeInteger) },
                },
                data: { status: "DELETED", mediaId: null },
              });
          },
          { tenantId: log.tenantId },
        );
        if (failed.length) retried++;
        else completed++;
      },
    );
  return { completed, retried };
}
