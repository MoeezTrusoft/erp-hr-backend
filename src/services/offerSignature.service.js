import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { encryptString, decryptString } from "../lib/crypto.js";
import { configuredLibreSign } from "../lib/libresignClient.js";
import { downloadRecruitmentPdf } from "../lib/recruitmentDamPdf.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { persistOfferPdf, offerLetterAccess } from "./offerLetter.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status, code: "HR-5510" });
const OPEN = [
  "PREPARE",
  "CREATE",
  "CREATE_UNKNOWN",
  "AWAITING",
  "SIGNED",
  "DECLINED",
  "CANCEL_PENDING",
  "ERASE_PENDING",
];
const CLEANUP = ["CANCEL_PENDING", "ERASE_PENDING"];
const LEASE_MS = 10 * 60000;
const transaction = (tenantId, fn) =>
  tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      return fn(db);
    },
    { tenantId },
  );
const lock = async (db, row) => {
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    row.candidateId,
    row.tenantId,
  );
  await db.$queryRawUnsafe(
    'SELECT id FROM offers WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    row.offerId,
    row.tenantId,
  );
};
const getJob = async (db, tenantId, offerId) =>
  (
    await db.$queryRawUnsafe(
      'SELECT s.*,l.version AS "letterVersion",l.sha256,l."mediaId" FROM offer_signature_requests s JOIN offer_letter_versions l ON l.id=s."letterId" WHERE s."tenantId"=$1::uuid AND s."offerId"=$2',
      tenantId,
      offerId,
    )
  )[0];

/** Joins the approved send transaction. No provider calls or raw candidate links in events. */
export async function queueOfferSignature(db, offer) {
  const { tenantId, candidateId } = offer;
  const candidate = await db.candidate.findFirst({
    where: { tenantId, id: candidateId, anonymizedAt: null, status: "active" },
  });
  if (!candidate?.emailVerifiedAt)
    throw fail("Verify the candidate email before requesting a signature", 422);
  await assertCommunicationsAllowed(
    {
      tenantId,
      candidateId,
      purpose: "PROCESSING",
      requireExplicitConsent: true,
    },
    { db },
  );
  const letter = (
    await db.$queryRawUnsafe(
      'SELECT * FROM offer_letter_versions WHERE "tenantId"=$1::uuid AND "offerId"=$2 ORDER BY version DESC LIMIT 1',
      tenantId,
      offer.id,
    )
  )[0];
  if (
    !letter?.mediaId ||
    letter.mediaId !== offer.offerLetterMediaId ||
    letter.offerRevision !== offer.version
  )
    throw fail(
      "Generate and approve a letter for the current offer before sending",
      422,
    );
  const identity = encryptString(
    JSON.stringify({
      email: candidate.email,
      displayName: [candidate.firstName, candidate.lastName]
        .filter(Boolean)
        .join(" "),
    }),
  );
  await db.$executeRawUnsafe(
    'INSERT INTO offer_signature_requests (id,"tenantId","offerId","candidateId","letterId","identityCipher") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6) ON CONFLICT ("tenantId","offerId") DO NOTHING',
    randomUUID(),
    tenantId,
    offer.id,
    candidateId,
    letter.id,
    identity,
  );
  const job = await getJob(db, tenantId, offer.id);
  if (job.letterId !== letter.id)
    throw fail("This offer already has a different signature request");
  return job.id;
}

/** Existing jobs remain authoritative even if an operator disables new signatures. */
export async function requireOfferSignature(db, offer) {
  const job = await getJob(db, offer.tenantId, offer.id);
  if (
    job &&
    (job.state !== "SIGNED" || !job.signedMediaId || !job.signedSha256)
  )
    throw fail("Complete the offer signature before accepting");
  return job;
}

export async function getOfferSignature({ offerId }) {
  const tenantId = currentRequestContext()?.user?.tenantId;
  return transaction(tenantId, async (db) => {
    await offerLetterAccess(db, tenantId, "GET");
    const offer = await db.offer.findFirst({
      where: { tenantId, id: Number(offerId) },
    });
    if (!offer) throw fail("Offer not found", 404);
    const job = await getJob(db, tenantId, offer.id);
    return job
      ? {
          id: job.id,
          state: job.state,
          letterId: job.letterId,
          signedMediaId: job.signedMediaId,
          signedAt: job.signedAt,
          lastError: job.lastError,
          attempts: job.attempts,
        }
      : null;
  });
}

