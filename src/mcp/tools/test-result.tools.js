// src/mcp/tools/test-result.tools.js
//
// Recruitment Phase 3b — on-site test results and the recruiter's decision
// panel (plan 7.6 "Results", 7.3.6, 7.3.8).
//
// Who may do what (every tool asserts hr:recruitment with its HTTP method and
// answers 503 HR-RECRUITMENT-ONSITE-TEST-DISABLED while the flag is off):
//   * hr_test_result_get / hr_test_results_list: the test REPORT, for
//     recruiters, the requisition's hiring manager and the interview's
//     panelists (interviewScopeWhere). Anyone else, reception included, reads
//     not found / an empty list. Never an answer key or the item pool.
//   * hr_test_result_decide / hr_test_result_waive / hr_test_analytics_get:
//     recruiters only.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { assertAssessmentCapability, resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { RESULT_BAND } from "../../lib/test-band.util.js";
import { assertOnsiteTestEnabled } from "../../services/test-session.service.js";
import {
  decideTestResult,
  getTestAnalytics,
  getTestResultReport,
  listTestResults,
  waiveAssessment,
} from "../../services/test-result.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);

function authorized(method, capability = null) {
  assertOnsiteTestEnabled();
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  const access = resolveAssessmentAccess(user);
  if (capability) assertAssessmentCapability(access, capability);
  return { tenantId: user.tenantId, access, scope: access.scope, actorId: access.employeeId ?? null };
}

export function registerTestResultTools(server) {
  server.tool(
    "hr_test_result_get",
    "The on-site test report for a result (or an interview's latest result): score, band, section scores against their pass marks, competency chart data, time taken, percentile among the requisition's candidates, the integrity timeline, weak competencies with suggested probe questions, and the stems of items marked as discussion prompts. Never the answer key or the item pool. Recruiters, the requisition's manager and the interview's panelists.",
    {
      resultId: idInput.optional().describe("Result id"),
      interviewId: idInput.optional().describe("Interview id (its latest result)"),
    },
    withToolError(async ({ resultId, interviewId }) => {
      const { tenantId, scope } = authorized("GET");
      return text(await getTestResultReport({ tenantId, scope, resultId, interviewId }));
    }, "hr_test_result_get"),
  );

  server.tool(
    "hr_test_results_list",
    "On-site test results for a requisition or an interview (band, score, integrity flags, decision, validity), limited to the interviews you can see.",
    {
      requisitionId: idInput.optional().describe("Requisition id"),
      interviewId: idInput.optional().describe("Interview id"),
      band: z.enum(Object.values(RESULT_BAND)).optional().describe("Filter by band"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async (args) => {
      const { tenantId, scope } = authorized("GET");
      return text(await listTestResults({ ...args, tenantId, scope }));
    }, "hr_test_results_list"),
  );

  server.tool(
    "hr_test_result_decide",
    "Decide an on-site test result (recruiter only). PROCEED (recorded as OVERRIDE on a FAILED, REVIEW or INCOMPLETE result), RELEASE (cancels the interview with reason ASSESSMENT_NOT_PASSED and rejects the application with ASSESSMENT_BELOW_THRESHOLD, or ASSESSMENT_INTEGRITY for REVIEW; the candidate is emailed after the rejection delay) or RETEST (a new session may be issued; the earlier one is kept). A reason is required except to PROCEED on PASSED or BORDERLINE.",
    {
      resultId: idInput.describe("Result id"),
      decision: z.enum(["PROCEED", "OVERRIDE", "RELEASE", "RETEST"]).describe("The decision"),
      reason: z.string().max(1000).optional().describe("Why (required except PROCEED on a passing band)"),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT", "recruiter");
      return text(await decideTestResult({ ...args, tenantId, access, actorId }));
    }, "hr_test_result_decide"),
  );

  server.tool(
    "hr_test_result_waive",
    "Waive the on-site test for an interview with a reason (internal candidate, senior role, accessibility); no session needed. Allowed before the test (REQUIRED, CHECKED_IN) or on a FAILED, REVIEW or INCOMPLETE result. Recruiter only.",
    {
      interviewId: idInput.describe("Interview id"),
      reason: z.string().min(1).max(1000).describe("Why the test is waived"),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT", "recruiter");
      return text(await waiveAssessment({ ...args, tenantId, access, actorId }));
    }, "hr_test_result_waive"),
  );

  server.tool(
    "hr_test_analytics_get",
    "On-site test analytics (recruiter only): pass rates by requisition, source and site, the override rate per requisition (a high rate means the pass mark needs review), average score and completion time.",
    {
      requisitionId: idInput.optional().describe("Only this requisition"),
      from: z.string().optional().describe("Results recorded from (ISO 8601)"),
      to: z.string().optional().describe("Results recorded until (ISO 8601)"),
    },
    withToolError(async (args) => {
      const { tenantId, access } = authorized("GET", "recruiter");
      return text(await getTestAnalytics({ ...args, tenantId, access }));
    }, "hr_test_analytics_get"),
  );
}

export default registerTestResultTools;
