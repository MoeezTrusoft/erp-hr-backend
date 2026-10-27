// src/services/resumeParsing.service.js — AI resume parsing (HR-RESUME).
//
// On resume upload (a DAM media asset) extract & rate skills + competencies and
// extract certifications via the AI PLANE, then persist:
//   * Employees  → Skill (catalog, category 'skill'|'competency') + EmployeeSkill
//                  (score 0-100 + level) + Certification records.
//   * Candidates → CandidateSkill rows (self-contained) + Candidate.parsedResume.
//
// Phase 13 / §7.1 — NO vendor client in HR. This service previously held its own
// OpenAI SDK + OPENAI_API_KEY; every model call now goes through the dedicated
// AI plane (erp-ai-plane) via lib/aiPlaneClient.js (Redis ai:tasks/ai:results),
// which is the only service permitted provider credentials and the only place
// PII redaction (§7.1a), per-tenant token ceilings and provider/residency
// policy (§7.1b) are enforced. With no plane configured the typed 503 degrades
// the FEATURE while core HR keeps working.
//
// ALL text-extraction imports stay LAZY (pdf-parse / mammoth are local, no
// vendor bytes leave) so a missing optional dependency only breaks the resume
// tools — core HR keeps working.
//
// Recruitment Phase 2 — no request ever sleeps between attempts. A request runs
// ONE attempt (parseResumeWithRetry); a failure stores the next due time on the
// ledger row (nextAttemptAt, the backoffDelayMs policy) and the asynchronous
// worker (resume-parse-worker.service.js) runs it then, against the same row, so
// the three-attempt ceiling and the per-tenant cache are shared by both paths.
// The pieces both paths use live here: executeParseAttempt (one attempt on a
// claimed row), completeParseAttempt, and projectParsedResumeOntoCandidate (the
// candidate write plus its hr.recruitment.candidate_resume_parsed.v1 event).
//
// Recruitment Phase 7 — the parse carries yearsOfExperience, derived from the
// plane's dated work-history entries (src/lib/resume-experience.util.js: overlaps
// merged, "present" is the parse time, capped at 50, null when nothing is
// dated). It is stored on the ledger row and on Candidate.parsedResume, where the
// fit score's experience component reads it.
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { eventContext } from "../lib/event-context.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordResumeParse } from "../lib/recruitmentOpsMetrics.js";
import { runAiTask, collectAiResult } from "../lib/aiPlaneClient.js";
import { experienceEntriesOf, yearsOfExperienceFrom } from "../lib/resume-experience.util.js";
import {
  PARSE_MAX_ATTEMPTS,
  PARSE_LEASE_MS,
  hashResumeContent,
  isRetryableFailure,
  nextAttemptAfterFailure,
  decideParse,
} from "../lib/parseRetry.js";

const MAX_RESUME_CHARS = parseInt(process.env.RESUME_MAX_CHARS || "24000", 10);
const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];

const depError = (pkg) =>
  Object.assign(new Error(`Optional dependency "${pkg}" is not installed — resume parsing is unavailable`), {
    status: 501,
    code: "HR-RESUME-DEP-MISSING",
  });

// ---- text extraction (lazy pdf-parse / mammoth) ----
async function extractResumeText(buffer, mimeType, fileName) {
  const name = String(fileName || "").toLowerCase();
  const mt = String(mimeType || "").toLowerCase();
  const isPdf = mt.includes("pdf") || name.endsWith(".pdf");
  const isDocx =
    mt.includes("officedocument.wordprocessing") || mt.includes("msword") || name.endsWith(".docx") || name.endsWith(".doc");

  if (isPdf) {
    let m;
    try {
      m = await import("pdf-parse");
    } catch {
      throw depError("pdf-parse");
    }
    // pdf-parse v2 exports a `PDFParse` class (new API); v1 exported a default
    // callable. Support both so a dependency bump doesn't silently break parsing.
    if (typeof m.PDFParse === "function") {
      const parser = new m.PDFParse({ data: buffer });
      try {
        const data = await parser.getText();
        return String(data?.text || "").trim();
      } finally {
        await parser.destroy?.();
      }
    }
    const pdfParse = m.default || m;
    if (typeof pdfParse !== "function") throw depError("pdf-parse");
    const data = await pdfParse(buffer);
    return String(data?.text || "").trim();
  }

  if (isDocx) {
    let mammoth;
    try {
      mammoth = await import("mammoth");
      mammoth = mammoth.default || mammoth;
    } catch {
      throw depError("mammoth");
    }
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value || "").trim();
  }

  // Plaintext / unknown → best-effort utf8.
  return buffer.toString("utf8").trim();
}