/** A lease plus CREATE_UNKNOWN committed before POST gives at-most-once creation.
 * Recovery polls the stable node identity; it never blindly repeats an uncertain POST. */
export async function runOfferSignatures({
  now = new Date(),
  limit = 30,
  tenantId,
  client = configuredLibreSign,
  download = downloadRecruitmentPdf,
  storePdf = persistOfferPdf,
  accept,
} = {}) {
  if (!currentRequestContext()?.system)
    throw fail("Scheduler identity required", 403);
  const enabled = isRecruitmentFlagEnabled("esignature");
  const rows = await tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      return db.$queryRawUnsafe(
        'SELECT * FROM offer_signature_requests WHERE state=ANY($1::text[]) AND "dueAt"<=$2 AND ("leaseUntil" IS NULL OR "leaseUntil"<=$2) AND ($3::uuid IS NULL OR "tenantId"=$3::uuid) ORDER BY "dueAt",id LIMIT $4',
        enabled ? OPEN : CLEANUP,
        now.toISOString(),
        tenantId ?? null,
        Math.max(1, Math.min(100, limit)),
      );
    },
    { system: true },
  );
  const totals = { processed: 0, retried: 0, signed: 0, erased: 0 };
  for (const seed of rows)
    await runWithRequestContext(
      { system: false, user: { tenantId: seed.tenantId } },
      async () => {
        const tid = seed.tenantId;
        const job = await transaction(tid, async (db) => {
          await lock(db, seed);
          const fresh = await getJob(db, tid, seed.offerId);
          if (
            !OPEN.includes(fresh.state) ||
            fresh.dueAt > now ||
            (fresh.leaseUntil && fresh.leaseUntil > now)
          )
            return null;
          if (!enabled && !CLEANUP.includes(fresh.state)) return null;
          const offer = await db.offer.findFirst({
            where: { id: seed.offerId, tenantId: tid },
          });
          const candidate = await db.candidate.findFirst({
            where: { id: seed.candidateId, tenantId: tid },
          });
          let state = fresh.state;
          if (!candidate || candidate.anonymizedAt) state = "ERASE_PENDING";
          else if (
            !CLEANUP.includes(state) &&
            !["SIGNED", "DECLINED"].includes(state)
          ) {
            try {
              await assertCommunicationsAllowed(
                {
                  tenantId: tid,
                  candidateId: seed.candidateId,
                  purpose: "PROCESSING",
                  requireExplicitConsent: true,
                },
                { db },
              );
            } catch (error) {
              if (error.status >= 400 && error.status < 500)
                state = "CANCEL_PENDING";
              else throw error;
            }
            if (
              offer.status !== "SENT" ||
              (offer.expiryDate && offer.expiryDate <= now)
            )
              state = "CANCEL_PENDING";
          }
          if (
            state === "DECLINED" &&
            offer.status === "SENT" &&
            offer.expiryDate &&
            offer.expiryDate <= now
          )
            state = "CANCEL_PENDING";
          if (
            ["SIGNED", "DECLINED"].includes(state) &&
            offer.status !== "SENT"
          ) {
            await db.$executeRawUnsafe(
              'UPDATE offer_signature_requests SET "dueAt"=$1::timestamptz,"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$2::uuid',
              "9999-01-01T00:00:00Z",
              fresh.id,
            );
            return null;
          }
          const token = randomUUID();
          await db.$executeRawUnsafe(
            'UPDATE offer_signature_requests SET state=$1,"leaseToken"=$2::uuid,"leaseUntil"=$3,attempts=attempts+1,"updatedAt"=$4 WHERE id=$5::uuid',
            state,
            token,
            new Date(now.getTime() + LEASE_MS).toISOString(),
            now.toISOString(),
            fresh.id,
          );
          return {
            ...fresh,
            state,
            leaseToken: token,
            attempts: fresh.attempts + 1,
            offerStatus: offer.status,
            offerExpiryDate: offer.expiryDate,
          };
        });
        if (!job) return;
        let update = {},
          failure,
          accepted = false;
        try {
          const api = ["SIGNED", "DECLINED"].includes(job.state)
            ? null
            : await client(tid);
          const identity = job.identityCipher
            ? JSON.parse(decryptString(job.identityCipher))
            : {};
          const document = {
            offerId: job.offerId,
            version: job.letterVersion,
            sha256: job.sha256,
          };
          const expected = {
            ...identity,
            nodeId: job.nodeId,
            name:
              "offer-" +
              job.offerId +
              "-v" +
              job.letterVersion +
              "-" +
              job.sha256,
            fileId: job.providerFileId,
            fileUuid: job.providerFileUuid,
          };
          const retainSigned = async (workflow) => {
            const signed = await api.downloadSigned({
              ...expected,
              fileId: workflow.fileId,
              fileUuid: workflow.fileUuid,
            });
            const stored = await storePdf({
              tenantId: tid,
              candidateId: job.candidateId,
              bytes: signed.bytes,
              purpose: "SIGNED_OFFER",
            });
            if (stored.sha256 !== signed.sha256)
              throw fail("Signed document checksum does not match");
            update = {
              ...update,
              providerFileId: workflow.fileId,
              providerFileUuid: workflow.fileUuid,
              state: "SIGNED",
              signingUrlCipher: null,
              signedMediaId: stored.mediaId,
              signedSha256: signed.sha256,
              signedAt: new Date(signed.workflow.signedAt),
            };
          };
          if (job.state === "ERASE_PENDING") {
            await api.erase(expected, document);
            update = {
              state: "ERASED",
              identityCipher: null,
              signingUrlCipher: null,
              signedMediaId: null,
            };
          } else if (job.state === "CANCEL_PENDING") {
            // Expiry is finalized only after reconciling a potentially completed signature.
            // A user withdrawal still cancels the workflow regardless of its completion time.
            let timelySignature = null;
            if (
              job.nodeId &&
              job.offerStatus === "SENT" &&
              job.offerExpiryDate &&
              job.offerExpiryDate <= now
            ) {
              const current = await api.reconcile(expected);
              if (
                current?.status === 3 &&
                current.signedAt &&
                new Date(current.signedAt) <= job.offerExpiryDate
              )
                timelySignature = current;
            }
            if (timelySignature) await retainSigned(timelySignature);
            else {
              if (job.nodeId) {
                try {
                  await api.cancel(expected);
                } catch (e) {
                  if (e.reason !== "FINALIZED") throw e;
                }
              }
              update = { state: "CANCELLED", signingUrlCipher: null };
            }
          } else if (job.state === "PREPARE") {
            const bytes = await download(tid, job.mediaId);
            const uploaded = await api.prepareDocument(document, bytes);
            update = { state: "CREATE", nodeId: uploaded.nodeId };
          } else if (["SIGNED", "DECLINED"].includes(job.state)) {
            // Acceptance/handoff retries are separate from immutable signed-document storage.
            const perform =
              accept ?? (await import("./offer.service.js")).respondOffer;
            await perform(job.offerId, job.state === "SIGNED", tid, {
              signatureJobId: job.id,
            });
            accepted = true;
          } else {
            let workflow;
            if (job.state === "CREATE") {
              const proceed = await transaction(tid, async (db) => {
                await lock(db, job);
                const changed = await db.$executeRawUnsafe(
                  "UPDATE offer_signature_requests SET state='CREATE_UNKNOWN',\"updatedAt\"=now() WHERE id=$1::uuid AND \"leaseToken\"=$2::uuid AND state='CREATE'",
                  job.id,
                  job.leaseToken,
                );
                return changed === 1;
              });
              if (!proceed) return;
              workflow = await api.requestSignature(expected);
            } else workflow = await api.reconcile(expected);
            if (!workflow)
              throw fail(
                "Signature request awaits provider reconciliation",
                503,
              );
            update = {
              providerFileId: workflow.fileId,
              providerFileUuid: workflow.fileUuid,
              state: workflow.declined ? "DECLINED" : "AWAITING",
              signingUrlCipher:
                workflow.signingUrl && !workflow.declined
                  ? encryptString(workflow.signingUrl)
                  : null,
            };
            if (workflow.status === 3) {
              await retainSigned(workflow);
            }
            if (workflow.status === 4)
              update = {
                ...update,
                state: "CANCELLED",
                signingUrlCipher: null,
              };
          }
        } catch (error) {
          failure = error;
        }
        await transaction(tid, async (db) => {
          await lock(db, job);
          const fresh = await getJob(db, tid, job.offerId);
          if (fresh.leaseToken !== job.leaseToken) return;
          // Preserve privacy/cancellation requests that arrived during network I/O, while
          // retaining late provider ids so the next cleanup can remove those exact files.
          if (CLEANUP.includes(fresh.state) && fresh.state !== job.state) {
            update.state = fresh.state;
            update.signingUrlCipher = null;
          }
          if (failure) {
            // A confirmed HTTP rejection did not accept the create operation.
            // Keep ambiguous network/5xx/OCS outcomes in read-only reconciliation.
            const retryState =
              job.state === "CREATE" &&
              fresh.state === "CREATE_UNKNOWN" &&
              failure.reason === "PROVIDER_REJECTED" &&
              failure.uncertain === false
                ? "CREATE"
                : fresh.state;
            update = {
              ...update,
              state: retryState,
              lastError:
                retryState === "CREATE_UNKNOWN"
                  ? "PROVIDER_RECONCILIATION_REQUIRED"
                  : "PROVIDER_RETRY_PENDING",
            };
            totals.retried++;
          } else update.lastError = null;
          const delay = failure
            ? Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 6))
            : update.state === "AWAITING"
              ? 60000
              : 1000;
          const dueAt = accepted
            ? new Date("9999-01-01T00:00:00Z")
            : new Date(now.getTime() + delay);
          // Fixed allowlist: field names never come from request/provider input.
          const fields = [
            "state",
            "nodeId",
            "providerFileId",
            "providerFileUuid",
            "signingUrlCipher",
            "identityCipher",
            "signedMediaId",
            "signedSha256",
            "signedAt",
            "lastError",
          ];
          const entries = fields.filter((k) => Object.hasOwn(update, k));
          const assignments = entries.map(
            (k, i) =>
              '"' +
              k +
              '"=$' +
              (i + 1) +
              (k === "providerFileUuid" ? "::uuid" : ""),
          );
          const values = entries.map((k) =>
            update[k] instanceof Date ? update[k].toISOString() : update[k],
          );
          assignments.push(
            '"dueAt"=$' + values.push(dueAt.toISOString()),
            '"leaseToken"=NULL',
            '"leaseUntil"=NULL',
            '"updatedAt"=now()',
          );
          const idParam = values.push(job.id);
          await db.$executeRawUnsafe(
            "UPDATE offer_signature_requests SET " +
              assignments.join(",") +
              " WHERE id=$" +
              idParam +
              "::uuid",
            ...values,
          );
          if (update.state === "SIGNED" && fresh.state !== "SIGNED") {
            await enqueueHrDomainEvent(db, {
              tenantId: tid,
              eventName: "hr.recruitment.offer_signed.v1",
              aggregateType: "Offer",
              aggregateId: job.offerId,
              payload: {
                offerId: String(job.offerId),
                candidateId: String(job.candidateId),
                letterId: job.letterId,
                signatureId: job.id,
              },
            });
            totals.signed++;
          }
          if (update.state === "CANCELLED" && !failure) {
            const offer = await db.offer.findFirst({
              where: { id: job.offerId, tenantId: tid },
            });
            if (
              offer.status === "SENT" &&
              offer.expiryDate &&
              offer.expiryDate <= now
            ) {
              await db.offer.update({
                where: { id: offer.id },
                data: { status: "EXPIRED", version: { increment: 1 } },
              });
              await enqueueHrDomainEvent(db, {
                tenantId: tid,
                eventName: "hr.recruitment.offer_expired.v1",
                aggregateType: "Offer",
                aggregateId: String(offer.id),
                payload: {
                  offerId: String(offer.id),
                  candidateId: String(offer.candidateId),
                  createdById:
                    offer.createdById == null
                      ? null
                      : String(offer.createdById),
                },
              });
            }
          }
          if (update.state === "ERASED") totals.erased++;
          totals.processed++;
        });
      },
    );
  return totals;
}
