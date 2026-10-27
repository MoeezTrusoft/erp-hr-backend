import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { onboardingPortalAccess } from "../lib/onboardingPortalAccess.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
import { encryptString, decryptString } from "../lib/crypto.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
  createOnboardingDamClient,
  inspectOnboardingDocument,
  verifyOnboardingAsset,
  documentHash,
  documentFailure,
  ONBOARDING_DOCUMENT_LIMIT,
} from "../lib/onboardingDamClient.js";
const fail = (message, status = 422) => {
  throw documentFailure(message, status);
};
const decodeNote = (cipher) =>
  cipher == null ? null : JSON.parse(decryptString(cipher)).text;
const active = (e) =>
  e &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [e.status, e.employement_status].join(" "),
  );
export const documentTransaction = (tenantId, fn) =>
  tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      return fn(tx);
    },
    {
      tenantId,
      txOptions: { timeout: 30000, maxWait: 10000 },
    },
  );
export async function documentRun(
  tenantId,
  method,
  fn,
  { selfAllowed = true } = {},
) {
  const access = onboardingPortalAccess(method, { selfAllowed, tenantId });
  return documentTransaction(tenantId, async (tx) => {
    const who = await actor(tx, access.ctx);
    const hr =
      access.hr &&
      resolveRecruitmentScope({ ...access.ctx.user, employeeId: who.id })
        .level === "ORG";
    if (!hr && !selfAllowed) fail("HR document permission required", 403);
    return fn(tx, { ...access, hr, who });
  });
}
export async function documentChecklist(
  tx,
  env,
  id,
  { lock = false, write = false, ownOnly = false } = {},
) {
  if (id != null && (!Number.isSafeInteger(id) || id <= 0))
    fail("Onboarding checklist not found", 404);
  const where = {
    tenantId: env.tenantId,
    ...(!env.hr || ownOnly || id == null ? { employeeId: env.who.id } : {}),
    ...(id == null ? {} : { id }),
  };
  let c =
    id == null
      ? await tx.onboardingChecklist.findFirst({
          where: { ...where, status: { not: "COMPLETED" } },
          orderBy: [{ startDate: "desc" }, { id: "desc" }],
        })
      : null;
  c ||= await tx.onboardingChecklist.findFirst({
    where,
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });
  if (!c) fail("Onboarding checklist not found", 404);
  if (lock) {
    await tx.$queryRawUnsafe(
      'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      env.tenantId,
      c.id,
    );
    c = await tx.onboardingChecklist.findFirst({
      where: { ...where, id: c.id },
    });
  }
  if (!c) fail("Onboarding checklist not found", 404);
  const employee = await tx.employee.findFirst({
    where: { tenant_id: env.tenantId, id: c.employeeId },
  });
  if (!employee) fail("Onboarding checklist not found", 404);
  if (write && (!active(employee) || c.status === "COMPLETED"))
    fail("This onboarding checklist is closed", 409);
  return { ...c, employee };
}
export async function documentRecord(tx, env, id, options = {}) {
  if (!Number.isSafeInteger(id) || id <= 0)
    fail("Onboarding document not found", 404);
  const d = await tx.onboardingDocument.findFirst({
    where: { tenantId: env.tenantId, id },
  });
  if (!d) fail("Onboarding document not found", 404);
  const c = await documentChecklist(tx, env, d.checklistId, options);
  if (c.employeeId !== d.employeeId) fail("Onboarding document not found", 404);
  const evidence = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingDocumentEvidence" WHERE "tenantId"=$1::uuid AND "documentId"=$2',
      env.tenantId,
      id,
    )
  )[0];
  const signature = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingDocumentSignature" WHERE "tenantId"=$1::uuid AND "documentId"=$2',
      env.tenantId,
      id,
    )
  )[0];
  return { document: d, checklist: c, evidence, signature };
}
export async function documentEvent(
  tx,
  tenantId,
  c,
  documentId,
  action,
  actorId = null,
) {
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId,
    eventName: "hr.onboarding.document_changed.v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(c.id),
    ...(actorId ? { actorId: String(actorId), actorType: "user" } : {}),
    payload: {
      checklistId: String(c.id),
      employeeId: String(c.employeeId),
      documentId: String(documentId),
      action,
    },
  });
  if (!queued) fail("Document change could not be saved", 503);
}
const uploadView = (r) => ({
  uploadId: r.id,
  state: r.state,
  documentId: r.documentId,
  title: r.title,
  lastError: r.lastError,
  createdAt: r.createdAt,
});
const requiredText = (v, max, label) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail(label + " is required (up to " + max + " characters)");
  return v.trim();
};
function decode(input) {
  if (
    typeof input !== "string" ||
    input.length > Math.ceil(ONBOARDING_DOCUMENT_LIMIT / 3) * 4 ||
    !input.length ||
    input.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input)
  )
    fail("Choose a valid document of 5 MB or less");
  const bytes = Buffer.from(input, "base64");
  if (bytes.toString("base64") !== input) fail("Invalid document encoding");
  return bytes;
}
async function seedUpload(
  tx,
  env,
  c,
  input,
  bytes,
  { kind = "ORIGINAL", documentId = null } = {},
) {
  const title = requiredText(input.title, 200, "Document title"),
    mimeType = inspectOnboardingDocument(bytes, { signed: kind === "SIGNED" }),
    sha256 = documentHash(bytes);
  if (
    typeof input.requestKey !== "string" ||
    !/^[a-zA-Z0-9:_-]{16,120}$/.test(input.requestKey)
  )
    fail("A stable document request key is required");
  const category =
    input.category == null
      ? null
      : requiredText(input.category, 100, "Category");
  const requiresSign = input.requiresSign === true;
  if (requiresSign && (!env.hr || mimeType !== "application/pdf"))
    fail("Only HR may request a signature on a PDF", 403);
  if (input.requiresSign != null && typeof input.requiresSign !== "boolean")
    fail("Invalid signature requirement");
  await tx.$executeRawUnsafe(
    'INSERT INTO "OnboardingUpload" (id,"tenantId","checklistId","employeeId","createdById","requestKey",kind,title,category,"requiresSign",sha256,"mimeType","byteSize","documentId") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT ("tenantId","checklistId","requestKey") DO NOTHING',
    randomUUID(),
    env.tenantId,
    c.id,
    c.employeeId,
    env.who.id,
    input.requestKey,
    kind,
    title,
    category,
    requiresSign,
    sha256,
    mimeType,
    bytes.length,
    documentId,
  );
  const r = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingUpload" WHERE "tenantId"=$1::uuid AND "checklistId"=$2 AND "requestKey"=$3 FOR UPDATE',
      env.tenantId,
      c.id,
      input.requestKey,
    )
  )[0];
  if (
    r.sha256 !== sha256 ||
    r.mimeType !== mimeType ||
    r.byteSize !== bytes.length ||
    r.title !== title ||
    r.category !== category ||
    r.requiresSign !== requiresSign ||
    r.kind !== kind ||
    r.createdById !== env.who.id ||
    (kind === "SIGNED" && r.documentId !== documentId)
  )
    fail("This request key belongs to a different upload", 409);
  return r;
}
async function lockUpload(tx, tenantId, id) {
  const seed = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingUpload" WHERE "tenantId"=$1::uuid AND id=$2::uuid',
      tenantId,
      id,
    )
  )[0];
  if (!seed) fail("Document upload not found", 404);
  await tx.$queryRawUnsafe(
    'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
    tenantId,
    seed.checklistId,
  );
  return (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingUpload" WHERE "tenantId"=$1::uuid AND id=$2::uuid FOR UPDATE',
      tenantId,
      id,
    )
  )[0];
}
async function persistUpload(
  seed,
  bytes,
  damFactory = createOnboardingDamClient,
  now = new Date(),
) {
  const tid = seed.tenantId;
  const claim = await documentTransaction(tid, async (tx) => {
    const r = await lockUpload(tx, tid, seed.id);
    if (
      ["READY", "REJECTED"].includes(r.state) ||
      (r.leaseUntil && r.leaseUntil > now)
    )
      return { row: r };
    if (!r.mediaId && !bytes) return { row: r };
    const token = randomUUID();
    const rows = await tx.$queryRawUnsafe(
      'UPDATE "OnboardingUpload" SET state=$1,"leaseToken"=$2::uuid,"leaseUntil"=$3,"updatedAt"=$4 WHERE id=$5::uuid RETURNING *',
      r.mediaId ? "SCANNING" : "UPLOADING",
      token,
      new Date(+now + 600000),
      now,
      r.id,
    );
    return { row: rows[0], token };
  });
  if (!claim.token) return claim.row;
  const r = claim.row;
  try {
    const dam = damFactory({ tenantId: tid, checklistId: r.checklistId });
    let mediaId = r.mediaId;
    if (!mediaId) {
      mediaId = await dam.upload({
        bytes,
        mimeType: r.mimeType,
        externalId: "onboarding:" + tid + ":" + r.checklistId + ":" + r.id,
      });
      const saved = await documentTransaction(tid, async (tx) =>
        tx.$executeRawUnsafe(
          'UPDATE "OnboardingUpload" SET "mediaId"=$1,state=\'SCANNING\',"updatedAt"=$2 WHERE id=$3::uuid AND "leaseToken"=$4::uuid',
          mediaId,
          now,
          r.id,
          claim.token,
        ),
      );
      if (saved !== 1)
        fail("Upload is being reconciled; reload its status", 409);
    }
    const expected = { ...r, tenantId: tid, mediaId };
    const asset = verifyOnboardingAsset(await dam.metadata(mediaId), expected, {
      clean: false,
      now,
    });
    if (asset.assetScan.status !== "CLEAN") {
      return await documentTransaction(
        tid,
        async (tx) =>
          (
            await tx.$queryRawUnsafe(
              'UPDATE "OnboardingUpload" SET "leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=$1 WHERE id=$2::uuid AND "leaseToken"=$3::uuid RETURNING *',
              now,
              r.id,
              claim.token,
            )
          )[0] ?? r,
      );
    }
    return await documentTransaction(tid, async (tx) => {
      const fresh = await lockUpload(tx, tid, r.id);
      if (fresh.leaseToken !== claim.token) return fresh;
      const c = await tx.onboardingChecklist.findFirst({
        where: { tenantId: tid, id: r.checklistId },
      });
      const employee = await tx.employee.findFirst({
        where: { tenant_id: tid, id: r.employeeId },
      });
      if (
        !c ||
        c.employeeId !== r.employeeId ||
        (r.kind === "ORIGINAL" &&
          (!active(employee) || c.status === "COMPLETED"))
      )
        fail("This onboarding checklist is closed", 409);
      let documentId = fresh.documentId;
      if (r.kind === "ORIGINAL") {
        const d = await tx.onboardingDocument.create({
          data: {
            tenantId: tid,
            checklistId: c.id,
            employeeId: c.employeeId,
            title: r.title,
            category: r.category,
            requiresSign: r.requiresSign,
            mediaId,
          },
        });
        documentId = d.id;
        await tx.$executeRawUnsafe(
          'INSERT INTO "OnboardingDocumentEvidence" ("documentId","tenantId",sha256,"mimeType","byteSize") VALUES ($1,$2::uuid,$3,$4,$5)',
          d.id,
          tid,
          r.sha256,
          r.mimeType,
          r.byteSize,
        );
        await documentEvent(tx, tid, c, d.id, "UPLOADED", r.createdById);
      }
      return (
        await tx.$queryRawUnsafe(
          'UPDATE "OnboardingUpload" SET state=\'READY\',"documentId"=$1,"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=$2 WHERE id=$3::uuid RETURNING *',
          documentId,
          now,
          r.id,
        )
      )[0];
    });
  } catch (e) {
    await documentTransaction(tid, async (tx) =>
      tx.$executeRawUnsafe(
        'UPDATE "OnboardingUpload" SET state=CASE WHEN $1 THEN \'REJECTED\' ELSE CASE WHEN "mediaId" IS NULL THEN \'PENDING\' ELSE \'SCANNING\' END END,"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=$2,"updatedAt"=$3 WHERE id=$4::uuid AND "leaseToken"=$5::uuid',
        e.status === 422,
        e.status === 422 ? "SCAN_REJECTED" : "STORAGE_RETRY_PENDING",
        now,
        r.id,
        claim.token,
      ),
    );
    throw e;
  }
}
export async function uploadOnboardingDocument(
  input,
  tenantId,
  { damFactory = createOnboardingDamClient } = {},
) {
  const bytes = decode(input.contentBase64);
  inspectOnboardingDocument(bytes);
  const r = await documentRun(tenantId, "POST", async (tx, env) => {
    const c = await documentChecklist(tx, env, input.checklistId, {
      lock: true,
      write: true,
    });
    return seedUpload(tx, env, c, input, bytes);
  });
  return uploadView(await persistUpload(r, bytes, damFactory));
}
// Internal scheduler capability only; signed artifacts never create another original document.
export async function storeSignedOnboardingDocument(
  job,
  bytes,
  { damFactory = createOnboardingDamClient } = {},
) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  const r = await runWithRequestContext(
    { system: false, user: { tenantId: job.tenantId } },
    () =>
      documentTransaction(job.tenantId, async (tx) => {
        const d = await tx.onboardingDocument.findFirst({
          where: { tenantId: job.tenantId, id: job.documentId },
        });
        if (!d) fail("Onboarding document not found", 404);
        await tx.$queryRawUnsafe(
          'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
          job.tenantId,
          d.checklistId,
        );
        const current = (
          await tx.$queryRawUnsafe(
            'SELECT * FROM "OnboardingDocumentSignature" WHERE "tenantId"=$1::uuid AND id=$2::uuid',
            job.tenantId,
            job.id,
          )
        )[0];
        if (
          !current ||
          current.documentId !== d.id ||
          current.employeeId !== d.employeeId ||
          current.leaseToken !== job.leaseToken ||
          current.state === "CANCELLED"
        )
          fail("Signature request changed", 409);
        const c = await tx.onboardingChecklist.findFirst({
          where: { tenantId: job.tenantId, id: d.checklistId },
        });
        return seedUpload(
          tx,
          {
            tenantId: job.tenantId,
            who: { id: current.createdById },
            hr: true,
          },
          c,
          {
            title: ("Signed " + d.title).slice(0, 200),
            category: d.category,
            requestKey: "signed:" + job.id,
          },
          bytes,
          { kind: "SIGNED", documentId: d.id },
        );
      }),
  );
  return runWithRequestContext(
    { system: false, user: { tenantId: job.tenantId } },
    () => persistUpload(r, bytes, damFactory),
  );
}
export async function runOnboardingUploads({
  tenantId,
  limit = 50,
  now = new Date(),
  damFactory = createOnboardingDamClient,
} = {}) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  const rows = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      return tx.$queryRawUnsafe(
        'SELECT * FROM "OnboardingUpload" WHERE state=\'SCANNING\' AND ("leaseUntil" IS NULL OR "leaseUntil"<=$1) AND ($2::uuid IS NULL OR "tenantId"=$2::uuid) ORDER BY "updatedAt",id LIMIT $3',
        now,
        tenantId ?? null,
        Math.max(1, Math.min(100, limit)),
      );
    },
    { system: true },
  );
  const counts = { ready: 0, pending: 0, failed: 0 };
  for (const row of rows)
    await runWithRequestContext(
      { system: false, user: { tenantId: row.tenantId } },
      async () => {
        try {
          const result = await persistUpload(row, null, damFactory, now);
          counts[result.state === "READY" ? "ready" : "pending"]++;
        } catch {
          counts.failed++;
        }
      },
    );
  return counts;
}
export const listOnboardingDocuments = (input, tenantId) =>
  documentRun(tenantId, "GET", async (tx, env) => {
    const c = await documentChecklist(tx, env, input.checklistId);
    const docs = await tx.$queryRawUnsafe(
      'SELECT d.*,e.sha256,e."mimeType",e."byteSize",e.version,e."reviewState",e."reviewedAt",e."reviewNoteCipher",s.state AS "signatureState",s."signedAt" AS "verifiedSignedAt",s."signedMediaId" FROM onboarding_documents d LEFT JOIN "OnboardingDocumentEvidence" e ON e."documentId"=d.id AND e."tenantId"=d."tenantId" LEFT JOIN "OnboardingDocumentSignature" s ON s."documentId"=d.id AND s."tenantId"=d."tenantId" WHERE d."tenantId"=$1::uuid AND d."checklistId"=$2 AND d."employeeId"=$3 ORDER BY d.created_at DESC,d.id DESC',
      tenantId,
      c.id,
      c.employeeId,
    );
    const uploads = await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingUpload" WHERE "tenantId"=$1::uuid AND "checklistId"=$2 AND kind=\'ORIGINAL\' AND state<>\'READY\' ORDER BY "createdAt" DESC',
      tenantId,
      c.id,
    );
    const canWrite = c.status !== "COMPLETED" && active(c.employee);
    const canReview =
      env.hr &&
      onboardingPortalAccess("PUT", { selfAllowed: true, tenantId }).hr;
    return {
      checklistId: c.id,
      employeeId: c.employeeId,
      canUpload:
        canWrite &&
        (env.hr
          ? onboardingPortalAccess("POST", { selfAllowed: true, tenantId }).hr
          : true),
      canRequireSignature:
        canWrite &&
        env.hr &&
        onboardingPortalAccess("POST", { selfAllowed: true, tenantId }).hr,
      canRequestSignature:
        canWrite &&
        canReview &&
        isRecruitmentFlagEnabled("onboarding") &&
        isRecruitmentFlagEnabled("esignature"),
      recipientEmail: canReview
        ? String(c.employee.work_email || c.employee.email || "").trim() || null
        : null,
      documents: docs.map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        requiresSign: d.requiresSign,
        createdAt: d.created_at,
        version: d.version ?? null,
        reviewState: d.reviewState ?? "LEGACY",
        reviewedAt: d.reviewedAt ?? null,
        reviewNote: d.reviewNoteCipher ? decodeNote(d.reviewNoteCipher) : null,
        mimeType: d.mimeType ?? null,
        byteSize: d.byteSize ?? null,
        signatureState: d.signatureState ?? null,
        signedAt: d.verifiedSignedAt ?? null,
        canDownload: !!d.sha256,
        canDownloadSigned: d.signatureState === "SIGNED" && !!d.signedMediaId,
        canReview:
          canWrite &&
          canReview &&
          !!d.sha256 &&
          (!d.signatureState ||
            (d.signatureState === "CANCELLED" && d.requiresSign)),
        canCancel:
          canReview &&
          !!d.signatureState &&
          !["SIGNED", "CANCELLED", "CANCEL_PENDING"].includes(d.signatureState),
        canSign: env.who.id === c.employeeId && d.signatureState === "AWAITING",
      })),
      uploads: uploads.map((r) => {
        const canRetry =
          canWrite &&
          r.createdById === env.who.id &&
          ["PENDING", "UPLOADING"].includes(r.state) &&
          (!r.leaseUntil || r.leaseUntil <= new Date());
        return {
          ...uploadView(r),
          category: r.category,
          requiresSign: r.requiresSign,
          canRetry,
          requestKey: canRetry ? r.requestKey : null,
        };
      }),
    };
  });