// ---- normalization ----
const normScore = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const normLevel = (level, score) => {
  if (typeof level === "string") {
    const hit = LEVELS.find((l) => l.toLowerCase() === level.trim().toLowerCase());
    if (hit) return hit;
  }
  if (typeof score === "number") {
    if (score >= 85) return "Expert";
    if (score >= 65) return "Advanced";
    if (score >= 40) return "Intermediate";
    return "Beginner";
  }
  return null;
};

// Lenient date parse: "2021", "2021-06", "Jun 2021", "2021-06-15" → Date | null.
const toDate = (v) => {
  if (!v || typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}$/.test(s)) return new Date(Date.UTC(Number(s), 0, 1));
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

const normItem = (raw, defaultCategory) => {
  const name = String(raw?.name || raw?.skill || "").trim();
  if (!name) return null;
  const score = normScore(raw?.score);
  return {
    name,
    category: (raw?.category || defaultCategory || "skill").toLowerCase() === "competency" ? "competency" : "skill",
    score,
    level: normLevel(raw?.level, score),
  };
};

const normCert = (raw) => {
  const name = String(raw?.name || raw?.title || "").trim();
  if (!name) return null;
  return {
    name,
    issuedBy: raw?.issuer || raw?.issuedBy || raw?.organization || null,
    issuedAt: toDate(raw?.issuedDate || raw?.issuedAt || raw?.date),
    expiryDate: toDate(raw?.expiryDate || raw?.expiresAt),
    credentialId: raw?.credentialId || raw?.credentialID || raw?.id || null,
  };
};

// (The old in-tree buildPrompt is gone with §7.1: the prompt lives in the AI
// plane's registry — app/registry/prompts.py, key hr.resume.parse.v1 — and is
// versioned there.)

const PROMPT_KEY = "hr.resume.parse.v1";

// Phase 2 — a plane answer that misses the request's wait window is not lost:
// the task id and the results-stream position are stored on the ledger row
// (parsedJson.pendingAiTask) and the next attempt collects the answer instead
// of paying for a second task. Past this window the answer is presumed gone
// (trimmed off ai:results) and a fresh attempt runs.
const LATE_RESULT_WINDOW_MS = parseInt(process.env.HR_RESUME_PARSE_LATE_RESULT_WINDOW_MS || "900000", 10);
// How soon to look again for a late answer.
const PENDING_POLL_MS = 30_000;

export const PLANE_PENDING_CODE = "HR-RESUME-PLANE-PENDING";
export const CANDIDATE_RESUME_PARSED_EVENT = "hr.recruitment.candidate_resume_parsed.v1";

const RELEASE_CLAIM = Object.freeze({ claimedBy: null, claimExpiresAt: null });

const ledgerError = (err) => `${err?.code ?? ""} ${err?.message ?? err}`.trim().slice(0, 500);

const leaseIsLive = (row, now) =>
  row?.status === "RUNNING" && row.claimExpiresAt && new Date(row.claimExpiresAt).getTime() > new Date(now).getTime();

/** The late-answer marker on a non-completed ledger row, or null. */
export function pendingMarkerOf(row) {
  if (!row || row.status === "COMPLETED") return null;
  const marker = row.parsedJson && typeof row.parsedJson === "object" ? row.parsedJson.pendingAiTask : null;
  return marker?.taskId ? marker : null;
}

const exhaustedError = (attempts, reason = "MAX_ATTEMPTS") =>
  Object.assign(new Error(`Resume parsing exhausted its ${PARSE_MAX_ATTEMPTS} attempts for this content`), {
    status: 429,
    code: "HR-RESUME-ATTEMPTS-EXHAUSTED",
    details: { reason, attempts: attempts ?? 0 },
  });

