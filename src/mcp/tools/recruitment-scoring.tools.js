// src/mcp/tools/recruitment-scoring.tools.js
//
// Recruitment Phase 2 (§6.4) — fit score, requisition ranking and shortlist
// proposals over MCP. Every tool answers 503 HR-RECRUITMENT-SCORING-DISABLED
// while HR_RECRUITMENT_SCORING is off.
//
// Scope: reads and proposal actions are for recruiters (ORG) and the
// requisition's own hiring manager (MANAGED); every other scope reads not
// found (application-scoring.service.js explains why interviewers never see
// a score). Permission resource is hr:recruitment with HTTP methods.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
  assertScoringEnabled,
  confirmShortlistProposal,
  dismissShortlistProposal,
  getApplicationScore,
  listRequisitionRanking,
  proposeShortlist,
} from "../../services/application-scoring.service.js";

const id = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Flag first, then permission: a disabled feature answers the same 503 to
// everyone.
function authorize(method) {
  assertScoringEnabled();
  const ctx = getCtx();
  assertPermission(ctx.permissions, method, "hr:recruitment", ctx.user.isAdmin);
  return { ...ctx, scope: resolveRecruitmentScope(ctx.user) };
}

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerRecruitmentScoringTools(server) {
  server.tool(
    "hr_application_score_get",
    "Get one application's fit score (0-100), band (STRONG/GOOD/FAIR/WEAK), model version and the explained components (required/preferred skill coverage, experience, screening answers, knockout). Recruiter or the requisition's hiring manager only.",
    { applicationId: id.describe("Application ID") },
    withToolError(async ({ applicationId }) => {
      const { user, scope } = authorize("GET");
      const data = await getApplicationScore({ tenantId: user.tenantId, applicationId, scope });
      return json(data);
    }, "hr_application_score_get"),
  );

  server.tool(
    "hr_requisition_rank_list",
    "List a requisition's scored active applications ranked by fit score (highest first, earlier application first on a tie), with rank, band, stage, candidate name and shortlist state. Paginated. Recruiter or the requisition's hiring manager only.",
    {
      requisitionId: id.describe("Requisition ID"),
      page: z.coerce.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.coerce.number().int().positive().max(100).optional().describe("Rows per page (default 25, max 100)"),
    },
    withToolError(async ({ requisitionId, page, pageSize }) => {
      const { user, scope } = authorize("GET");
      const result = await listRequisitionRanking({ tenantId: user.tenantId, requisitionId, scope, page, pageSize });
      return json(buildListPayload({
        items: result.items,
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        sort: "score",
        order: "desc",
        filters: { requisitionId: Number(requisitionId) },
      }));
    }, "hr_requisition_rank_list"),
  );

  server.tool(
    "hr_requisition_shortlist_propose",
    "Run the shortlist proposal for one requisition now: applications at or above the tenant's shortlist threshold, or in its top share of the ranking, are added to the shortlist as SCORING_PROPOSAL entries for a recruiter to confirm or dismiss. Never proposes an application twice, never proposes knocked-out or closed applications, never touches a recruiter's entries.",
    { requisitionId: id.describe("Requisition ID") },
    withToolError(async ({ requisitionId }) => {
      const { user, scope, correlationId } = authorize("POST");
      const data = await proposeShortlist({
        tenantId: user.tenantId,
        requisitionId,
        actorId: user.employeeId ?? null,
        scope,
        correlationId,
      });
      return json(data);
    }, "hr_requisition_shortlist_propose"),
  );

  server.tool(
    "hr_application_shortlist_proposal_confirm",
    "Confirm a pending fit-score shortlist proposal: the entry becomes a MANUAL shortlist entry attributed to you.",
    { applicationId: id.describe("Application ID") },
    withToolError(async ({ applicationId }) => {
      const { user, scope } = authorize("PUT");
      const data = await confirmShortlistProposal({
        tenantId: user.tenantId,
        applicationId,
        actorId: user.employeeId ?? null,
        scope,
      });
      return json(data);
    }, "hr_application_shortlist_proposal_confirm"),
  );

  server.tool(
    "hr_application_shortlist_proposal_dismiss",
    "Dismiss a pending fit-score shortlist proposal: the entry is removed and the application is not proposed again.",
    { applicationId: id.describe("Application ID") },
    withToolError(async ({ applicationId }) => {
      const { user, scope } = authorize("PUT");
      const data = await dismissShortlistProposal({
        tenantId: user.tenantId,
        applicationId,
        actorId: user.employeeId ?? null,
        scope,
      });
      return json(data);
    }, "hr_application_shortlist_proposal_dismiss"),
  );
}

export default registerRecruitmentScoringTools;
