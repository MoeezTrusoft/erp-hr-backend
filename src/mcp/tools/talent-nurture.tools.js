// src/mcp/tools/talent-nurture.tools.js — Recruitment Phase 5 / plan 6.2.
//
// The recruiter's side of talent pool nurture: the proposals the nightly job
// builds for posted requisitions, and the decision on each.
//
// Who may do what (hr:recruitment, deny by default):
//   * list / get (GET): cut to the requisitions the caller can see
//     (requisitionScopeWhere) — a hiring manager reads their own requisitions'
//     proposals; FINANCE, AGENCY and interviewers see none. An out-of-scope run
//     is not found, never forbidden.
//   * send / dismiss (PUT): ORG (recruiters) only. Sending is the decision to
//     contact people, so it is a recruiter's.
// Every tool answers 503 HR-RECRUITMENT-TALENT-NURTURE-DISABLED with the
// talentNurture flag off.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { NURTURE_RUN_STATUSES, MAX_DISMISS_REASON_LENGTH } from "../../lib/talent-nurture.util.js";
import {
  dismissNurtureRun,
  getNurtureRun,
  listNurtureRuns,
  sendNurtureRun,
} from "../../services/talent-nurture.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);

export function registerTalentNurtureTools(server) {
  server.tool(
    "hr_talent_nurture_runs_list",
    "List talent pool nurture proposals (one per posted requisition: the pool members whose skills and location match it), newest first, filtered by status (PROPOSED | SENT | DISMISSED | EXPIRED) and requisition, limited to the requisitions you can see",
    {
      status: z.enum(NURTURE_RUN_STATUSES).optional().describe("Filter by run status"),
      requisitionId: idInput.optional().describe("Only this requisition's proposal"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 20, max 100)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listNurtureRuns({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        status: args.status ?? null,
        requisitionId: args.requisitionId ?? null,
        page: args.page,
        limit: args.limit,
      });
      return text(data);
    }, "hr_talent_nurture_runs_list"),
  );

  server.tool(
    "hr_talent_nurture_run_get",
    "Get one talent pool nurture proposal with its criteria, why pool members were excluded, and each matched member's talent pool display data (name, location, experience, skills, pools), plus their invitation and application once sent",
    {
      runId: idInput.describe("Nurture run id"),
    },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getNurtureRun({ tenantId: user.tenantId, scope: resolveRecruitmentScope(user), runId });
      return text(data);
    }, "hr_talent_nurture_run_get"),
  );

  server.tool(
    "hr_talent_nurture_run_send",
    "Approve a PROPOSED talent pool nurture run and invite its members to apply (recruiters only). Drop members first with dropCandidateIds; each invitation is valid for validityDays (default 30). Idempotent: sending a SENT run returns what was sent.",
    {
      runId: idInput.describe("Nurture run id"),
      dropCandidateIds: z.array(idInput).max(500).optional().describe("Proposed members not to invite"),
      validityDays: z.coerce.number().int().min(1).max(365).optional().describe("Invitation validity in days (default: the run's, 30)"),
    },
    withToolError(async ({ runId, dropCandidateIds, validityDays }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const scope = resolveRecruitmentScope(user);
      const data = await sendNurtureRun({
        tenantId: user.tenantId,
        scope,
        runId,
        dropCandidateIds: dropCandidateIds ?? [],
        validityDays,
        actorId: scope.employeeId,
      });
      return text(data);
    }, "hr_talent_nurture_run_send"),
  );

  server.tool(
    "hr_talent_nurture_run_dismiss",
    "Dismiss a PROPOSED talent pool nurture run without inviting anyone (recruiters only), with a reason",
    {
      runId: idInput.describe("Nurture run id"),
      reason: z.string().min(1).max(MAX_DISMISS_REASON_LENGTH).describe("Why the proposal is dismissed"),
    },
    withToolError(async ({ runId, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const scope = resolveRecruitmentScope(user);
      const data = await dismissNurtureRun({
        tenantId: user.tenantId,
        scope,
        runId,
        reason,
        actorId: scope.employeeId,
      });
      return text(data);
    }, "hr_talent_nurture_run_dismiss"),
  );
}
