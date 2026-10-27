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
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { createHash, randomUUID } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordResumeParse } from "../lib/recruitmentOpsMetrics.js";
import { runAiTask } from "../lib/aiPlaneClient.js";
import {
  hashResumeContent,
  decideParse,
  isRetryableFailure,
} from "../lib/parseRetry.js";

const MAX_RESUME_CHARS = parseInt(process.env.RESUME_MAX_CHARS || "24000", 10);
const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];

const depError = (pkg) =>
  Object.assign(
    new Error(
      `Optional dependency "${pkg}" is not installed — resume parsing is unavailable`,
    ),
    {
      status: 501,
      code: "HR-RESUME-DEP-MISSING",
    },
  );

// ---- text extraction (lazy pdf-parse / mammoth) ----
async function extractResumeText(buffer, mimeType, fileName) {
  const name = String(fileName || "").toLowerCase();
  const mt = String(mimeType || "").toLowerCase();
  const isPdf = mt.includes("pdf") || name.endsWith(".pdf");
  const isDocx =
    mt.includes("officedocument.wordprocessing") ||
    mt.includes("msword") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc");

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
    const hit = LEVELS.find(
      (l) => l.toLowerCase() === level.trim().toLowerCase(),
    );
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
    category:
      (raw?.category || defaultCategory || "skill").toLowerCase() ===
      "competency"
        ? "competency"
        : "skill",
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

// Send the redacted-by-plane resume text to the AI plane (§7.1) and normalize
// the output. The plane owns provider/model selection (its registry entry
// hr.resume.parse.v1), PII redaction (§7.1a) and the token ceiling; HR owns
// normalization and the §7.4 provenance that travels with the result.
async function parseResumeText(
  text,
  { tenantId = null, candidateId = null, correlationId = null } = {},
) {
  if (!text || text.length < 20) {
    throw Object.assign(new Error("Resume text is empty or too short"), {
      status: 422,
      code: "HR-RESUME-EMPTY-DOCUMENT",
    });
  }
  // Phase 15 — AI features are flag-gated (§7.1b): a disabled deployment gets
  // the same typed 503 as a missing plane, so callers need no new error shape.
  if (!isRecruitmentFlagEnabled("ai")) {
    recordResumeParse({ kind: "CANDIDATE", outcome: "flag-disabled" });
    throw Object.assign(
      new Error("Recruitment AI features are disabled (HR_RECRUITMENT_AI=off)"),
      {
        status: 503,
        code: "HR-RECRUITMENT-AI-DISABLED",
      },
    );
  }

  // §7.4 — provenance is captured at the boundary, not inferred later: hash the
  // exact input we hand the plane, then record who/what answered.
  const inputHash = createHash("sha256")
    .update(String(text).slice(0, MAX_RESUME_CHARS))
    .digest("hex");

  let res;
  try {
    res = await runAiTask({
      promptKey: "hr.resume.parse.v1",
      type: "hr.resume.parse",
      tenantId,
      input: { resumeText: String(text).slice(0, MAX_RESUME_CHARS) },
      correlationId,
    });
  } catch (err) {
    // The plane is unreachable/unconfigured — record the degraded attempt
    // (§7.4: status/failure reason is provenance too) and rethrow the typed 503.
    await recordInference({
      kind: "resume-parse",
      promptKey: "hr.resume.parse.v1",
      inputHash,
      status: "degraded-unavailable",
      errorMessage: `${err?.code ?? ""} ${err?.message ?? err}`
        .trim()
        .slice(0, 500),
      tenantId,
      candidateId,
    }).catch(() => {});
    throw err;
  }

  const output = res?.output ?? {};
  const modelResp = output?.result ?? {};

  const provenance = {
    taskId: res.taskId,
    provider: output.provider ?? null,
    model: output.model ?? null,
    promptKey: "hr.resume.parse.v1",
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
      status: res.status === "pending" ? "pending" : "error",
      errorMessage: String(res.error ?? "plane returned non-ok status").slice(
        0,
        500,
      ),
      tokensUsed: res.tokensUsed ?? null,
      traceId: res.taskId,
      tenantId,
      candidateId,
    }).catch(() => {});
    throw Object.assign(
      new Error(`AI plane parse failed: ${res.error ?? res.status}`),
      {
        status: 502,
        code: "HR-RESUME-PLANE-FAILED",
        details: { taskId: res.taskId },
      },
    );
  }

  const parsed = modelResp && typeof modelResp === "object" ? modelResp : {};

  const skills = (Array.isArray(parsed.skills) ? parsed.skills : [])
    .map((s) => normItem(s, "skill"))
    .filter(Boolean);
  const competencies = (
    Array.isArray(parsed.competencies) ? parsed.competencies : []
  )
    .map((s) => normItem(s, "competency"))
    .filter(Boolean);
  const certifications = (
    Array.isArray(parsed.certifications) ? parsed.certifications : []
  )
    .map(normCert)
    .filter(Boolean);

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
    yearsOfExperience:
      parsed.yearsOfExperience != null &&
      parsed.yearsOfExperience !== "" &&
      Number.isFinite(Number(parsed.yearsOfExperience)) &&
      Number(parsed.yearsOfExperience) >= 0
        ? Math.min(80, Number(parsed.yearsOfExperience))
        : null,
    model: provenance.model,
    provider: provenance.provider,
    aiProvenance: provenance,
    charsAnalyzed: Math.min(text.length, MAX_RESUME_CHARS),
  };
}

