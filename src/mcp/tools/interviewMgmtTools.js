// src/mcp/tools/interviewMgmtTools.js
//
// MCP facade for the HR "Interview Management" screen: shaped list/detail rows
// (candidate + role + interviewers + averaged ratings), the FEEDBACK write
// (per-reviewer scorecard upsert) and the interview OUTCOME write (decision +
// COMPLETED). All gated on hr:recruitment (deny-by-default) and tenant-scoped
// via the verified ctx tenant. Complements the existing schedule/update tools
// (hr_interview_create / hr_interview_update / hr_interviews_list).
import { z } from "zod";
import {
  listInterviewsManaged,
  getInterviewManaged,
  scoreInterview,
  setInterviewOutcome,
} from "../../services/interviewMgmt.service.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const ratingsSchema = z.object({
  technicalSkills: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  problemSolving: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  communication: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  cultureFit: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
});

export function registerInterviewMgmtTools(server) {
  server.tool(
    "hr_interviews_manage_list",
    "List interviews for the HR Interview Management screen: candidate, role, interviewers, status/decision, schedule and ratings averaged across scorecards. Supports candidate-name search, status/interviewType/decision filters, scheduledAt sort and pagination.",
    {
      q: z.string().optional().describe("Search by candidate name"),
      status: z.string().optional().describe("SCHEDULED | COMPLETED | CANCELLED | NO_SHOW"),
      interviewType: z.string().optional().describe("PHONE_SCREEN | TECHNICAL | BEHAVIORAL | PANEL | FINAL | ONSITE | VIDEO"),
      decision: z.string().optional().describe("NEXT_ROUND | HOLD | REJECTED"),
      sort: z.string().optional().describe("Sort field (default scheduledAt)"),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listInterviewsManaged({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interviews_manage_list")
  );

  server.tool(
    "hr_interview_manage_get",
    "Get full detail for a single interview incl. per-reviewer scorecards for the HR Interview Management screen.",
    {
      id: z.union([z.string(), z.number()]).describe("Interview id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getInterviewManaged({ id, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_manage_get")
  );

  server.tool(
    "hr_interview_score",
    "Submit interview feedback: upsert the caller's scorecard (ratings, overall score, recommendation, comments) and set the interview decision/outcome.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id (references Interview)"),
      ratings: ratingsSchema.describe("Scorecard ratings; each of technicalSkills, problemSolving, communication, cultureFit is an integer 1-5. Stored as the NOT-NULL scores JSON; overallScore is their average."),
      decision: z.enum(["NEXT_ROUND", "HOLD", "REJECTED"]).describe("Interview outcome decision — one of NEXT_ROUND | HOLD | REJECTED"),
      recommendation: z.enum(["STRONG_HIRE", "HIRE", "HOLD", "REJECTED"]).describe("Reviewer recommendation — one of STRONG_HIRE | HIRE | HOLD | REJECTED"),
      comments: z.string().optional().describe("Free-text reviewer comments (stored as the scorecard notes)"),
      reviewerId: z.coerce.number().int().positive().optional().describe("Reviewer employee id (references Employee); defaults to the caller's employeeId. Provide when the caller has no employeeId (e.g. an admin scoring on someone's behalf) — the service 400s if neither is present."),
    },
    withToolError(async ({ interviewId, ratings, decision, recommendation, comments, reviewerId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      await scoreInterview({
        interviewId,
        reviewerId: reviewerId ?? user.employeeId,
        ratings,
        recommendation,
        comments,
        tenantId: user.tenantId,
      });
      const data = await setInterviewOutcome({ interviewId, decision, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_score")
  );

  server.tool(
    "hr_interview_set_outcome",
    "Set an interview outcome decision (and mark it COMPLETED).",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id (references Interview)"),
      decision: z.enum(["NEXT_ROUND", "HOLD", "REJECTED"]).describe("Interview outcome decision — one of NEXT_ROUND | HOLD | REJECTED; setting it also marks the interview COMPLETED"),
    },
    withToolError(async ({ interviewId, decision }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await setInterviewOutcome({ interviewId, decision, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_set_outcome")
  );
}
