import { renderOfferLetter, offerLetterError } from "../lib/offerLetterPdf.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readRecruitmentSettings } from "./recruitmentSettings.service.js";
import { downloadRecruitmentPdf } from "../lib/recruitmentDamPdf.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import {
  uploadFileToDAM,
  normalizeDamAssetResponse,
} from "./dam.media.service.js";

export { renderOfferLetter, offerLetterError } from "../lib/offerLetterPdf.js";
export async function offerLetterAccess(db, tenantId, method = "POST") {
  const ctx = getCtx();
  if (!ctx.actorVerified || ctx.user?.tenantId !== tenantId)
    throw offerLetterError("Verified employee and company required", 401);
  assertPermission(ctx.permissions, method, "hr:recruitment", false);
  assertPermission(ctx.permissions, "GET", "hr:payroll", false);
  const who = await actor(db, ctx);
  const scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
  if (!(method === "GET" ? ["ORG", "FINANCE"] : ["ORG"]).includes(scope.level))
    throw offerLetterError("Offer document access is not permitted", 403);
  return who;
}

async function lockCandidateOffer(db, tenantId, offerId, candidateId) {
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    candidateId,
    tenantId,
  );
  await db.$queryRawUnsafe(
    'SELECT id FROM offers WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    offerId,
    tenantId,
  );
  return db.offer.findFirst({
    where: { id: offerId, tenantId },
    include: {
      candidate: true,
      jobRequisition: { include: { position: true } },
    },
  });
}

/** A durable upload reservation is also discovered by candidate erasure. */
export async function persistOfferPdf({
  tenantId,
  candidateId,
  bytes,
  purpose,
  upload = uploadFileToDAM,
}) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const ledger = await tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        candidateId,
        tenantId,
      );
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      const current = await db.candidateDocumentUpload.findUnique({
        where: {
          tenantId_candidateId_contentHash: {
            tenantId,
            candidateId,
            contentHash: hash,
          },
        },
      });
      if (current && ["DELETE_PENDING", "DELETED"].includes(current.status))
        throw offerLetterError("Candidate document is no longer available");
      return (
        current ??
        db.candidateDocumentUpload.create({
          data: { tenantId, candidateId, contentHash: hash, purpose },
        })
      );
    },
    { tenantId },
  );
  let mediaId = ledger.mediaId;
  if (!mediaId) {
    const result = await upload(
      { buffer: bytes, originalname: "offer.pdf", mimetype: "application/pdf" },
      "document",
      { externalId: "recruitment-offer:" + tenantId + ":" + ledger.id },
    );
    mediaId = Number(normalizeDamAssetResponse(result)?.id);
    if (!Number.isSafeInteger(mediaId) || mediaId < 1)
      throw offerLetterError("Offer PDF storage is unavailable", 503);
    const erased = await tenantTransaction(
      prisma,
      async (db) => {
        await db.$queryRawUnsafe(
          'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
          candidateId,
          tenantId,
        );
        const candidate = await db.candidate.findFirst({
          where: { id: candidateId, tenantId },
        });
        const unavailable = !candidate || !!candidate.anonymizedAt;
        await db.candidateDocumentUpload.update({
          where: { id: ledger.id },
          data: { mediaId, status: unavailable ? "DELETE_PENDING" : "READY" },
        });
        if (unavailable) {
          const log = await db.candidateAnonymizationLog.findFirst({
            where: { tenantId, candidateId },
            orderBy: { id: "desc" },
          });
          if (!log)
            throw offerLetterError("Candidate cleanup record is unavailable");
          await db.$queryRawUnsafe(
            "SELECT id FROM candidate_anonymization_logs WHERE id=$1 FOR UPDATE",
            log.id,
          );
          const fresh = await db.candidateAnonymizationLog.findUnique({
            where: { id: log.id },
          });
          await db.candidateAnonymizationLog.update({
            where: { id: log.id },
            data: {
              damCleanup: {
                ...fresh.damCleanup,
                state: "PENDING",
                requested: [
                  ...new Set([
                    ...(fresh.damCleanup?.requested ?? []),
                    String(mediaId),
                  ]),
                ],
              },
            },
          });
        }
        return unavailable;
      },
      { tenantId },
    );
    if (erased) throw offerLetterError("Candidate is no longer available");
  }
  return { mediaId, sha256: hash };
}