// Normalize a plane answer and record its §7.4 provenance. Throws the typed
// pending error when the wait window expired, and HR-RESUME-PLANE-FAILED on a
// non-ok answer.
async function finishPlaneResult(res, { inputHash, charsAnalyzed, tenantId, candidateId, now = new Date() }) {
  if (res?.pending) {
    await recordInference({
      kind: "resume-parse",
      promptKey: PROMPT_KEY,
      inputHash,
      status: "pending",
      errorMessage: "plane answer did not arrive within the wait window",
      traceId: res.taskId,
      tenantId,
      candidateId,
    }).catch(() => {});
    throw Object.assign(new Error("The AI plane has not answered yet; the result will be collected later"), {
      status: 504,
      code: PLANE_PENDING_CODE,
      details: { taskId: res.taskId, sinceId: res.sinceId ?? "-", inputHash, charsAnalyzed },
    });
  }

  const output = res?.output ?? {};
  const modelResp = output?.result ?? {};

  const provenance = {
    taskId: res.taskId,
    provider: output.provider ?? null,
    model: output.model ?? null,
    promptKey: PROMPT_KEY,
    redactionCounts: output.redactionCounts ?? null,
    tokensUsed: res.tokensUsed ?? null,
    inputHash,
  };

  if (res.status !== "ok" || res.error) {
    await recordInference({
      kind: "resume-parse",
      promptKey: provenance.promptKey,
      provider: provenance.provider,
      model: provenance.model,
      inputHash,
      status: "error",
      errorMessage: String(res.error ?? "plane returned non-ok status").slice(0, 500),
      tokensUsed: res.tokensUsed ?? null,
      traceId: res.taskId,
      tenantId,
      candidateId,
    }).catch(() => {});
    throw Object.assign(new Error(`AI plane parse failed: ${res.error ?? res.status}`), {
      status: 502,
      code: "HR-RESUME-PLANE-FAILED",
      details: { taskId: res.taskId },
    });
  }

  const parsed = modelResp && typeof modelResp === "object" ? modelResp : {};

  const skills = (Array.isArray(parsed.skills) ? parsed.skills : []).map((s) => normItem(s, "skill")).filter(Boolean);
  const competencies = (Array.isArray(parsed.competencies) ? parsed.competencies : [])
    .map((s) => normItem(s, "competency"))
    .filter(Boolean);
  const certifications = (Array.isArray(parsed.certifications) ? parsed.certifications : [])
    .map(normCert)
    .filter(Boolean);
  // Years only: the entries themselves (employers, titles) are not kept.
  const yearsOfExperience = yearsOfExperienceFrom(experienceEntriesOf(parsed), now);

  await recordInference({
    kind: "resume-parse",
    promptKey: provenance.promptKey,
    provider: provenance.provider,
    model: provenance.model,
    inputHash,
    status: "ok",
    tokensUsed: res.tokensUsed ?? null,
    traceId: res.taskId,
    tenantId,
    candidateId,
  }).catch(() => {});

  return {
    skills,
    competencies,
    certifications,
    yearsOfExperience,
    model: provenance.model,
    provider: provenance.provider,
    aiProvenance: provenance,
    charsAnalyzed,
  };
}

// Send the redacted-by-plane resume text to the AI plane (§7.1) and normalize
// the output. The plane owns provider/model selection (its registry entry
// hr.resume.parse.v1), PII redaction (§7.1a) and the token ceiling; HR owns
// normalization and the §7.4 provenance that travels with the result.
async function parseResumeText(text, { tenantId = null, candidateId = null, correlationId = null, now = new Date() } = {}) {
  if (!text || text.length < 20) {
    return { skills: [], competencies: [], certifications: [], yearsOfExperience: null, warning: "resume text was empty or too short" };
  }
  // Phase 15 — AI features are flag-gated (§7.1b): a disabled deployment gets
  // the same typed 503 as a missing plane, so callers need no new error shape.
  if (!isRecruitmentFlagEnabled("ai")) {
    recordResumeParse({ kind: "CANDIDATE", outcome: "flag-disabled" });
    throw Object.assign(new Error("Recruitment AI features are disabled (HR_RECRUITMENT_AI=off)"), {
      status: 503,
      code: "HR-RECRUITMENT-AI-DISABLED",
    });
  }

  // §7.4 — provenance is captured at the boundary, not inferred later: hash the
  // exact input we hand the plane, then record who/what answered.
  const input = String(text).slice(0, MAX_RESUME_CHARS);
  const inputHash = createHash("sha256").update(input).digest("hex");
  const meta = { inputHash, charsAnalyzed: Math.min(text.length, MAX_RESUME_CHARS), tenantId, candidateId, now };

  let res;
  try {
    res = await runAiTask({
      promptKey: PROMPT_KEY,
      type: "hr.resume.parse",
      tenantId,
      input: { resumeText: input },
      correlationId,
    });
  } catch (err) {
    // The plane is unreachable/unconfigured — record the degraded attempt
    // (§7.4: status/failure reason is provenance too) and rethrow the typed 503.
    await recordInference({
      kind: "resume-parse",
      promptKey: PROMPT_KEY,
      inputHash,
      status: "degraded-unavailable",
      errorMessage: `${err?.code ?? ""} ${err?.message ?? err}`.trim().slice(0, 500),
      tenantId,
      candidateId,
    }).catch(() => {});
    throw err;
  }
  return finishPlaneResult(res, meta);
}

