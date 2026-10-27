import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { encryptString, decryptString } from "../lib/crypto.js";
import { configuredLibreSign } from "../lib/libresignClient.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  documentFailure,
  createOnboardingDamClient,
} from "../lib/onboardingDamClient.js";
import {
  documentRun,
  documentRecord,
  documentEvent,
  documentTransaction,
  downloadDocumentRecord,
  storeSignedOnboardingDocument,
} from "./onboardingDocuments.service.js";
const fail = (message, status = 409) => {
  throw documentFailure(message, status);
};
const active = (e) =>
  e &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [e.status, e.employement_status].join(" "),
  );
const address = (e) =>
  String(e.work_email || e.email || "")
    .trim()
    .toLowerCase();
const view = (r) => ({
  id: r.id,
  documentId: r.documentId,
  state: r.state,
  signedAt: r.signedAt,
  lastError: r.lastError,
});
const enabled = () =>
  isRecruitmentFlagEnabled("onboarding") &&
  isRecruitmentFlagEnabled("esignature");
const getJob = async (tx, tid, id) =>
  (
    await tx.$queryRawUnsafe(
      'SELECT s.*,d."checklistId",d.title FROM "OnboardingDocumentSignature" s JOIN onboarding_documents d ON d."tenantId"=s."tenantId" AND d.id=s."documentId" WHERE s."tenantId"=$1::uuid AND s.id=$2::uuid',
      tid,
      id,
    )
  )[0];
