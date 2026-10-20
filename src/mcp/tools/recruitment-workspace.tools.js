// src/mcp/tools/recruitment-workspace.tools.js
//
// Recruitment Phase 3a — the interviewer and hiring manager workspaces over
// MCP. Both are reads (GET on hr:recruitment) cut by the caller's recruitment
// scope; recruitment-workspace.service.js holds the rules.
//
//   * hr_interview_workspace_get: the caller's own panels (upcoming and recent
//     14 days), packet summary, own scorecard state, and the decision prompts
//     addressed to the caller as a hiring manager.
//   * hr_requisition_manager_workspace_get: the caller's requisitions (MANAGED),
//     or the tenant's / one manager's (ORG, managerEmployeeId), with stage
//     counts, shortlist proposals, interviews awaiting a decision and offers
//     awaiting the hiring manager's approval.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { getInterviewerWorkspace, getManagerWorkspace } from "../../services/recruitment-workspace.service.js";

const RESOURCE = "hr:recruitment";
const id = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);

function authorize(method) {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  assertPermission(ctx.permissions, method, RESOURCE, ctx.user.isAdmin);
  return { user: ctx.user, scope: resolveRecruitmentScope(ctx.user) };
}

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerRecruitmentWorkspaceTools(server) {
  server.tool(
    "hr_interview_workspace_get",
    "Get your interviewer workspace: the interviews you sit on in the next and last 14 days (requisition, candidate name, time, duration, location, packet item count and packet item ids, your scorecard state NOT_STARTED/DRAFT/SUBMITTED, and whether other panelists' scorecards are visible to you, which is only after yours is submitted), plus the decision prompts addressed to you as the hiring manager. No document contents.",
    {
      limit: z.coerce.number().int().positive().max(100).optional().describe("Rows per section (default 50, max 100)"),
    },
    withToolError(async ({ limit }) => {
      const { user, scope } = authorize("GET");
      const data = await getInterviewerWorkspace({ tenantId: user.tenantId, scope, limit });
      return json(data);
    }, "hr_interview_workspace_get"),
  );

  server.tool(
    "hr_requisition_manager_workspace_get",
    "Get the hiring manager workspace: your requisitions (paginated, open ones by default) with application counts by stage, pending fit-score shortlist proposals and interviews awaiting your decision; the shortlist proposals themselves (internal notes masked by scope); interviews whose whole panel has submitted and that have no decision; and offers awaiting the hiring manager approval step. Recruiters may pass managerEmployeeId to see one manager's workspace.",
    {
      managerEmployeeId: id.optional().describe("Recruiters only: show this hiring manager's requisitions"),
      status: z.string().max(32).optional().describe("Requisition status filter (DRAFT, PENDING_APPROVAL, APPROVED, POSTED, REJECTED, CLOSED, WITHDRAWN or ALL; default the open ones)"),
      page: z.coerce.number().int().positive().optional().describe("Requisition page (default 1)"),
      pageSize: z.coerce.number().int().positive().max(100).optional().describe("Requisitions per page (default 20, max 100)"),
      listLimit: z.coerce.number().int().positive().max(100).optional().describe("Rows per other section (default 25, max 100)"),
    },
    withToolError(async ({ managerEmployeeId, status, page, pageSize, listLimit }) => {
      const { user, scope } = authorize("GET");
      const data = await getManagerWorkspace({
        tenantId: user.tenantId,
        scope,
        managerEmployeeId: managerEmployeeId != null ? Number(managerEmployeeId) : null,
        status,
        page,
        pageSize,
        listLimit,
      });
      return json(data);
    }, "hr_requisition_manager_workspace_get"),
  );
}

export default registerRecruitmentWorkspaceTools;