// Look for a late plane answer. Returns { result } when it arrived and was
// usable, { error } when it arrived as a failure, {} when it has not arrived.
// A transport error while looking is "not arrived": the window then decides.
async function collectLateResult(marker, { tenantId, candidateId, now = new Date() }) {
  let res;
  try {
    res = await collectAiResult({ taskId: marker.taskId, sinceId: marker.sinceId ?? "-" });
  } catch (err) {
    logger.warn({ errCode: err?.code, taskId: marker.taskId }, "resume: late-result lookup failed");
    return {};
  }
  if (res?.pending) return {};
  try {
    const meta = { inputHash: marker.inputHash, charsAnalyzed: marker.charsAnalyzed ?? null, tenantId, candidateId, now };
    return { result: await finishPlaneResult(res, meta) };
  } catch (err) {
    return { error: err };
  }
}

// §7.4 — persist one provenance row. Deliberately best-effort: a provenance
// ledger write must never break the parse it is auditing.
async function recordInference(data) {
  try {
    await prisma.aiInferenceRecord.create({ data });
  } catch (err) {
    logger.warn({ err: err?.message }, "resume: ai_inference_records write failed (best-effort)");
  }
}

// ── the ledger attempt (shared by the request path and the worker) ──────────
//
// Every ledger write after a claim is guarded by the claim token: a claimant
// whose lease expired (and whose row someone else reclaimed) writes nothing.

async function writeLedger(row, claimToken, data, client = prisma) {
  const { count } = await client.resumeParseAttempt.updateMany({
    where: { id: row.id, tenantId: row.tenantId, claimedBy: claimToken },
    data,
  });
  return count === 1;
}

async function recordFailedAttempt({ row, claimToken, err, attempt, now }) {
  recordResumeParse({ kind: row.kind, outcome: "failed" });
  if (err?.code === PLANE_PENDING_CODE && err.details?.taskId) {
    const nextAttemptAt = new Date(now.getTime() + PENDING_POLL_MS);
    await writeLedger(row, claimToken, {
      status: "FAILED",
      lastError: ledgerError(err),
      parsedJson: { pendingAiTask: { ...err.details, submittedAt: now.toISOString() } },
      nextAttemptAt,
      ...RELEASE_CLAIM,
    });
    return { outcome: "PENDING", error: err, attempt, nextAttemptAt };
  }
  const retryable = isRetryableFailure(err);
  const nextAttemptAt = nextAttemptAfterFailure({ attempt, retryable, now });
  await writeLedger(row, claimToken, {
    status: "FAILED",
    lastError: ledgerError(err),
    parsedJson: Prisma.DbNull,
    nextAttemptAt,
    ...RELEASE_CLAIM,
  });
  const outcome = nextAttemptAt ? "RETRY_SCHEDULED" : retryable ? "EXHAUSTED" : "FAILED";
  return { outcome, error: err, attempt, retryable, nextAttemptAt };
}

/**
 * Run ONE parse attempt on a ledger row the caller has claimed (status RUNNING,
 * claimedBy = claimToken). Never sleeps and never loops: a failure records when
 * the next attempt is due (nextAttemptAt) and returns.
 *
 * Order: a stored late-answer marker is collected first (no new task, no new
 * attempt); otherwise the attempt count is spent BEFORE the plane call, so a
 * crash mid-attempt still counts against the three-attempt ceiling.
 *
 * Does NOT write COMPLETED: the caller does, in the transaction that projects
 * the result (completeParseAttempt), so a completed row always has its projection.
 *
 * @param {object} args
 * @param {object} args.row          the claimed ledger row
 * @param {string} args.claimToken   its claimedBy value
 * @param {string} args.tenantId
 * @param {number|null} [args.candidateId]  provenance only
 * @param {() => Promise<{buffer: Buffer, mimeType?: string, fileName?: string}>} args.loadContent
 * @param {Date} [args.now]
 * @returns {Promise<{ outcome: "COMPLETED"|"PENDING"|"RETRY_SCHEDULED"|"FAILED"|"EXHAUSTED"|"LEASE_LOST",
 *   result?: object, error?: Error, attempt: number, nextAttemptAt?: Date|null, lateResult?: boolean }>}
 */
