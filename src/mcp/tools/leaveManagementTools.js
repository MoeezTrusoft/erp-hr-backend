// src/mcp/tools/leaveManagementTools.js — Leave Management dashboard MCP facade.
//
// Read/aggregate + unified-decision tools backing the HR Leave Management
// dashboard. All tools are tenant-scoped via ctx (verified tenant) and gated on
// hr:leave (deny-by-default). Writes assert PUT; reads assert GET.
//
// Existing leave tools (registered by leaveTools.js — NOT duplicated here):
//   hr_leave_request_create, hr_leave_request_approve, hr_leave_request_reject,
//   hr_leave_requests_list, hr_leave_balances_list.
// This module adds the dashboard-specific surface. hr_leave_request_decide is a
// unified wrapper over approve/reject (reason required on reject); the pairwise
// approve/reject tools remain available for callers that prefer them.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getLeaveBalancesSummary,
  getLeaveRequestsDashboard,
  decideLeaveRequest,
  getNext30Coverage,
  getLeaveByTypeReport,
} from "../../services/leaveManagement.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerLeaveManagementTools(server) {
  // 1 ── balances summary by type ────────────────────────────────────────────
  server.tool(
    "hr_leave_balances_summary",
    "Leave balances grouped by type (annual/sick/casual/maternity/other). With employeeId → that employee; else tenant-wide aggregate.",
    {
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee id (Employee.id) to scope to; omit → tenant-wide aggregate"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await getLeaveBalancesSummary(args, user.tenantId);
      return ok(data);
    }, "hr_leave_balances_summary")
  );

  // 2 ── requests dashboard (paginated) ──────────────────────────────────────
  server.tool(
    "hr_leave_requests_dashboard",
    "Paginated leave-requests dashboard rows with search (q=employee), filter (status/type/from/to), sort (submitted|status).",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      q: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
      from: z.string().optional().describe("ISO date — window start"),
      to: z.string().optional().describe("ISO date — window end"),
      sort: z.enum(["submitted", "status"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await getLeaveRequestsDashboard(args, user.tenantId);
      return ok(data);
    }, "hr_leave_requests_dashboard")
  );

  // 3 ── unified approve/reject decision ─────────────────────────────────────
  server.tool(
    "hr_leave_request_decide",
    "Approve or reject a leave request (unified). reason required when decision=reject. Records an approval row and updates status.",
    {
      id: z.union([z.string(), z.number()]).describe("Leave request ID (LeaveRequest.id)"),
      decision: z.enum(["approve", "reject"]).describe("Decision — one of approve | reject"),
      reason: z
        .string()
        .optional()
        .describe("Conditionally required: MUST be non-empty when decision=reject (enforced server-side, 400 otherwise); stored as LeaveRequestApproval.comments"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await decideLeaveRequest(args, user, user.tenantId);
      return ok(data);
    }, "hr_leave_request_decide")
  );

  // 4 ── next-30-day coverage ────────────────────────────────────────────────
  server.tool(
    "hr_leave_next30_coverage",
    "Per-department coverage for the next 30 days (present vs on-leave, presentPct) plus a daily present/on-leave series.",
    {},
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await getNext30Coverage(args, user.tenantId);
      return ok(data);
    }, "hr_leave_next30_coverage")
  );

  // 5 ── leave-by-type report ────────────────────────────────────────────────
  server.tool(
    "hr_leave_by_type_report",
    "Leave taken (in days) by type from APPROVED requests: {annual,sick,casual,maternity,other}. Optional from/to period filter.",
    {
      from: z.string().optional().describe("ISO date — period start"),
      to: z.string().optional().describe("ISO date — period end"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await getLeaveByTypeReport(args);
      return ok(data);
    }, "hr_leave_by_type_report")
  );
}