export async function downloadOnboardingDocument(
  input,
  tenantId,
  { damFactory = createOnboardingDamClient } = {},
) {
  const record = await documentRun(tenantId, "GET", (tx, env) =>
    documentRecord(tx, env, input.documentId),
  );
  return downloadDocumentRecord(
    record,
    tenantId,
    input.signed === true,
    damFactory,
  );
}
export async function downloadDocumentRecord(
  record,
  tenantId,
  signed = false,
  damFactory = createOnboardingDamClient,
) {
  const { document: d, evidence: e, signature: s } = record;
  if (!e)
    fail(
      "This legacy document must be uploaded through the private document flow",
      409,
    );
  if (signed && s?.state !== "SIGNED")
    fail("Verified signed document is not ready", 409);
  let expected = {
    tenantId,
    checklistId: d.checklistId,
    mediaId: d.mediaId,
    sha256: e.sha256,
    mimeType: e.mimeType,
    byteSize: e.byteSize,
  };
  if (signed) {
    const stored = await documentTransaction(
      tenantId,
      async (tx) =>
        (
          await tx.$queryRawUnsafe(
            'SELECT * FROM "OnboardingUpload" WHERE "tenantId"=$1::uuid AND "documentId"=$2 AND kind=\'SIGNED\' AND state=\'READY\'',
            tenantId,
            d.id,
          )
        )[0],
    );
    if (
      !stored ||
      stored.mediaId !== s.signedMediaId ||
      stored.sha256 !== s.signedSha256
    )
      fail("Signed document evidence does not match", 409);
    expected = {
      ...expected,
      mediaId: stored.mediaId,
      sha256: stored.sha256,
      mimeType: stored.mimeType,
      byteSize: stored.byteSize,
    };
  }
  const dam = damFactory({ tenantId, checklistId: d.checklistId });
  verifyOnboardingAsset(await dam.metadata(expected.mediaId), expected);
  const bytes = await dam.download(expected.mediaId, {
    sha256: expected.sha256,
    mimeType: expected.mimeType,
    signed,
  });
  return {
    contentBase64: bytes.toString("base64"),
    mimeType: expected.mimeType,
    fileName:
      (signed ? "signed-onboarding" : "onboarding") +
      (expected.mimeType === "application/pdf" ? ".pdf" : ".docx"),
  };
}
export async function reviewOnboardingDocument(
  input,
  tenantId,
  { damFactory = createOnboardingDamClient } = {},
) {
  if (
    !["VERIFIED", "REJECTED"].includes(input.reviewState) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    fail("Use the current document version and a review decision");
  const note =
    input.note == null ? null : requiredText(input.note, 2000, "Review note");
  if (input.reviewState === "REJECTED" && !note)
    fail("Explain why the document was rejected");
  const checked = await documentRun(
    tenantId,
    "PUT",
    (tx, env) => documentRecord(tx, env, input.documentId, { write: true }),
    { selfAllowed: false },
  );
  if (!checked.evidence)
    fail("Upload the document through the private document flow", 409);
  // Review cannot approve an unscanned or replaced original, even with a guessed media identity.
  await downloadDocumentRecord(checked, tenantId, false, damFactory);
  return documentRun(
    tenantId,
    "PUT",
    async (tx, env) => {
      const {
        document: d,
        evidence: e,
        signature: s,
        checklist: c,
      } = await documentRecord(tx, env, input.documentId, {
        lock: true,
        write: true,
      });
      if (s && (s.state !== "CANCELLED" || input.reviewState !== "REJECTED"))
        fail(
          "A signature request already freezes this document review; only a cancelled document can be withdrawn with a rejection reason",
          409,
        );
      if (
        e.reviewState === input.reviewState &&
        e.reviewedById === env.who.id &&
        decodeNote(e.reviewNoteCipher) === note
      )
        return {
          documentId: d.id,
          version: e.version,
          reviewState: e.reviewState,
        };
      if (e.version !== input.expectedVersion)
        fail("Document changed; reload before reviewing", 412);
      const saved = (
        await tx.$queryRawUnsafe(
          'UPDATE "OnboardingDocumentEvidence" SET "reviewState"=$1,"reviewedAt"=now(),"reviewedById"=$2,"reviewNoteCipher"=$3,version=version+1 WHERE "tenantId"=$4::uuid AND "documentId"=$5 RETURNING version,"reviewState"',
          input.reviewState,
          env.who.id,
          note ? encryptString(JSON.stringify({ text: note })) : null,
          tenantId,
          d.id,
        )
      )[0];
      if (s?.state === "CANCELLED")
        await tx.onboardingDocument.update({
          where: { id: d.id },
          data: { requiresSign: false },
        });
      await documentEvent(tx, tenantId, c, d.id, "REVIEWED", env.who.id);
      return { documentId: d.id, ...saved };
    },
    { selfAllowed: false },
  );
}

// Compatibility admission accepts only assets already protected by this checklist.
export async function attachPrivateOnboardingDocument(
  input,
  tenantId,
  { damFactory = createOnboardingDamClient } = {},
) {
  const c = await documentRun(
    tenantId,
    "POST",
    async (tx, env) => {
      const c = await documentChecklist(tx, env, Number(input.checklistId), {
        write: true,
      });
      if (Number(input.employeeId) !== c.employeeId)
        fail("Document employee does not match the checklist", 404);
      return c;
    },
    { selfAllowed: false },
  );
  const mediaId = Number(input.mediaId);
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0)
    fail("Invalid document identity");
  const dam = damFactory({ tenantId, checklistId: c.id }),
    asset = await dam.metadata(mediaId);
  const expected = {
    tenantId,
    checklistId: c.id,
    mediaId,
    sha256: asset?.sha256,
    mimeType: asset?.mimeType,
    byteSize: Number(asset?.size),
  };
  verifyOnboardingAsset(asset, expected);
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256 || "") ||
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize <= 0 ||
    expected.byteSize > ONBOARDING_DOCUMENT_LIMIT
  )
    fail("Invalid document evidence");
  const bytes = await dam.download(mediaId, expected);
  return uploadOnboardingDocument(
    {
      ...input,
      checklistId: c.id,
      requestKey: "attached:" + mediaId + ":" + expected.sha256,
      contentBase64: bytes.toString("base64"),
    },
    tenantId,
    { damFactory },
  );
}
export async function requireOnboardingSignatures(tx, tenantId, checklistId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT d.id FROM onboarding_documents d LEFT JOIN "OnboardingDocumentEvidence" e ON e."documentId"=d.id AND e."tenantId"=d."tenantId" LEFT JOIN "OnboardingDocumentSignature" s ON s."documentId"=d.id AND s."tenantId"=d."tenantId" LEFT JOIN "OnboardingUpload" u ON u."documentId"=d.id AND u."tenantId"=d."tenantId" AND u.kind=\'SIGNED\' WHERE d."tenantId"=$1::uuid AND d."checklistId"=$2 AND d."requiresSign"=true AND (s.state IS DISTINCT FROM \'SIGNED\' OR e."reviewState" IS DISTINCT FROM \'VERIFIED\' OR s."documentVersion" IS DISTINCT FROM e.version OR s."originalMediaId" IS DISTINCT FROM d."mediaId" OR s.sha256 IS DISTINCT FROM e.sha256 OR u.state IS DISTINCT FROM \'READY\' OR u."mediaId" IS DISTINCT FROM s."signedMediaId" OR u.sha256 IS DISTINCT FROM s."signedSha256") LIMIT 1',
    tenantId,
    checklistId,
  );
  if (rows.length)
    fail("Verify required document signatures before closing onboarding", 409);
}