export async function createOfferLetter(
  input,
  { upload = uploadFileToDAM, file } = {},
) {
  const ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  const parsed = z
    .object({
      offerId: z.coerce.number().int().positive(),
      expectedVersion: z.number().int().nonnegative(),
      employerName: z.string().trim().min(2).max(200).optional(),
    })
    .strict()
    .parse(input);
  const prepared = await tenantTransaction(
    prisma,
    async (db) => {
      const who = await offerLetterAccess(db, tenantId);
      const prior = await db.offer.findFirst({
        where: { id: parsed.offerId, tenantId },
      });
      if (!prior) throw offerLetterError("Offer not found", 404);
      const offer = await lockCandidateOffer(
        db,
        tenantId,
        prior.id,
        prior.candidateId,
      );
      if (offer.status !== "DRAFT")
        throw offerLetterError("Only a draft offer can receive a new letter");
      if (offer.version !== parsed.expectedVersion)
        throw offerLetterError(
          "Offer changed; reload before generating the letter",
          412,
        );
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: offer.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      const rows = await db.$queryRawUnsafe(
        'SELECT COALESCE(MAX(version),0)::integer AS version FROM offer_letter_versions WHERE "tenantId"=$1::uuid AND "offerId"=$2',
        tenantId,
        offer.id,
      );
      const settings = await readRecruitmentSettings(db, tenantId);
      return {
        offer,
        who,
        version: rows[0].version + 1,
        template: file ? null : settings.policy.offerLetterTemplate,
        templateVersion:
          !file && settings.policy.offerLetterTemplate
            ? settings.version
            : null,
      };
    },
    { tenantId },
  );
  let bytes = file?.buffer;
  if (
    file &&
    (!Buffer.isBuffer(bytes) ||
      bytes.length > 16 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString() !== "%PDF-")
  )
    throw offerLetterError("Choose a PDF of 16 MB or less", 422);
  if (!bytes) {
    if (
      prepared.template &&
      parsed.employerName &&
      parsed.employerName !== prepared.template.employerName
    )
      throw offerLetterError(
        "The employer name is set by this company's offer-letter template",
        422,
      );
    if (!parsed.employerName && !prepared.template)
      throw offerLetterError(
        "Employer name is required for the offer letter",
        422,
      );
    bytes = await renderOfferLetter({
      offer: prepared.offer,
      candidate: prepared.offer.candidate,
      requisition: prepared.offer.jobRequisition,
      employerName: parsed.employerName,
      version: prepared.version,
      template: prepared.template,
    });
  }
  const stored = await persistOfferPdf({
    tenantId,
    candidateId: prepared.offer.candidateId,
    bytes,
    purpose: "OFFER_LETTER",
    upload,
  });
  return tenantTransaction(
    prisma,
    async (db) => {
      await offerLetterAccess(db, tenantId);
      const current = await lockCandidateOffer(
        db,
        tenantId,
        prepared.offer.id,
        prepared.offer.candidateId,
      );
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: current.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      if (
        current.status !== "DRAFT" ||
        current.version !== parsed.expectedVersion
      )
        throw offerLetterError(
          "Offer changed; reload before attaching the letter",
          412,
        );
      const id = randomUUID();
      await db.$executeRawUnsafe(
        'INSERT INTO offer_letter_versions (id,"tenantId","offerId","candidateId",version,"offerRevision","mediaId",sha256,"createdById","templateVersion") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10)',
        id,
        tenantId,
        current.id,
        current.candidateId,
        prepared.version,
        current.version + 1,
        stored.mediaId,
        stored.sha256,
        prepared.who.id,
        prepared.templateVersion,
      );
      const offer = await db.offer.update({
        where: { id: current.id },
        data: {
          offerLetterMediaId: stored.mediaId,
          version: { increment: 1 },
          approvalStatus: "PENDING",
        },
      });
      await db.log.create({
        data: {
          tenantId,
          employeeId: prepared.who.id,
          actionById: prepared.who.id,
          type: "OFFER_LETTER_CREATED",
          action_type: "CREATE",
          ip: ctx.ip ?? "unknown",
          os: ctx.userAgent ?? "unknown",
          correlationId: ctx.correlationId ?? null,
          module: "Recruitment",
          result: "SUCCESS",
          notes: JSON.stringify({
            offerId: current.id,
            letterId: id,
            version: prepared.version,
            sha256: stored.sha256,
            templateVersion: prepared.templateVersion,
          }),
        },
      });
      return {
        id,
        version: prepared.version,
        offerVersion: offer.version,
        mediaId: stored.mediaId,
        sha256: stored.sha256,
        templateVersion: prepared.templateVersion,
      };
    },
    { tenantId },
  );
}