async function lockedJob(tx, tid, id) {
  const seed = await getJob(tx, tid, id);
  if (!seed) return null;
  await tx.$queryRawUnsafe(
    'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
    tid,
    seed.checklistId,
  );
  return getJob(tx, tid, id);
}
export async function requestOnboardingSignature(
  input,
  tenantId,
  { client = configuredLibreSign, damFactory = createOnboardingDamClient } = {},
) {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.recipientConfirmed !== true
  )
    fail(
      "Review the current document and explicitly confirm the employee mailbox",
      422,
    );
  const checked = await documentRun(
    tenantId,
    "PUT",
    (tx, env) => documentRecord(tx, env, input.documentId, { write: true }),
    { selfAllowed: false },
  );
  const validate = ({ document: d, evidence: e, checklist: c }) => {
    if (
      !d.requiresSign ||
      !e ||
      e.reviewState !== "VERIFIED" ||
      e.mimeType !== "application/pdf" ||
      e.version !== input.expectedVersion
    )
      fail("A verified PDF at the current review version is required", 412);
    const email = address(c.employee);
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof input.confirmedEmail !== "string" ||
      input.confirmedEmail.trim().toLowerCase() !== email
    )
      fail("Confirm the employee’s current email address before sending", 422);
    return email;
  };
  validate(checked);
  if (checked.signature) return view(checked.signature);
  if (!enabled()) fail("Company onboarding signatures are not enabled", 503);
  await client(tenantId); // Validate server-owned company configuration before committing a send request.
  await downloadDocumentRecord(checked, tenantId, false, damFactory);
  return documentRun(
    tenantId,
    "PUT",
    async (tx, env) => {
      const record = await documentRecord(tx, env, input.documentId, {
        lock: true,
        write: true,
      });
      const email = validate(record),
        {
          document: d,
          evidence: e,
          checklist: c,
          signature: existing,
        } = record;
      if (existing) return view(existing);
      if (!enabled())
        fail("Company onboarding signatures are not enabled", 503);
      const identity = encryptString(
        JSON.stringify({
          email,
          displayName:
            c.employee.employee_name ||
            [c.employee.first_name, c.employee.last_name]
              .filter(Boolean)
              .join(" ") ||
            "Employee",
          confirmedById: env.who.id,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const result = (
        await tx.$queryRawUnsafe(
          'INSERT INTO "OnboardingDocumentSignature" (id,"tenantId","documentId","employeeId","createdById","documentVersion","originalMediaId",sha256,"identityCipher") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          randomUUID(),
          tenantId,
          d.id,
          c.employeeId,
          env.who.id,
          e.version,
          d.mediaId,
          e.sha256,
          identity,
        )
      )[0];
      await documentEvent(
        tx,
        tenantId,
        c,
        d.id,
        "SIGNATURE_REQUESTED",
        env.who.id,
      );
      return view(result);
    },
    { selfAllowed: false },
  );
}
export const cancelOnboardingSignature = (input, tenantId) =>
  documentRun(
    tenantId,
    "PUT",
    async (tx, env) => {
      if (
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 2000
      )
        fail("Record a cancellation reason of 1–2000 characters", 422);
      const {
        document: d,
        signature: s,
        checklist: c,
      } = await documentRecord(tx, env, input.documentId, { lock: true });
      if (!s) fail("Signature request not found", 404);
      if (s.state === "SIGNED")
        fail("A completed signature cannot be cancelled");
      if (["CANCEL_PENDING", "CANCELLED"].includes(s.state)) return view(s);
      const r = (
        await tx.$queryRawUnsafe(
          'UPDATE "OnboardingDocumentSignature" SET state=\'CANCEL_PENDING\',"cancelReasonCipher"=$1,"signingUrlCipher"=NULL,"dueAt"=now(),"updatedAt"=now() WHERE "tenantId"=$2::uuid AND id=$3::uuid RETURNING *',
          encryptString(
            JSON.stringify({ text: input.reason.trim(), actorId: env.who.id }),
          ),
          tenantId,
          s.id,
        )
      )[0];
      await documentEvent(
        tx,
        tenantId,
        c,
        d.id,
        "SIGNATURE_CANCELLATION_REQUESTED",
        env.who.id,
      );
      return view(r);
    },
    { selfAllowed: false },
  );
export const openOnboardingSignature = (input, tenantId) =>
  documentRun(tenantId, "GET", async (tx, env) => {
    const { signature: s, checklist: c } = await documentRecord(
      tx,
      env,
      input.documentId,
      { ownOnly: true },
    );
    if (s?.state !== "AWAITING" || !s.signingUrlCipher)
      fail("The signing invitation is not ready");
    const identity = JSON.parse(decryptString(s.identityCipher));
    if (
      address(c.employee) !== identity.email.toLowerCase() ||
      !active(c.employee)
    )
      fail("Employee details changed; HR must review this invitation");
    const url = decryptString(s.signingUrlCipher),
      parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      fail("The signing link is not valid", 503);
    return { url };
  });
const OPEN = [
  "PREPARE",
  "CREATE",
  "CREATE_UNKNOWN",
  "AWAITING",
  "CANCEL_PENDING",
];
export async function runOnboardingSignatures({
  tenantId,
  now = new Date(),
  limit = 25,
  client = configuredLibreSign,
  damFactory = createOnboardingDamClient,
} = {}) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  const maySend = enabled();
  const rows = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      return tx.$queryRawUnsafe(
        'SELECT id,"tenantId" FROM "OnboardingDocumentSignature" WHERE state=ANY($1::text[]) AND "dueAt"<=$2 AND ("leaseUntil" IS NULL OR "leaseUntil"<=$2) AND ($3::uuid IS NULL OR "tenantId"=$3::uuid) ORDER BY "dueAt",id LIMIT $4',
        maySend ? OPEN : ["CANCEL_PENDING"],
        now,
        tenantId ?? null,
        Math.max(1, Math.min(100, limit)),
      );
    },
    { system: true },
  );
  const result = { processed: 0, retried: 0, signed: 0 };
  for (const seed of rows)
    await runWithRequestContext(
      { system: false, user: { tenantId: seed.tenantId } },
      async () => {
        const tid = seed.tenantId;
        const job = await documentTransaction(tid, async (tx) => {
          const fresh = await lockedJob(tx, tid, seed.id);
          if (
            !fresh ||
            !OPEN.includes(fresh.state) ||
            fresh.dueAt > now ||
            (fresh.leaseUntil && fresh.leaseUntil > now) ||
            (!maySend && fresh.state !== "CANCEL_PENDING")
          )
            return null;
          const employee = await tx.employee.findFirst({
              where: { tenant_id: tid, id: fresh.employeeId },
            }),
            identity = JSON.parse(decryptString(fresh.identityCipher));
          const c = await tx.onboardingChecklist.findFirst({
            where: { tenantId: tid, id: fresh.checklistId },
          });
          const state =
            !active(employee) ||
            !c ||
            c.employeeId !== fresh.employeeId ||
            c.status === "COMPLETED" ||
            address(employee) !== identity.email.toLowerCase()
              ? "CANCEL_PENDING"
              : fresh.state;
          const token = randomUUID();
          await tx.$executeRawUnsafe(
            'UPDATE "OnboardingDocumentSignature" SET state=$1,"leaseToken"=$2::uuid,"leaseUntil"=$3,attempts=attempts+1,"updatedAt"=$4 WHERE id=$5::uuid',
            state,
            token,
            new Date(+now + 600000),
            now,
            fresh.id,
          );
          return {
            ...fresh,
            state,
            leaseToken: token,
            attempts: fresh.attempts + 1,
          };
        });
        if (!job) return;
        let update = {},
          failure;
        try {
          const api = await client(tid),
            identity = JSON.parse(decryptString(job.identityCipher));
          const document = {
            kind: "onboarding",
            documentId: job.documentId,
            version: job.documentVersion,
            sha256: job.sha256,
          };
          const expected = {
            email: identity.email,
            displayName: identity.displayName,
            nodeId: job.nodeId,
            name:
              "onboarding-" +
              job.documentId +
              "-v" +
              job.documentVersion +
              "-" +
              job.sha256,
            fileId: job.providerFileId,
            fileUuid: job.providerFileUuid,
          };
          const retain = async (workflow) => {
            const signed = await api.downloadSigned({
              ...expected,
              fileId: workflow.fileId,
              fileUuid: workflow.fileUuid,
            });
            const stored = await runWithRequestContext({ system: true }, () =>
              storeSignedOnboardingDocument(job, signed.bytes, { damFactory }),
            );
            if (stored.state !== "READY")
              fail("Signed document scan is pending", 503);
            if (
              stored.sha256 !== signed.sha256 ||
              !signed.workflow?.signedAt ||
              !Number.isFinite(+new Date(signed.workflow.signedAt))
            )
              fail("Signed document evidence does not match");
            update = {
              ...update,
              state: "SIGNED",
              providerFileId: workflow.fileId,
              providerFileUuid: workflow.fileUuid,
              signingUrlCipher: null,
              signedMediaId: stored.mediaId,
              signedSha256: stored.sha256,
              signedAt: new Date(signed.workflow.signedAt),
            };
          };
          if (job.state === "PREPARE") {
            const record = await documentTransaction(tid, async (tx) => {
              const d = await tx.onboardingDocument.findFirst({
                where: { tenantId: tid, id: job.documentId },
              });
              const e = (
                await tx.$queryRawUnsafe(
                  'SELECT * FROM "OnboardingDocumentEvidence" WHERE "tenantId"=$1::uuid AND "documentId"=$2',
                  tid,
                  job.documentId,
                )
              )[0];
              if (
                !d ||
                d.mediaId !== job.originalMediaId ||
                !e ||
                e.version !== job.documentVersion ||
                e.sha256 !== job.sha256 ||
                e.reviewState !== "VERIFIED"
              )
                fail("Approved document evidence changed");
              return { document: d, evidence: e };
            });
            const original = await downloadDocumentRecord(
              record,
              tid,
              false,
              damFactory,
            );
            const prepared = await api.prepareDocument(
              document,
              Buffer.from(original.contentBase64, "base64"),
            );
            update = { state: "CREATE", nodeId: prepared.nodeId };
          } else if (job.state === "CANCEL_PENDING") {
            if (job.nodeId) {
              const current = await api.reconcile(expected);
              if (current?.status === 3) await retain(current);
              else {
                try {
                  await api.cancel(expected);
                  update = { state: "CANCELLED", signingUrlCipher: null };
                } catch (e) {
                  if (e.reason !== "FINALIZED") throw e;
                  const latest = await api.reconcile(expected);
                  if (latest?.status !== 3) throw e;
                  await retain(latest);
                }
              }
            } else update = { state: "CANCELLED", signingUrlCipher: null };
          } else {
            let workflow;
            if (job.state === "CREATE") {
              const proceed = await documentTransaction(tid, async (tx) => {
                await lockedJob(tx, tid, job.id);
                return tx.$executeRawUnsafe(
                  'UPDATE "OnboardingDocumentSignature" SET state=\'CREATE_UNKNOWN\',"updatedAt"=now() WHERE id=$1::uuid AND "leaseToken"=$2::uuid AND state=\'CREATE\'',
                  job.id,
                  job.leaseToken,
                );
              });
              if (proceed !== 1) return;
              workflow = await api.requestSignature(expected);
            } else workflow = await api.reconcile(expected);
            if (!workflow)
              fail("Signature request awaits provider reconciliation", 503);
            update = {
              providerFileId: workflow.fileId,
              providerFileUuid: workflow.fileUuid,
              state: workflow.declined ? "DECLINED" : "AWAITING",
              signingUrlCipher:
                workflow.signingUrl && !workflow.declined
                  ? encryptString(workflow.signingUrl)
                  : null,
            };
            if (workflow.status === 3) await retain(workflow);
            if (workflow.status === 4)
              update = {
                ...update,
                state: "CANCELLED",
                signingUrlCipher: null,
              };
          }
        } catch (e) {
          failure = e;
        }
        await documentTransaction(tid, async (tx) => {
          const fresh = await lockedJob(tx, tid, job.id);
          if (!fresh || fresh.leaseToken !== job.leaseToken) return;
          if (failure) {
            update.state =
              job.state === "CREATE" &&
              fresh.state === "CREATE_UNKNOWN" &&
              failure.reason === "PROVIDER_REJECTED" &&
              failure.uncertain === false
                ? "CREATE"
                : fresh.state;
            update.lastError =
              update.state === "CREATE_UNKNOWN"
                ? "PROVIDER_RECONCILIATION_REQUIRED"
                : "PROVIDER_RETRY_PENDING";
            result.retried++;
          } else update.lastError = null;
          if (
            fresh.state === "CANCEL_PENDING" &&
            job.state !== "CANCEL_PENDING" &&
            update.state !== "SIGNED"
          ) {
            update.state = "CANCEL_PENDING";
            update.signingUrlCipher = null;
          }
          const terminal = ["SIGNED", "CANCELLED", "DECLINED"].includes(
            update.state,
          );
          const delay = failure
            ? Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 6))
            : update.state === "AWAITING"
              ? 60000
              : 1000;
          const due = terminal
            ? new Date("9999-01-01T00:00:00Z")
            : new Date(+now + delay);
          const fields = [
            "state",
            "nodeId",
            "providerFileId",
            "providerFileUuid",
            "signingUrlCipher",
            "signedMediaId",
            "signedSha256",
            "signedAt",
            "lastError",
          ];
          const entries = fields.filter((k) => Object.hasOwn(update, k)),
            values = entries.map((k) => update[k]);
          const assignments = entries.map(
            (k, i) =>
              '"' +
              k +
              '"=$' +
              (i + 1) +
              (k === "providerFileUuid" ? "::uuid" : ""),
          );
          assignments.push(
            '"dueAt"=$' + values.push(due),
            '"leaseToken"=NULL',
            '"leaseUntil"=NULL',
            '"updatedAt"=now()',
          );
          await tx.$executeRawUnsafe(
            'UPDATE "OnboardingDocumentSignature" SET ' +
              assignments.join(",") +
              " WHERE id=$" +
              values.push(job.id) +
              "::uuid",
            ...values,
          );
          if (update.state === "SIGNED") {
            await tx.onboardingDocument.update({
              where: { id: job.documentId },
              data: {
                signedAt: update.signedAt,
                signedByEmpId: job.employeeId,
              },
            });
            result.signed++;
          }
          const action = {
            SIGNED: "SIGNED",
            AWAITING: "SIGNATURE_READY",
            CANCELLED: "SIGNATURE_CANCELLED",
            DECLINED: "SIGNATURE_DECLINED",
          }[update.state];
          if (action && fresh.state !== update.state)
            await documentEvent(
              tx,
              tid,
              { id: job.checklistId, employeeId: job.employeeId },
              job.documentId,
              action,
            );
          result.processed++;
        });
      },
    );
  return result;
}
