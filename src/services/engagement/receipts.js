// src/services/engagement/receipts.js — idempotent command receipts (X-08).
// A mutating tool that takes `requestKey` replays its first result for the
// same key + payload digest, and rejects a different payload under the same
// key (HR-4706). Mirrors HrApprovalReceipt / EmploymentCommandReceipt.
import { fail, hash, json } from "./base.js";

export async function withReceipt(tx, { tenantId, requestKey, toolName, payload }, run) {
  if (!requestKey) return { result: await run(), replayed: false };
  const digest = hash({ toolName, payload });
  if (typeof tx.$executeRaw === "function") {
    // Serialise concurrent retries of the same key inside this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${requestKey}`}, 0))`;
  }
  const existing = await tx.engagementCommandReceipt.findUnique({
    where: { tenantId_requestKey: { tenantId, requestKey } },
  });
  if (existing) {
    if (existing.digest !== digest) fail("HR-4706", "requestKey was already used with a different payload", 409);
    return { result: existing.result, replayed: true };
  }
  const result = await run();
  await tx.engagementCommandReceipt.create({
    data: { tenantId, requestKey, toolName, digest, result: json(result) },
  });
  return { result, replayed: false };
}