export async function listOfferLetters({ offerId }) {
  const ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  return tenantTransaction(
    prisma,
    async (db) => {
      await offerLetterAccess(db, tenantId, "GET");
      const id = z.coerce.number().int().positive().parse(offerId);
      const offer = await db.offer.findFirst({ where: { id, tenantId } });
      if (!offer) throw offerLetterError("Offer not found", 404);
      return {
        items: await db.$queryRawUnsafe(
          'SELECT id,version,"offerRevision","mediaId",sha256,"createdById","createdAt","templateVersion" FROM offer_letter_versions WHERE "tenantId"=$1::uuid AND "offerId"=$2 ORDER BY version DESC LIMIT 100',
          tenantId,
          id,
        ),
      };
    },
    { tenantId },
  );
}

/** Return document bytes only after the staff and tenant document checks. */
export async function downloadOfferLetter(
  input,
  { download = downloadRecruitmentPdf } = {},
) {
  const {
    offerId,
    letterId,
    signed = false,
  } = z
    .object({
      offerId: z.coerce.number().int().positive(),
      letterId: z.uuid(),
      signed: z.boolean().optional(),
    })
    .strict()
    .parse(input);
  const tenantId = getCtx().user?.tenantId;
  const access = () =>
    tenantTransaction(
      prisma,
      async (db) => {
        await offerLetterAccess(db, tenantId, "GET");
        const rows = await db.$queryRawUnsafe(
          'SELECT l.*,s."signedMediaId",s."signedSha256" FROM offer_letter_versions l LEFT JOIN offer_signature_requests s ON s."letterId"=l.id AND s."tenantId"=l."tenantId" WHERE l.id=$1::uuid AND l."tenantId"=$2::uuid AND l."offerId"=$3',
          letterId,
          tenantId,
          offerId,
        );
        const row = rows[0];
        if (!row || !(signed ? row.signedMediaId : row.mediaId))
          throw offerLetterError("Offer document not found", 404);
        await assertCommunicationsAllowed(
          {
            tenantId,
            candidateId: row.candidateId,
            purpose: "PROCESSING",
            requireExplicitConsent: true,
          },
          { db },
        );
        return {
          mediaId: signed ? row.signedMediaId : row.mediaId,
          sha256: signed ? row.signedSha256 : row.sha256,
          version: row.version,
        };
      },
      { tenantId },
    );
  const record = await access();
  const bytes = await download(tenantId, record.mediaId);
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
    throw offerLetterError("Offer document checksum does not match", 502);
  const current = await access();
  if (current.mediaId !== record.mediaId || current.sha256 !== record.sha256)
    throw offerLetterError("Offer document changed during download", 409);
  return {
    fileName:
      "offer-" +
      offerId +
      "-v" +
      record.version +
      (signed ? "-signed" : "") +
      ".pdf",
    contentType: "application/pdf",
    sha256: record.sha256,
    base64: bytes.toString("base64"),
  };
}
