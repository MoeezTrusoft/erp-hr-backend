import { z } from "zod";
import { requireEmployeeActor } from "../../lib/employeeActor.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  parseResumePreview,
  ingestEmployeeResume,
  ingestCandidateResume,
} from "../../services/resumeParsing.service.js";
import { matchCandidateToRequisitionAdvisory } from "../../services/candidateMatch.service.js";
import {
  reconcileParsedSkillsPreview,
  createAliasSuggestions,
} from "../../services/skillTaxonomy.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user)
    throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// AI resume parsing tools. The resume service loads openai / pdf-parse / mammoth
// LAZILY, so these tools degrade to a clear error if a dep or the API key is
// missing, without affecting the rest of the HR MCP surface.
export function registerResumeTools(server) {
  server.tool(
    "hr_resume_parse_preview",
    "Parse a resume (DAM media asset) with AI and PREVIEW extracted skills, competencies (each rated 0-100 + level) and certifications — no data is saved",
    {
      resumeMediaId: z
        .union([z.string(), z.number()])
        .describe("DAM asset id of the resume file (pdf/docx/txt)"),
    },
    withToolError(async ({ resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      // The plane requires a tenantId (per-tenant token ceiling keying).
      const data = await parseResumePreview(resumeMediaId, {
        tenantId: user.tenantId ?? null,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_resume_parse_preview"),
  );

  server.tool(
    "hr_resume_employee_ingest",
    "Parse a resume and save the results to an EMPLOYEE: skills + competencies (Skill/EmployeeSkill with score & level) and certifications",
    {
      employeeId: z.union([z.string(), z.number()]).describe("Employee ID"),
      resumeMediaId: z
        .union([z.string(), z.number()])
        .describe("DAM asset id of the resume file"),
    },
    withToolError(async ({ employeeId, resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await ingestEmployeeResume({
        employeeId,
        mediaId: resumeMediaId,
        tenantId: user.tenantId ?? null,
        actorId: await requireEmployeeActor(user),
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_resume_employee_ingest"),
  );

  server.tool(
    "hr_resume_candidate_ingest",
    "Queue a consent-checked resume parse for the candidate; returns job status while a background worker extracts skills and evidence",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate ID"),
      resumeMediaId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("DAM asset id; defaults to the candidate's resumeMediaId"),
    },
    withToolError(async ({ candidateId, resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await ingestCandidateResume({
        candidateId,
        mediaId: resumeMediaId,
        tenantId: user.tenantId ?? null,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_resume_candidate_ingest"),
  );

  // ── Phase 13 / §7 — AI ADVISORY tools ────────────────────────────────────
  // §7.3: none of these mutate application state — they return evidence for a
  // human decision. §7.3b: recruiter/hiring-manager surfaces only; the report
  // carries no ranking or overall score, so there is nothing to anchor an
  // interviewer's independent scorecard.

  server.tool(
    "hr_candidate_match",
    "ADVISORY candidate↔requisition fit report: taxonomy-anchored matched/missing skills plus an optional AI summary (ai=true). Evidence only — no hiring decision is made or implied",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate ID"),
      requisitionId: z
        .union([z.string(), z.number()])
        .describe("Requisition ID"),
      ai: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also request the AI plane's advisory summary (slower; needs the plane configured)",
        ),
    },
    withToolError(async ({ candidateId, requisitionId, ai }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await matchCandidateToRequisitionAdvisory({
        candidateId,
        requisitionId,
        tenantId: user.tenantId ?? null,
        withAiSummary: !!ai,
        actorId: user.id ?? null,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_candidate_match"),
  );

  server.tool(
    "hr_skills_reconcile",
    "Reconcile a candidate's parsed resume skills onto the canonical skills taxonomy: mapped items, unmapped leftovers, and optional alias suggestions (suggestions=true). Read-only",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate ID"),
      suggestions: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include AI-alias suggestions for unmapped items"),
    },
    withToolError(async ({ candidateId, suggestions }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await reconcileParsedSkillsPreview({
        candidateId,
        tenantId: user.tenantId ?? null,
        withSuggestions: !!suggestions,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_skills_reconcile"),
  );

  server.tool(
    "hr_skill_alias_suggest",
    "Approve reviewed skill-alias suggestions for the tenant taxonomy; requires a verified HR administrator and a tenant-visible canonical skill",
    {
      suggestions: z
        .array(
          z.object({
            alias: z.string().min(1),
            skillId: z.union([z.string(), z.number()]),
          }),
        )
        .min(1)
        .describe("Alias suggestions to record"),
    },
    withToolError(async ({ suggestions }) => {
      const { user, permissions } = getCtx();
      // Curation-adjacent write: same action as other taxonomy admin writes.
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await createAliasSuggestions({
        suggestions,
        tenantId: user.tenantId ?? null,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, data }) },
        ],
      };
    }, "hr_skill_alias_suggest"),
  );
}