export async function executeParseAttempt({ row, claimToken, tenantId, candidateId = null, loadContent, now = new Date() }) {
  const at = new Date(now);
  const marker = pendingMarkerOf(row);
  if (marker) {
    const late = await collectLateResult(marker, { tenantId, candidateId, now: at });
    if (late.result) {
      logger.info({ parseAttemptId: row.id, taskId: marker.taskId }, "resume: collected a late plane answer");
      return { outcome: "COMPLETED", result: late.result, attempt: row.attemptCount ?? 0, lateResult: true };
    }
    if (late.error) return recordFailedAttempt({ row, claimToken, err: late.error, attempt: row.attemptCount ?? 0, now: at });
    const age = at.getTime() - new Date(marker.submittedAt ?? 0).getTime();
    if (age < LATE_RESULT_WINDOW_MS) {
      const nextAttemptAt = new Date(at.getTime() + PENDING_POLL_MS);
      await writeLedger(row, claimToken, { status: "FAILED", nextAttemptAt, ...RELEASE_CLAIM });
      return { outcome: "PENDING", error: pendingMarkerError(marker), attempt: row.attemptCount ?? 0, nextAttemptAt };
    }
    // Past the window the answer is presumed trimmed off the stream: a fresh
    // attempt follows, if the ceiling allows one.
  }

  const attempt = (row.attemptCount ?? 0) + 1;
  if (attempt > PARSE_MAX_ATTEMPTS) {
    await writeLedger(row, claimToken, { status: "FAILED", nextAttemptAt: null, parsedJson: Prisma.DbNull, ...RELEASE_CLAIM });
    recordResumeParse({ kind: row.kind, outcome: "exhausted" });
    return { outcome: "EXHAUSTED", error: exhaustedError(row.attemptCount), attempt: row.attemptCount ?? 0 };
  }

  const owned = await writeLedger(row, claimToken, {
    status: "RUNNING",
    attemptCount: attempt,
    lastError: null,
    nextAttemptAt: null,
    parsedJson: Prisma.DbNull,
  });
  if (!owned) return { outcome: "LEASE_LOST", attempt };

  try {
    const dl = await loadContent();
    const text = await extractResumeText(dl.buffer, dl.mimeType, dl.fileName);
    const result = await parseResumeText(text, { tenantId, candidateId, correlationId: row.contentHash, now: at });
    return { outcome: "COMPLETED", result, attempt };
  } catch (err) {
    return recordFailedAttempt({ row, claimToken, err, attempt, now: at });
  }
}

const pendingMarkerError = (marker) =>
  Object.assign(new Error("The AI plane has not answered yet; the result will be collected later"), {
    status: 504,
    code: PLANE_PENDING_CODE,
    details: { taskId: marker.taskId },
  });

/**
 * Mark a claimed row COMPLETED with its parse (the cache payload) and release
 * the claim. Pass the transaction client when the projection is written in the
 * same transaction. Throws HR-RESUME-LEASE-LOST when the claim is no longer ours.
 */
export async function completeParseAttempt(client, row, claimToken, result) {
  const owned = await writeLedger(
    row,
    claimToken,
    { status: "COMPLETED", parsedJson: result, lastError: null, nextAttemptAt: null, ...RELEASE_CLAIM },
    client,
  );
  if (!owned) {
    throw Object.assign(new Error("The parse attempt's claim expired before it completed"), {
      status: 409,
      code: "HR-RESUME-LEASE-LOST",
    });
  }
}

