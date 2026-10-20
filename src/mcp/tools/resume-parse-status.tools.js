// src/mcp/tools/resume-parse-status.tools.js
//
// Phase 2 — the asynchronous resume parse, seen from the recruiter's side:
//   * hr_candidate_resume_parse_status (GET): the candidate's parse state,
//     attempts, the next attempt time and the last error CODE (the stored
//     error text can quote plane output, so it is never returned). Any scope
//     that can reach the candidate (candidateScopeWhere).
//   * hr_candidate_resume_parse_retry (POST, recruiters only): put the current
//     resume back on the queue. A resume whose three attempts are spent is
//     refused unless force is set; force resets the ceiling for that content.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
  getCandidateResumeParseStatus,
  requeueCandidateResumeParse,
} from "../../services/resume-parse-queue.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerResumeParseStatusTools(server) {
  server.tool(
    "hr_candidate_resume_parse_status",
    "A candidate's resume parse status: PENDING/RUNNING/COMPLETED/FAILED/EXHAUSTED, attempts used of the three allowed, when the next attempt is due and the last error code",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate id"),
    },
    withToolError(async ({ candidateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getCandidateResumeParseStatus({
        tenantId: user.tenantId,
        candidateId,
        scope: resolveRecruitmentScope(user),
      });
      return text(data);
    }, "hr_candidate_resume_parse_status"),
  );

  server.tool(
    "hr_candidate_resume_parse_retry",
    "Re-queue a candidate's current resume for parsing (recruiters only). Refused when its three attempts are spent unless force is true, which resets them",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate id"),
      force: z.boolean().optional().default(false).describe("Reset the attempt ceiling (and any cached parse) for this resume"),
    },
    withToolError(async ({ candidateId, force }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await requeueCandidateResumeParse({
        tenantId: user.tenantId,
        candidateId,
        scope: resolveRecruitmentScope(user),
        force: force === true,
      });
      return text(data);
    }, "hr_candidate_resume_parse_retry"),
  );
}
