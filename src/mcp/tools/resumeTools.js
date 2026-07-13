import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  parseResumePreview,
  ingestEmployeeResume,
  ingestCandidateResume,
} from "../../services/resumeParsing.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// AI resume parsing tools. The resume service loads openai / pdf-parse / mammoth
// LAZILY, so these tools degrade to a clear error if a dep or the API key is
// missing, without affecting the rest of the HR MCP surface.
export function registerResumeTools(server) {
  server.tool(
    "hr_resume_parse_preview",
    "Parse a resume (DAM media asset) with AI and PREVIEW extracted skills, competencies (each rated 0-100 + level) and certifications — no data is saved",
    { resumeMediaId: z.union([z.string(), z.number()]).describe("DAM asset id of the resume file (pdf/docx/txt)") },
    withToolError(async ({ resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await parseResumePreview(resumeMediaId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_resume_parse_preview")
  );

  server.tool(
    "hr_resume_employee_ingest",
    "Parse a resume and save the results to an EMPLOYEE: skills + competencies (Skill/EmployeeSkill with score & level) and certifications",
    {
      employeeId: z.union([z.string(), z.number()]).describe("Employee ID"),
      resumeMediaId: z.union([z.string(), z.number()]).describe("DAM asset id of the resume file"),
    },
    withToolError(async ({ employeeId, resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await ingestEmployeeResume({
        employeeId,
        mediaId: resumeMediaId,
        tenantId: user.tenantId ?? null,
        actorId: user.employeeId || user.userId,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_resume_employee_ingest")
  );

  server.tool(
    "hr_resume_candidate_ingest",
    "Parse a resume and save the results to a recruitment CANDIDATE: CandidateSkill rows (skills + competencies with score & level) and a parsedResume snapshot",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate ID"),
      resumeMediaId: z.union([z.string(), z.number()]).optional().describe("DAM asset id; defaults to the candidate's resumeMediaId"),
    },
    withToolError(async ({ candidateId, resumeMediaId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await ingestCandidateResume({
        candidateId,
        mediaId: resumeMediaId,
        tenantId: user.tenantId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_resume_candidate_ingest")
  );
}