// Download a resume asset from DAM and parse it (no candidate writes).
// Phase 6 / §4.5a — the ledger-driven parse entrypoint for REQUEST callers
// (both ingestion kinds and the preview), so the content-hash cache and the
// three-attempt ceiling are the only behaviour, not one surface among several.
//
// Phase 2 — ONE attempt per call. A failure records the backoff in
// nextAttemptAt and throws; the caller (or, for a candidate, the asynchronous
// worker) tries again once it is due. A call inside the backoff gets
// HR-RESUME-BACKOFF, one past the ceiling HR-RESUME-ATTEMPTS-EXHAUSTED, as
// before. The name is kept for its callers.
export async function parseResumeWithRetry(
  mediaId,
  { kind = "CANDIDATE", tenantId = null, candidateId = null, force = false, now = null } = {},
) {
  // D-13 — the cache is per tenant: the same bytes uploaded by two companies
  // are two ledger rows, so one tenant's parsed result never serves another.
  if (!tenantId) throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  const at = now ? new Date(now) : new Date();
  const dl = await downloadDamAssetBuffer(mediaId);
  if (!dl?.buffer) {
    throw Object.assign(new Error(`Could not download resume asset ${mediaId} from DAM`), {
      status: 502,
      code: "HR-RESUME-DAM-FETCH",
    });
  }

  const contentHash = hashResumeContent(dl.buffer);
  const ledger = prisma.resumeParseAttempt;

  const cacheKey = { tenantId_kind_contentHash: { tenantId, kind, contentHash } };
  let prior = await ledger.findUnique({ where: cacheKey });
  // An explicit force re-parse is the operator's "I know, run it again": it
  // resets the cache AND the ceiling for THIS content only (the row is
  // recreated), never silently, and never under an attempt still in flight.
  if (force && prior && !leaseIsLive(prior, at)) {
    await ledger.delete({ where: { id: prior.id } });
    prior = null;
  }

  // A stored late-answer marker is collected before anything else is decided:
  // it costs no attempt and no new plane task.
  const decision =
    pendingMarkerOf(prior) && !leaseIsLive(prior, at)
      ? { action: "RETRY", attempt: prior.attemptCount, reason: "LATE_RESULT" }
      : decideParse({ priorAttempt: prior, contentHash, now: at });

  if (decision.action === "SKIP") {
    const cached = prior.parsedJson ?? null;
    logger.info({ kind, contentHash: contentHash.slice(0, 12), mediaId }, "resume: parse cache hit (§4.5a)");
    recordResumeParse({ kind, outcome: "cache-hit" });
    return {
      mediaId: Number(mediaId),
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      fromCache: true,
      contentHash,
      parseAttemptId: prior.id,
      ...(cached ?? {}),
    };
  }
  if (decision.action === "EXHAUSTED") {
    recordResumeParse({ kind, outcome: "exhausted" });
    throw exhaustedError(prior?.attemptCount, decision.reason);
  }
  if (decision.action === "RETRY_LATER") throw backoffError(kind, decision);

  // PARSE or RETRY: claim the row for this request (a lease, like the worker's)
  // and run one attempt. attemptCount is carried forward; the attempt spends it.
  const claimToken = `request:${randomUUID()}`;
  const claim = { status: "RUNNING", claimedBy: claimToken, claimExpiresAt: new Date(at.getTime() + PARSE_LEASE_MS) };
  const media = Number(mediaId) || null;
  const owner = Number(candidateId) || null;
  const row = await ledger.upsert({
    where: cacheKey,
    create: { kind, contentHash, mediaId: media, attemptCount: 0, tenantId, candidateId: owner, ...claim },
    // A candidate parse names its candidate so the worker can finish a retry
    // the request left scheduled; a preview never clears an existing owner.
    update: { ...claim, mediaId: media, ...(owner ? { candidateId: owner } : {}) },
  });

  const out = await executeParseAttempt({
    row: { ...row, tenantId, kind },
    claimToken,
    tenantId,
    candidateId: owner,
    loadContent: async () => dl,
    now: at,
  });

  if (out.outcome === "COMPLETED") {
    try {
      await completeParseAttempt(prisma, { ...row, tenantId }, claimToken, out.result);
    } catch (err) {
      // Someone reclaimed the row while we parsed; our answer is still valid
      // for this caller, the ledger simply keeps the other claimant's write.
      if (err?.code !== "HR-RESUME-LEASE-LOST") throw err;
      logger.warn({ parseAttemptId: row.id }, "resume: claim lost before completion; result returned uncached");
    }
    recordResumeParse({ kind, outcome: "ok" });
    return {
      mediaId: Number(mediaId),
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      fromCache: false,
      contentHash,
      parseAttemptId: row.id,
      ...out.result,
    };
  }
  if (out.outcome === "LEASE_LOST") throw backoffError(kind, { action: "RETRY_LATER", attempt: out.attempt, waitMs: PARSE_LEASE_MS, reason: "IN_PROGRESS" });
  throw Object.assign(out.error, { parseOutcome: out.outcome, nextAttemptAt: out.nextAttemptAt ?? null });
}

function backoffError(kind, decision) {
  recordResumeParse({ kind, outcome: "throttled" });
  return Object.assign(
    new Error(`A prior parse attempt is ${decision.reason === "IN_PROGRESS" ? "still running" : "throttled"} (retry in ${Math.ceil(decision.waitMs / 1000)}s)`),
    {
      status: 429,
      code: "HR-RESUME-BACKOFF",
      details: { retryAfterMs: decision.waitMs, attempt: decision.attempt, reason: decision.reason },
    },
  );
}

export async function parseResumePreview(mediaId, { tenantId = null } = {}) {
  return parseResumeWithRetry(mediaId, { kind: "CANDIDATE", tenantId });
}

/**
 * Parse a resume and persist to an EMPLOYEE:
 *  - Skill (catalog) upsert by name + category, EmployeeSkill upsert w/ score+level+source
 *  - Certification records (deduped by name for the employee)
 */
