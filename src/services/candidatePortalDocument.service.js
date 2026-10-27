import { createHash } from "node:crypto";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolveDraft } from "./applicationDraft.service.js";
import {
  uploadFileToDAM,
  normalizeDamAssetResponse,
} from "./dam.media.service.js";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status, code: "HR-5804" });
const Input = z
  .object({
    fileName: z.string().min(1).max(150),
    fileBase64: z
      .string()
      .min(4)
      .max(6990508)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict();
export function validatePortalResume(input) {
  const parsed = Input.parse(input),
    buffer = Buffer.from(parsed.fileBase64, "base64");
  if (buffer.length > 5 * 1024 * 1024 || !buffer.length)
    throw fail("Choose a resume of 5 MB or less.");
  const pdf =
    /\.pdf$/i.test(parsed.fileName) &&
    buffer.subarray(0, 5).toString() === "%PDF-";
  const docx =
    /\.docx$/i.test(parsed.fileName) &&
    buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
    buffer.includes(Buffer.from("[Content_Types].xml")) &&
    buffer.includes(Buffer.from("word/document.xml"));
  if (!pdf && !docx) throw fail("Choose a valid PDF or Word (.docx) document.");
  return {
    expectedUpdatedAt: parsed.expectedUpdatedAt,
    hash: createHash("sha256").update(buffer).digest("hex"),
    file: {
      buffer,
      originalname: pdf ? "resume.pdf" : "resume.docx",
      mimetype: pdf
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  };
}
export async function uploadDraftResume(
  { tenantId, token, body },
  options = {},
) {
  const { file, hash, expectedUpdatedAt } = validatePortalResume(body);
  const prepared = await tenantTransaction(
    prisma,
    async (db) => {
      const draft = await resolveDraft(db, { tenantId, token, lock: true });
      if (!draft) throw fail("This draft link is not valid.", 404);
      if (draft.updated_at.toISOString() !== expectedUpdatedAt)
        throw fail("The draft changed. Reload it before uploading.", 412);
      const existing = await db.candidateDocumentUpload.findUnique({
        where: {
          tenantId_candidateId_contentHash: {
            tenantId,
            candidateId: draft.candidateId,
            contentHash: hash,
          },
        },
      });
      if (existing && ["DELETE_PENDING", "DELETED"].includes(existing.status))
        throw fail("This document is no longer available.", 409);
      const ledger =
        existing ??
        (await db.candidateDocumentUpload.create({
          data: {
            tenantId,
            candidateId: draft.candidateId,
            draftId: draft.id,
            contentHash: hash,
          },
        }));
      return { draft, ledger };
    },
    { tenantId },
  );
  let mediaId = prepared.ledger.mediaId;
  if (!mediaId) {
    const uploaded = await (options.upload ?? uploadFileToDAM)(
      file,
      "document",
      {
        externalId: "recruitment-resume:" + tenantId + ":" + prepared.ledger.id,
      },
    );
    const asset = normalizeDamAssetResponse(uploaded);
    mediaId = Number(asset?.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      await prisma.candidateDocumentUpload.update({
        where: { id: prepared.ledger.id },
        data: { status: "FAILED", lastError: "DAM upload unavailable" },
      });
      throw fail(
        "Resume upload is temporarily unavailable. Please try again.",
        503,
      );
    }
    // Keep the durable pointer even if the draft expires while DAM is uploading.
    await tenantTransaction(prisma, async db => {
      await db.$executeRaw`SELECT id FROM "Candidate" WHERE id=${prepared.draft.candidateId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      const candidate = await db.candidate.findUnique({where:{id:prepared.draft.candidateId}});
      const erased = !!candidate?.anonymizedAt;
      await db.candidateDocumentUpload.update({where:{id:prepared.ledger.id},data:{mediaId,status:erased?"DELETE_PENDING":"READY",lastError:null}});
      if(erased){
        const log = await db.candidateAnonymizationLog.findFirst({where:{tenantId,candidateId:prepared.draft.candidateId},orderBy:{id:"desc"}});
        if(!log)throw fail("Document ownership changed. Please contact recruitment.",409);
        await db.$executeRaw`SELECT id FROM candidate_anonymization_logs WHERE id=${log.id} FOR UPDATE`;
        const current = await db.candidateAnonymizationLog.findUnique({where:{id:log.id}});
        await db.candidateAnonymizationLog.update({where:{id:log.id},data:{damCleanup:{...current.damCleanup,state:"PENDING",requested:[...new Set([...(current.damCleanup?.requested??[]),String(mediaId)])]}}});
      }
    },{tenantId});
  }
  return tenantTransaction(
    prisma,
    async (db) => {
      const draft = await resolveDraft(db, { tenantId, token, lock: true });
      if (!draft || draft.id !== prepared.draft.id)
        throw fail("This draft link is not valid.", 404);
      if (draft.updated_at.toISOString() !== expectedUpdatedAt)
        throw fail("The draft changed. Reload it before uploading.", 412);
      const updated = await db.applicationDraft.update({
        where: { id: draft.id },
        data: { resumeMediaId: mediaId },
      });
      return {
        resumeUploaded: true,
        updatedAt: updated.updated_at.toISOString(),
      };
    },
    { tenantId },
  );
}
