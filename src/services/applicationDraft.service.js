import { resolveJobBoardSource } from "./job-board-feeds.service.js";
import crypto from "node:crypto";
import { draftSourceJob } from "./recruitmentDraftSource.service.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { queueMailboxMessage } from "./candidateMailboxQueue.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { submitPublicApplication, getPublicJob } from "./publicPortal.service.js";
import { z } from "zod";

export const DRAFT_TTL_MS = 30 * 86400000;
export const PORTAL_DRAFT_PATH = "/draft";
export const hashDraftToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const bad = () =>
  Object.assign(new Error("This draft link is not valid"), {
    status: 400,
    code: "HR-5801",
  });
const Payload = z
  .object({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(30).optional(),
    answers: z.record(z.string(), z.unknown()).nullable().optional(),
    policyVersion: z.string().trim().max(100).optional(),
    consent: z.boolean().optional(),
  })
  .strip();
export const parseDraftPayload = (body) => Payload.parse(body ?? {});
export async function resolveDraft(db, { tenantId, token, now = new Date(), lock = false }) {
  if (!tenantId || !/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ""))) return null;
  const lookup = {
    where: {
      tenantId,
      tokenHash: hashDraftToken(token),
      submittedAt: null,
      expiresAt: { gt: now },
    },
    include: {
      candidate: {
        select: {
          id: true,
          firstName: true,
          email: true,
          anonymizedAt: true,
          retentionUntil: true,
          status: true,
        },
      },
    },
  };
  let draft = await db.applicationDraft.findFirst(lookup);
  if (!draft) return null;
  if (lock) {
    // Match intake/renewal: mailbox advisory lock, job, candidate, then draft.
    // Privacy erasure also locks the candidate before deleting owned drafts.
    await db.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      tenantId + ":" + String(draft.candidate.email).trim().toLowerCase(),
    );
    await db.$queryRawUnsafe(
      'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=$2 FOR SHARE',
      tenantId,
      draft.requisitionId,
    );
    await db.$queryRawUnsafe(
      'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      tenantId,
      draft.candidateId,
    );
    await db.$queryRawUnsafe(
      'SELECT id FROM application_drafts WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      tenantId,
      draft.id,
    );
    draft = await db.applicationDraft.findFirst(lookup);
  }
  if (
    !draft ||
    draft.candidate.anonymizedAt ||
    draft.candidate.status !== "active" ||
    (draft.candidate.retentionUntil && draft.candidate.retentionUntil <= now)
  )
    return null;
  if (
    await db.candidateDncEntry.findFirst({
      where: { tenantId, email: draft.candidate.email, liftedAt: null },
    })
  )
    return null;
  if (
    ["INTERNAL", "REFERRAL", "AGENCY"].includes(draft.source) &&
    !(await draftSourceJob(db, { tenantId, draft, now }))
  )
    return null;
  return draft;
}