export async function ingestEmployeeResume({ employeeId, mediaId, tenantId = null, actorId = null }) {
  const id = Number(employeeId);
  // The employee is read inside the caller's tenant (Employee keys it as
  // tenant_id); a legacy call without a tenant falls back to the row's own.
  const employee = await prisma.employee.findFirst({
    where: tenantId ? { id, tenant_id: tenantId } : { id },
    select: { id: true, tenant_id: true },
  });
  if (!employee) throw Object.assign(new Error("Employee not found"), { status: 404 });
  const tenant = tenantId ?? employee.tenant_id ?? null;

  // The ledger kind is EMPLOYEE: an employee's resume has its own cache row.
  const parsed = await parseResumeWithRetry(mediaId, { kind: "EMPLOYEE", tenantId: tenant });
  const items = [...parsed.skills, ...parsed.competencies];

  const skillsWritten = [];
  for (const item of items) {
    // F-DB-03: the skill catalog key is tenant-qualified.
    const skill = await prisma.skill.upsert({
      where: { tenantId_name: { tenantId: tenant, name: item.name } },
      create: { name: item.name, category: item.category, tenantId: tenant },
      update: { category: item.category },
      select: { id: true, name: true, category: true },
    });
    await prisma.employeeSkill.upsert({
      where: { employeeId_skillId: { employeeId: id, skillId: skill.id } },
      create: {
        employeeId: id,
        skillId: skill.id,
        proficiency: item.level,
        level: item.level,
        score: item.score,
        source: "ai-resume",
        tenantId: tenant,
      },
      update: { proficiency: item.level, level: item.level, score: item.score, source: "ai-resume" },
    });
    skillsWritten.push({ ...item, skillId: skill.id });
  }

  // Certifications — dedupe by (employeeId, name).
  const certsWritten = [];
  for (const cert of parsed.certifications) {
    const exists = await prisma.certification.findFirst({
      where: { employeeId: id, name: cert.name },
      select: { id: true },
    });
    if (exists) continue;
    const created = await prisma.certification.create({
      data: {
        employeeId: id,
        name: cert.name,
        issuedBy: cert.issuedBy,
        issuedAt: cert.issuedAt,
        expiryDate: cert.expiryDate,
        credentialId: cert.credentialId,
        tenantId: tenant,
      },
      select: { id: true, name: true },
    });
    certsWritten.push(created);
  }

  logger.info(
    { employeeId: id, mediaId, skills: skillsWritten.length, certs: certsWritten.length, actorId },
    "resume: ingested into employee"
  );

  return {
    employeeId: id,
    mediaId: Number(mediaId),
    counts: {
      skills: parsed.skills.length,
      competencies: parsed.competencies.length,
      skillsWritten: skillsWritten.length,
      certificationsWritten: certsWritten.length,
    },
    skills: parsed.skills,
    competencies: parsed.competencies,
    certifications: parsed.certifications,
  };
}

// ── the candidate projection (shared by the request path and the worker) ────

/**
 * The outbox args for hr.recruitment.candidate_resume_parsed.v1. Ids, the
 * outcome and counts only: no skill names, no resume text, no PII. Emitted on
 * COMPLETED and on a terminal FAILED/EXHAUSTED, so scoring and duplicate
 * detection can react to a finished parse.
 */
export function candidateResumeParsedEvent(fields, ctx = {}) {
  if (!fields?.tenantId || !fields?.candidateId) return null;
  const count = (value) => (Number.isInteger(value) ? value : 0);
  return {
    eventName: CANDIDATE_RESUME_PARSED_EVENT,
    tenantId: fields.tenantId,
    aggregateType: "Candidate",
    aggregateId: fields.candidateId,
    actorId: ctx.actorId ?? null,
    actorType: ctx.actorType ?? "service",
    correlationId: ctx.correlationId,
    payload: {
      candidateId: String(fields.candidateId),
      mediaId: fields.mediaId != null ? String(fields.mediaId) : null,
      parseAttemptId: fields.parseAttemptId != null ? String(fields.parseAttemptId) : null,
      status: fields.status,
      skillCount: count(fields.skillCount),
      competencyCount: count(fields.competencyCount),
      certificationCount: count(fields.certificationCount),
      fromCache: fields.fromCache === true,
      attempts: Number.isInteger(fields.attempts) ? fields.attempts : null,
    },
  };
}

/**
 * Write a parse onto a candidate, inside the caller's transaction:
 *  - Candidate parse state COMPLETED + the parsedResume snapshot (incl.
 *    certifications, since candidates have no Certification relation)
 *  - CandidateSkill rows (self-contained), upserted by (candidateId, name)
 *  - hr.recruitment.candidate_resume_parsed.v1 in the same transaction
 * The candidate is matched with the tenant predicate; a miss is a 404 and the
 * transaction rolls back.
 */