// §7.4 — persist one provenance row. Deliberately best-effort: a provenance
// ledger write must never break the parse it is auditing.
async function recordInference(data) {
  try {
    await tenantTransaction(
      prisma,
      async (db) => {
        if (data.candidateId) {
          await db.$queryRawUnsafe(
            'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
            data.candidateId,
            data.tenantId,
          );
          if (
            !(await db.candidate.findFirst({
              where: {
                id: data.candidateId,
                tenantId: data.tenantId,
                anonymizedAt: null,
              },
            }))
          )
            return;
          await assertCommunicationsAllowed(
            {
              tenantId: data.tenantId,
              candidateId: data.candidateId,
              purpose: "PROCESSING",
              requireExplicitConsent: true,
            },
            { db },
          );
        }
        await db.aiInferenceRecord.create({ data });
      },
      { tenantId: data.tenantId },
    );
  } catch (err) {
    logger.warn(
      { err: err?.message },
      "resume: ai_inference_records write failed (best-effort)",
    );
  }
}

// Download a resume asset from DAM and parse it (no DB writes).
// Phase 6 / §4.5a — the ledger-driven parse entrypoint. EVERY parse goes
// through here (both ingestion kinds and the preview), so the content-hash
// cache and the three-attempt ceiling are the only behaviour, not one surface
// among several. The retry decision itself is pure policy (lib/parseRetry.js);
// this wrapper owns: the DAM fetch, the hash, the ledger row, and the
// attempt-loop that respects the backoff.
export async function parseResumeWithRetry(
  mediaId,
  {
    kind = "CANDIDATE",
    tenantId = null,
    candidateId = null,
    force = false,
  } = {},
  {
    download = downloadDamAssetBuffer,
    extract = extractResumeText,
    parseText = parseResumeText,
  } = {},
) {
  if (!tenantId)
    throw Object.assign(new Error("Verified tenant required"), {
      status: 403,
      code: "HR-5901",
    });
  const dl = await download(mediaId);
  if (!dl?.buffer)
    throw Object.assign(new Error("Resume download unavailable"), {
      status: 502,
      code: "HR-RESUME-DAM-FETCH",
    });
  const contentHash = hashResumeContent(dl.buffer),
    leaseToken = randomUUID(),
    now = new Date();
  const acquired = await tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        tenantId + ":" + kind + ":" + contentHash,
      );
      const prior = await db.resumeParseAttempt.findUnique({
        where: { tenantId_kind_contentHash: { tenantId, kind, contentHash } },
      });
      const running =
        prior?.status === "RUNNING" &&
        prior.leaseUntil &&
        prior.leaseUntil > now;
      const decision = decideParse({
        priorAttempt: force && !running ? null : prior,
        contentHash,
        now,
      });
      if (decision.action === "SKIP") return { cached: prior.parsedJson };
      if (running || decision.action === "RETRY_LATER")
        throw Object.assign(new Error("Resume parsing is already scheduled"), {
          status: 429,
          code: "HR-RESUME-BACKOFF",
          details: {
            retryAfterMs: running ? prior.leaseUntil - now : decision.waitMs,
          },
        });
      if (decision.action === "EXHAUSTED")
        throw Object.assign(
          new Error("Resume parsing requires recruiter review"),
          { status: 429, code: "HR-RESUME-ATTEMPTS-EXHAUSTED" },
        );
      return {
        row: await db.resumeParseAttempt.upsert({
          where: { tenantId_kind_contentHash: { tenantId, kind, contentHash } },
          create: {
            tenantId,
            kind,
            contentHash,
            mediaId: Number(mediaId),
            status: "RUNNING",
            attemptCount: 1,
            leaseToken,
            leaseUntil: new Date(now.getTime() + 5 * 60000),
          },
          update: {
            status: "RUNNING",
            attemptCount: decision.attempt,
            leaseToken,
            leaseUntil: new Date(now.getTime() + 5 * 60000),
            lastError: null,
            parsedJson: null,
          },
        }),
      };
    },
    { tenantId },
  );
  if (acquired.cached) {
    recordResumeParse({ kind, outcome: "cache-hit" });
    return {
      mediaId: Number(mediaId),
      contentHash,
      fromCache: true,
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      ...acquired.cached,
    };
  }
  try {
    const text = await extract(dl.buffer, dl.mimeType, dl.fileName);
    const result = await parseText(text, {
      tenantId,
      candidateId,
      correlationId: contentHash,
    });
    const completed = await tenantTransaction(
      prisma,
      async (db) => {
        if (candidateId) {
          await db.$queryRawUnsafe(
            'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
            candidateId,
            tenantId,
          );
          const candidate = await db.candidate.findFirst({
            where: {
              id: candidateId,
              tenantId,
              anonymizedAt: null,
              status: "active",
              resumeMediaId: Number(mediaId),
            },
          });
          if (!candidate) {
            await db.resumeParseAttempt.deleteMany({
              where: { id: acquired.row.id, leaseToken },
            });
            return false;
          }
          await assertCommunicationsAllowed(
            {
              tenantId,
              candidateId,
              purpose: "PROCESSING",
              requireExplicitConsent: true,
            },
            { db },
          );
        }
        const written = await db.resumeParseAttempt.updateMany({
          where: {
            id: acquired.row.id,
            tenantId,
            leaseToken,
            status: "RUNNING",
          },
          data: {
            status: "COMPLETED",
            parsedJson: result,
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        return written.count === 1;
      },
      { tenantId },
    );
    if (!completed)
      throw Object.assign(
        new Error("Resume ownership or parse lease changed"),
        { status: 409, code: "HR-5901" },
      );
    recordResumeParse({ kind, outcome: "ok" });
    return {
      mediaId: Number(mediaId),
      contentHash,
      fromCache: false,
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      ...result,
    };
  } catch (error) {
    await prisma.resumeParseAttempt.updateMany({
      where: { id: acquired.row.id, tenantId, leaseToken, status: "RUNNING" },
      data: {
        status: "FAILED",
        lastError: isRetryableFailure(error)
          ? String(error.code || "HR-RESUME-PLANE-FAILED").slice(0, 100)
          : "HR-RESUME-PERMANENT",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    recordResumeParse({ kind, outcome: "failed" });
    throw error;
  }
}

export async function parseResumePreview(mediaId, { tenantId = null } = {}) {
  return parseResumeWithRetry(mediaId, { kind: "CANDIDATE", tenantId });
}

/**
 * Parse a resume and persist to an EMPLOYEE:
 *  - Skill (catalog) upsert by name + category, EmployeeSkill upsert w/ score+level+source
 *  - Certification records (deduped by name for the employee)
 */
export async function ingestEmployeeResume({
  employeeId,
  mediaId,
  tenantId = null,
  actorId = null,
}) {
  const id = Number(employeeId);
  const employee = await prisma.employee.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true, tenant_id: true },
  });
  if (!employee)
    throw Object.assign(new Error("Employee not found"), { status: 404 });
  const tenant = tenantId ?? employee.tenant_id ?? null;

  const parsed = await parseResumeWithRetry(mediaId, {
    kind: "EMPLOYEE",
    tenantId: tenant,
  });
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
      update: {
        proficiency: item.level,
        level: item.level,
        score: item.score,
        source: "ai-resume",
      },
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
    {
      employeeId: id,
      mediaId,
      skills: skillsWritten.length,
      certs: certsWritten.length,
      actorId,
    },
    "resume: ingested into employee",
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

/**
 * Parse a resume and persist to a CANDIDATE:
 *  - CandidateSkill rows (self-contained), upserted by (candidateId, name)
 *  - Candidate.parsedResume JSON snapshot (incl. certifications)
 */
export async function ingestCandidateResume(args) {
  const { requestCandidateResumeParse } =
    await import("./candidateResumeQueue.service.js");
  return requestCandidateResumeParse(args);
}