export async function saveApplicationDraft({
  tenantId,
  requisitionId,
  email,
  firstName,
  body = {},
} = {}) {
  const address = z
    .email()
    .max(254)
    .parse(
      String(email ?? "")
        .trim()
        .toLowerCase(),
    );
  const reqId = z.coerce.number().int().positive().parse(requisitionId);
  const payload = parseDraftPayload(body);
  if (!isRecruitmentFlagEnabled("portal") || !(await getPublicJob({ tenantId, prisma, id: reqId })))
    throw bad();
  const token = crypto.randomBytes(32).toString("base64url");
  await tenantTransaction(
    prisma,
    async (db) => {
      // Serialize anonymous requests for the same address without returning identity details.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":" + address}, 0))`;
      await db.$queryRawUnsafe(
        'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=$2 FOR SHARE',
        tenantId,
        reqId,
      );
      const origin = await resolveJobBoardSource(db, {
        tenantId,
        requisitionId: reqId,
        receipt: body?.sourceReceipt,
      });
      if (
        await db.candidateDncEntry.findFirst({
          where: { tenantId, email: address, liftedAt: null },
        })
      )
        return null;
      let candidate = await db.candidate.findFirst({
        where: { tenantId, email: address },
      });
      if (
        candidate &&
        (candidate.anonymizedAt ||
          candidate.status !== "active" ||
          (candidate.retentionUntil && candidate.retentionUntil <= new Date()))
      )
        return null;
      candidate ??= await db.candidate.create({
        data: {
          tenantId,
          email: address,
          firstName: payload.firstName ?? firstName ?? "",
          source: origin,
          status: "active",
        },
      });
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
        tenantId,
        candidate.id,
      );
      candidate = await db.candidate.findFirst({
        where: { tenantId, id: candidate.id },
      });
      if (
        !candidate ||
        candidate.anonymizedAt ||
        candidate.status !== "active" ||
        (candidate.retentionUntil && candidate.retentionUntil <= new Date())
      )
        return null;
      if (
        await db.candidateDncEntry.findFirst({
          where: { tenantId, email: address, liftedAt: null },
        })
      )
        return null;
      const existing = await db.applicationDraft.findFirst({
        where: { tenantId, candidateId: candidate.id, requisitionId: reqId },
      });
      if (
        existing?.submittedAt ||
        (existing?.source && !["PORTAL", "INDEED", "LINKEDIN"].includes(existing.source))
      )
        return null;
      if (existing) {
        // Mailbox recovery may rotate a link, but never overwrites someone else's saved answers.
        await db.applicationDraft.update({
          where: { id: existing.id },
          data: {
            tokenHash: hashDraftToken(token),
            expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
          },
        });
      } else
        await db.applicationDraft.create({
          data: {
            tenantId,
            candidateId: candidate.id,
            requisitionId: reqId,
            source: origin,
            payload,
            tokenHash: hashDraftToken(token),
            expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
          },
        });
      await queueMailboxMessage(db, {
        tenantId,
        candidate,
        email: address,
        token,
        tokenPurpose: "DRAFT",
        templateKey: "portal_draft_link",
        expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
      });
      return { firstName: candidate.firstName };
    },
    { tenantId },
  );
  return { saved: true };
}
export async function loadApplicationDraft({ tenantId, token } = {}) {
  const draft = await resolveDraft(prisma, { tenantId, token });
  if (!draft) return null;
  const job = await draftSourceJob(prisma, { tenantId, draft });
  if (!job) return null;
  return {
    requisitionId: draft.requisitionId,
    jobTitle: job.title,
    job,
    email: draft.candidate.email,
    payload: draft.payload,
    resumeUploaded: Boolean(draft.resumeMediaId),
    updatedAt: draft.updated_at.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
  };
}
export async function updateApplicationDraft({ tenantId, token, body, expectedUpdatedAt } = {}) {
  const payload = parseDraftPayload(body);
  return tenantTransaction(
    prisma,
    async (db) => {
      const draft = await resolveDraft(db, { tenantId, token, lock: true });
      if (!draft) throw bad();
      if (draft.updated_at.toISOString() !== expectedUpdatedAt)
        throw Object.assign(new Error("The draft changed. Reload it before saving."), {
          status: 412,
          code: "HR-4120",
        });
      const updated = await db.applicationDraft.update({
        where: { id: draft.id },
        data: {
          payload,
          expiresAt: ["REFERRAL", "AGENCY"].includes(draft.source)
            ? draft.expiresAt
            : new Date(Date.now() + DRAFT_TTL_MS),
        },
      });
      // Possession of the emailed draft proves this mailbox, and only this mailbox.
      await db.candidate.update({
        where: { id: draft.candidateId },
        data: { emailVerifiedAt: new Date() },
      });
      return { saved: true, updatedAt: updated.updated_at.toISOString() };
    },
    { tenantId },
  );
}
export async function submitApplicationDraft({ tenantId, token } = {}) {
  const draft = await resolveDraft(prisma, { tenantId, token });
  if (!draft) throw bad();
  return submitPublicApplication({
    tenantId,
    requisitionId: draft.requisitionId,
    draftToken: token,
  });
}
export const purgeDraftsForCandidate = (db, { tenantId, candidateId }) =>
  db.applicationDraft.deleteMany({
    where: { tenantId, candidateId: Number(candidateId) },
  });
export async function purgeExpiredDrafts({ now = new Date() } = {}) {
  const result = await prisma.applicationDraft.deleteMany({
    where: { expiresAt: { lte: now }, submittedAt: null },
  });
  return { purged: result.count };
}
