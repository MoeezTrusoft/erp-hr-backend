// src/services/resumeParsing.service.js — AI resume parsing (HR-RESUME).
//
// On resume upload (a DAM media asset) extract & rate skills + competencies and
// extract certifications via OpenAI, then persist:
//   * Employees  → Skill (catalog, category 'skill'|'competency') + EmployeeSkill
//                  (score 0-100 + level) + Certification records.
//   * Candidates → CandidateSkill rows (self-contained) + Candidate.parsedResume.
//
// ALL AI/parse imports are LAZY (dynamic import inside functions) so a missing
// optional dependency (openai / pdf-parse / mammoth) or a missing OPENAI_API_KEY
// only breaks the resume tools — core HR keeps working. The reference pattern is
// erp-project-management-backend (openai@^6, responses API, JSON mode).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";

const OPENAI_MODEL = process.env.OPENAI_RESUME_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_RESUME_CHARS = parseInt(process.env.RESUME_MAX_CHARS || "24000", 10);
// RES-2: the OpenAI call was effectively unbounded. openai@^6 exposes a
// client-level `timeout` (ms) that governs each request (and can be overridden
// per-request); we set it on the client and pass it again on responses.create as
// a belt-and-braces deadline. Default 30s.
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "30000", 10);
const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];

const depError = (pkg) =>
  Object.assign(new Error(`Optional dependency "${pkg}" is not installed — resume parsing is unavailable`), {
    status: 501,
    code: "HR-RESUME-DEP-MISSING",
  });

async function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY is not configured"), { status: 503, code: "HR-RESUME-NO-KEY" });
  }
  let OpenAI;
  try {
    ({ default: OpenAI } = await import("openai"));
  } catch {
    throw depError("openai");
  }
  return new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 2 });
}

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

const buildPrompt = (text) =>
  `You are an expert technical recruiter and HR analyst. Read the RESUME below and extract:
1) "skills" — concrete technical/tool/language skills (e.g. "Node.js", "PostgreSQL", "Kubernetes").
2) "competencies" — soft/behavioral/leadership competencies (e.g. "Team Leadership", "Stakeholder Management").
3) "certifications" — professional certifications only (not degrees).

For EACH skill and competency, rate the candidate's demonstrated proficiency from the evidence in the resume:
- "score": integer 0-100.
- "level": one of exactly "Beginner", "Intermediate", "Advanced", "Expert".
Be conservative: only rate what the resume supports; do not invent items.

Return ONLY a JSON object with this exact shape (no prose):
{
  "skills": [ { "name": "string", "score": 0, "level": "Beginner" } ],
  "competencies": [ { "name": "string", "score": 0, "level": "Beginner" } ],
  "certifications": [ { "name": "string", "issuer": "string|null", "issuedDate": "YYYY-MM|YYYY-MM-DD|null", "expiryDate": "YYYY-MM|YYYY-MM-DD|null", "credentialId": "string|null" } ]
}

RESUME:
"""
${text.slice(0, MAX_RESUME_CHARS)}
"""`;

// Call OpenAI (responses API, JSON mode) and normalize the output.
async function parseResumeText(text) {
  if (!text || text.length < 20) {
    return { skills: [], competencies: [], certifications: [], warning: "resume text was empty or too short" };
  }
  const client = await getOpenAIClient();
  const response = await client.responses.create(
    {
      model: OPENAI_MODEL,
      input: buildPrompt(text),
      text: { format: { type: "json_object" } },
      temperature: 0.2,
      max_output_tokens: 3000,
    },
    { timeout: OPENAI_TIMEOUT_MS } // RES-2: per-request deadline (belt-and-braces alongside the client timeout)
  );

  let parsed = {};
  try {
    parsed = JSON.parse(response.output_text || "{}");
  } catch (err) {
    logger.error({ err: err?.message }, "resume: failed to parse OpenAI JSON output");
    throw Object.assign(new Error("AI returned malformed JSON"), { status: 502, code: "HR-RESUME-BAD-JSON" });
  }

  const skills = (Array.isArray(parsed.skills) ? parsed.skills : []).map((s) => normItem(s, "skill")).filter(Boolean);
  const competencies = (Array.isArray(parsed.competencies) ? parsed.competencies : [])
    .map((s) => normItem(s, "competency"))
    .filter(Boolean);
  const certifications = (Array.isArray(parsed.certifications) ? parsed.certifications : [])
    .map(normCert)
    .filter(Boolean);

  return {
    skills,
    competencies,
    certifications,
    model: OPENAI_MODEL,
    charsAnalyzed: Math.min(text.length, MAX_RESUME_CHARS),
  };
}

