// src/lib/parseRetry.js
//
// Phase 6 / decision record §4.5/4.5a — the resume-parse retry policy, pure.
//
// The decision names three things:
//   * §4.5  HR calls the dedicated AI service plane, never a vendor client
//     directly. (Already true: resumeParsing.service lazy-imports openai behind
//     its own boundary; this module does not touch vendors at all.)
//   * §4.5a THREE idempotent attempts with exponential backoff, keyed/cached
//     against the candidate asset CONTENT HASH — so the same resume is not
//     re-charged or parsed differently without reason.
//   * §4.6-adjacent: an erasure (or a plain re-parse) can reset the cache row.
//
// What "keyed against the content hash" means HERE: the cache key is the SHA-256
// of the asset bytes, not the media id. Re-uploading the identical file (new
// media id, same bytes) HITS the cache — no second vendor call, no second
// charge, and no parsing drift between the two attempts. A genuinely different
// file is a different key and parses fresh.
//
// Separation of concerns:
//   * THIS module — pure policy. Given history, decide: is a parse needed, how
//     long to wait, should we retry this failure. No DB, no clock calls (now is
//     injected), fully unit-testable.
//   * resumeParsing.service — execution. Owns the attempts loop, the DB row and
//     the vendor boundary.

import { createHash } from "node:crypto";

export const PARSE_MAX_ATTEMPTS = 3;

// Exponential backoff: attempt 1 → 1s, attempt 2 → 4s, attempt 3 → 9s (n²).
// Deliberately seconds-scale, not ms-scale: the vendor call itself takes tens of
// seconds; the point is to outlive transient provider hiccups, not to hammer.
export const backoffDelayMs = (attempt) =>
  Math.round(Math.pow(attempt, 2) * 1000);

export function hashResumeContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** The DB lookup key for a parse: the tenant's asset content hash. */
export const parseCacheKey = (contentHash) => `resume-parse:${contentHash}`;

/** Failure classification: transient failures retry; permanent ones do not. */
const PERMANENT_ERROR_CODES = new Set([
  "HR-RESUME-PERMANENT",
  "HR-RESUME-DEP-MISSING", // no openai/pdf-parse installed — retrying cannot help
  "HR-RESUME-NO-KEY", // no API key — an operator fix, not a retry fix
  "HR-RESUME-UNSUPPORTED-TYPE", // the file will never extract
  "HR-RESUME-EMPTY-DOCUMENT", // no text to parse
  "HR-AI-PLANE-UNAVAILABLE", // no REDIS_URL / plane down — an operator fix (Phase 13 §7.1)
  "HR-RECRUITMENT-AI-DISABLED", // flag off — retrying against a closed gate is waste (Phase 15)
]);

export function isRetryableFailure(error) {
  if (!error) return false;
  if (error.code && PERMANENT_ERROR_CODES.has(error.code)) return false;
  // HTTP-ish statuses from the vendor boundary: 4xx (except 408/429) means our
  // request is the problem; 5xx / timeouts / network errors are theirs.
  const status = Number(error.status ?? error.statusCode);
  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return false;
  }
  return true;
}

/**
 * Classify a failure FROM ITS STORED LEDGER STRING. The wrapper persists
 * `${err.code ?? ""} ${err.message}` — the first token is the code when there
 * was one — so a stale RUNNING row's lease decision must reconstruct the
 * classification from that string, not from a live error object.
 */
export function storedErrorIsRetryable(lastError) {
  if (!lastError) return true;
  const text = String(lastError);
  const firstToken = text.trim().split(/\s+/)[0] ?? "";
  return isRetryableFailure({
    code: PERMANENT_ERROR_CODES.has(firstToken) ? firstToken : undefined,
    message: text,
  });
}

/**
 * Decide whether a parse must run, from a prior attempt row (if any) and the
 * asset's current content hash.
 *
 *   no prior row                → PARSE (first attempt)
 *   hash matches, COMPLETED     → SKIP  (cache hit — no re-charge, no drift)
 *   hash matches, FAILED and    → RETRY (attempt ≤ max, failure retryable,
 *   backoff elapsed                     backoff elapsed)
 *   hash matches, FAILED and    → RETRY_LATER (same, but backoff not yet out)
 *   hash differs                → PARSE (the resume changed; the old cache is
 *                                        for a different document)
 */
export function decideParse({
  priorAttempt = null,
  contentHash,
  now = new Date(),
} = {}) {
  if (!priorAttempt) return { action: "PARSE", attempt: 1, waitMs: 0 };

  const sameContent = priorAttempt.contentHash === contentHash;
  if (!sameContent) {
    return {
      action: "PARSE",
      attempt: 1,
      waitMs: 0,
      reason: "CONTENT_CHANGED",
    };
  }

  if (priorAttempt.status === "COMPLETED") {
    return {
      action: "SKIP",
      attempt: priorAttempt.attemptCount,
      waitMs: 0,
      reason: "CACHE_HIT",
    };
  }

  // FAILED (or a stuck RUNNING row past its lease — treated as failed).
  const attempt = (priorAttempt.attemptCount ?? 0) + 1;
  if (attempt > PARSE_MAX_ATTEMPTS) {
    return { action: "EXHAUSTED", attempt, waitMs: 0, reason: "MAX_ATTEMPTS" };
  }

  const lastError = priorAttempt.lastError
    ? String(priorAttempt.lastError)
    : "";
  const retryable = storedErrorIsRetryable(lastError);
  if (!retryable) {
    return { action: "EXHAUSTED", attempt, waitMs: 0, reason: "NON_RETRYABLE" };
  }

  const waitMs = backoffDelayMs(priorAttempt.attemptCount ?? 1);
  const sinceLast = now instanceof Date ? now : new Date(now);
  const elapsed =
    sinceLast.getTime() -
    new Date(priorAttempt.updatedAt ?? priorAttempt.startedAt ?? 0).getTime();
  if (elapsed < waitMs) {
    return {
      action: "RETRY_LATER",
      attempt,
      waitMs: waitMs - elapsed,
      reason: "BACKOFF",
    };
  }

  return {
    action: "RETRY",
    attempt,
    waitMs: 0,
    reason: priorAttempt.status === "RUNNING" ? "STALE_LEASE" : "PRIOR_FAILURE",
  };
}