export async function projectParsedResumeOntoCandidate(
  tx,
  { tenantId, candidateId, mediaId, parsed, parseAttemptId = null, fromCache = false, attempts = null, ctx = {}, now = new Date() },
) {
  const id = Number(candidateId);
  const skills = parsed?.skills ?? [];
  const competencies = parsed?.competencies ?? [];
  const certifications = parsed?.certifications ?? [];

  const { count } = await tx.candidate.updateMany({
    where: withTenant(tenantId, { id }),
    data: {
      parseStatus: "COMPLETED",
      parseError: null,
      parsedAt: new Date(now),
      parsedResume: {
        mediaId: Number(mediaId),
        contentHash: parsed?.contentHash,
        model: parsed?.model,
        skills,
        competencies,
        certifications,
        // Phase 7 — read by the fit score; null when the parse dated nothing
        // (a parse cached before Phase 7 has no value either).
        yearsOfExperience: Number.isFinite(parsed?.yearsOfExperience) ? parsed.yearsOfExperience : null,
      },
    },
  });
  if (!count) throw Object.assign(new Error("Candidate not found"), { status: 404 });

  for (const item of [...skills, ...competencies]) {
    await tx.candidateSkill.upsert({
      where: { candidateId_name: { candidateId: id, name: item.name } },
      create: {
        candidateId: id,
        name: item.name,
        category: item.category,
        score: item.score,
        level: item.level,
        source: "ai-resume",
        tenantId,
      },
      update: { category: item.category, score: item.score, level: item.level, source: "ai-resume" },
    });
  }

  const event = candidateResumeParsedEvent(
    {
      tenantId,
      candidateId: id,
      mediaId,
      parseAttemptId,
      status: "COMPLETED",
      skillCount: skills.length,
      competencyCount: competencies.length,
      certificationCount: certifications.length,
      fromCache,
      attempts,
    },
    { ...eventContext(ctx), actorType: ctx.actorType },
  );
  if (event) await enqueueHrDomainEvent(tx, event);

  return { skills: skills.length, competencies: competencies.length, certifications: certifications.length };
}

// The candidate-facing parse state a request-path failure leaves, or null when
// the failure says nothing about the parse (a 400/404 before any attempt).
function candidateStatusForFailure(err) {
  if (err?.code === "HR-RESUME-ATTEMPTS-EXHAUSTED" || err?.parseOutcome === "EXHAUSTED") return "EXHAUSTED";
  if (err?.code === PLANE_PENDING_CODE) return "PENDING";
  if (err?.code === "HR-RESUME-BACKOFF" || err?.code === "HR-RESUME-BAD-JSON" || err?.status >= 500 || err?.parseOutcome) {
    return "FAILED";
  }
  return null;
}

/**
 * Parse a resume and persist to a CANDIDATE (the request path). The projection
 * is projectParsedResumeOntoCandidate, the same function the worker uses.
 */
export async function ingestCandidateResume({ candidateId, mediaId, tenantId = null, actorId = null }) {
  const id = Number(candidateId);
  const candidate = await prisma.candidate.findFirst({
    where: tenantId ? withTenant(tenantId, { id }) : { id },
    select: { id: true, tenantId: true, resumeMediaId: true },
  });
  if (!candidate) throw Object.assign(new Error("Candidate not found"), { status: 404 });
  const tenant = tenantId ?? candidate.tenantId ?? null;
  const resumeMediaId = mediaId ?? candidate.resumeMediaId;
  if (!resumeMediaId) throw Object.assign(new Error("Candidate has no resumeMediaId to parse"), { status: 400 });

  // Phase 6 / §4.5a — the parse goes through the ledger entrypoint; the
  // candidate row gets the parse-state projection (status/error/time) so the
  // candidate-facing UI can show "parsing…/parsed/failed" without reading the
  // ledger. The ledger decides when a retry is allowed, not the candidate row.
  let parsed;
  try {
    parsed = await parseResumeWithRetry(resumeMediaId, { kind: "CANDIDATE", tenantId: tenant, candidateId: id });
  } catch (err) {
    const status = candidateStatusForFailure(err);
    if (status) {
      await prisma.candidate.updateMany({
        where: withTenant(tenant, { id }),
        data: { parseStatus: status, parseError: String(err?.message ?? err).slice(0, 300) },
      });
    }
    throw err;
  }

  await tenantTransaction(
    prisma,
    async (tx) =>
      await projectParsedResumeOntoCandidate(tx, {
        tenantId: tenant,
        candidateId: id,
        mediaId: resumeMediaId,
        parsed,
        parseAttemptId: parsed.parseAttemptId ?? null,
        fromCache: parsed.fromCache === true,
        ctx: { actorId },
      }),
    { tenantId: tenant },
  );

  logger.info(
    { candidateId: id, mediaId: resumeMediaId, skills: parsed.skills.length, competencies: parsed.competencies.length },
    "resume: ingested into candidate"
  );

  return {
    candidateId: id,
    mediaId: Number(resumeMediaId),
    counts: {
      skills: parsed.skills.length,
      competencies: parsed.competencies.length,
      certifications: parsed.certifications.length,
    },
    skills: parsed.skills,
    competencies: parsed.competencies,
    certifications: parsed.certifications,
    yearsOfExperience: Number.isFinite(parsed.yearsOfExperience) ? parsed.yearsOfExperience : null,
  };
}