// Download a resume asset from DAM and parse it (no DB writes).
export async function parseResumePreview(mediaId) {
  const dl = await downloadDamAssetBuffer(mediaId);
  if (!dl?.buffer) {
    throw Object.assign(new Error(`Could not download resume asset ${mediaId} from DAM`), {
      status: 502,
      code: "HR-RESUME-DAM-FETCH",
    });
  }
  const text = await extractResumeText(dl.buffer, dl.mimeType, dl.fileName);
  const result = await parseResumeText(text);
  return { mediaId: Number(mediaId), fileName: dl.fileName, mimeType: dl.mimeType, ...result };
}

/**
 * Parse a resume and persist to an EMPLOYEE:
 *  - Skill (catalog) upsert by name + category, EmployeeSkill upsert w/ score+level+source
 *  - Certification records (deduped by name for the employee)
 */
export async function ingestEmployeeResume({ employeeId, mediaId, tenantId = null, actorId = null }) {
  const id = Number(employeeId);
  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true, tenant_id: true } });
  if (!employee) throw Object.assign(new Error("Employee not found"), { status: 404 });
  const tenant = tenantId ?? employee.tenant_id ?? null;

  const parsed = await parseResumePreview(mediaId);
  const items = [...parsed.skills, ...parsed.competencies];

  const skillsWritten = [];
  for (const item of items) {
    // Skill catalog is globally unique by name; set/refresh its category.
    const skill = await prisma.skill.upsert({
      where: { name: item.name },
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

/**
 * Parse a resume and persist to a CANDIDATE:
 *  - CandidateSkill rows (self-contained), upserted by (candidateId, name)
 *  - Candidate.parsedResume JSON snapshot (incl. certifications)
 */
export async function ingestCandidateResume({ candidateId, mediaId, tenantId = null }) {
  const id = Number(candidateId);
  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: { id: true, tenantId: true, resumeMediaId: true },
  });
  if (!candidate) throw Object.assign(new Error("Candidate not found"), { status: 404 });
  const tenant = tenantId ?? candidate.tenantId ?? null;
  const resumeMediaId = mediaId ?? candidate.resumeMediaId;
  if (!resumeMediaId) throw Object.assign(new Error("Candidate has no resumeMediaId to parse"), { status: 400 });

  const parsed = await parseResumePreview(resumeMediaId);
  const items = [...parsed.skills, ...parsed.competencies];

  for (const item of items) {
    await prisma.candidateSkill.upsert({
      where: { candidateId_name: { candidateId: id, name: item.name } },
      create: {
        candidateId: id,
        name: item.name,
        category: item.category,
        score: item.score,
        level: item.level,
        source: "ai-resume",
        tenantId: tenant,
      },
      update: { category: item.category, score: item.score, level: item.level, source: "ai-resume" },
    });
  }

  await prisma.candidate.update({
    where: { id },
    data: {
      parsedResume: {
        mediaId: Number(resumeMediaId),
        model: parsed.model,
        skills: parsed.skills,
        competencies: parsed.competencies,
        certifications: parsed.certifications,
      },
    },
  });

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
  };
}
