import { z } from "zod";
import {
  mcpApproveLeaveRequest,
  mcpCancelLeaveRequest,
  mcpCreateHoliday,
  mcpCreateLeavePolicy,
  mcpCreateLeaveRequest,
  mcpDeleteLeavePolicy,
  mcpListHolidays,
  mcpListLeaveBalances,
  mcpListLeavePolicies,
  mcpListLeaveRequests,
  mcpListPendingLeaveApprovals,
  mcpRejectLeaveRequest,
  mcpRunLeaveAccruals,
  mcpUpdateLeaveBalance,
  mcpUpdateLeavePolicy,
} from "../controllers/leaveMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { toListEnvelope, toListQuery } from "../utils/listEnvelope.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLeaveTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_leave_requests_list",
    "hr://leaves/requests",
    { description: "List all leave requests" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListLeaveRequests(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_policies_list",
    "hr://leaves/policies",
    { description: "List all leave policies" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListLeavePolicies(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_balances_list",
    "hr://leaves/balances",
    { description: "List leave balances for all employees" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListLeaveBalances(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_pending_approvals",
    "hr://leaves/approvals/pending",
    { description: "Get leave requests pending approval" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListPendingLeaveApprovals(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_holidays_list",
    "hr://holidays",
    { description: "List all public holidays" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListHolidays(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  // IC-1: the HR FE binds the Leave Requests LIST screen to the
  // `hr_leave_requests_list` TOOL (tools/call). A same-named RESOURCE exists but
  // callTool could not resolve it, so the screen fell back to mock data. This
  // TOOL wraps the existing list service, tenant-scoped via ctx, and returns the
  // FE-expected paginated envelope. Gated on hr:leave:VIEW (deny-by-default).
  server.tool(
    "hr_leave_requests_list",
    "List leave requests (paginated) for the HR leave screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      status: z.string().optional(),
      employeeId: z.union([z.string(), z.number()]).optional(),
      leaveType: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await mcpListLeaveRequests(user, toListQuery(args));
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_leave_requests_list")
  );

  server.tool(
    "hr_leave_request_create",
    "Submit a leave request",
    {
      employeeId: z.string().min(1),
      leaveType: z.string().min(1).describe("Leave type (e.g. ANNUAL, SICK, MATERNITY)"),
      startDate: z.string().describe("ISO 8601 date"),
      endDate: z.string().describe("ISO 8601 date"),
      reason: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpCreateLeaveRequest(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_approve",
    "Approve a leave request",
    {
      id: z.string().min(1).describe("Leave request ID"),
      comment: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpApproveLeaveRequest(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_reject",
    "Reject a leave request",
    {
      id: z.string().min(1).describe("Leave request ID"),
      reason: z.string().min(1).describe("Reason for rejection"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpRejectLeaveRequest(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_cancel",
    "Cancel a leave request",
    {
      id: z.string().min(1),
      reason: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await mcpCancelLeaveRequest(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_create",
    "Create a new leave policy",
    {
      name: z.string().min(1),
      leaveType: z.string().min(1),
      daysPerYear: z.number().int().positive(),
      carryOver: z.boolean().optional(),
      maxCarryOverDays: z.number().int().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpCreateLeavePolicy(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_update",
    "Update a leave policy",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      daysPerYear: z.number().int().optional(),
      carryOver: z.boolean().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await mcpUpdateLeavePolicy(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_delete",
    "Delete a leave policy",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:leave", user.isAdmin);
      const data = await mcpDeleteLeavePolicy(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_update",
    "Update leave balance for an employee",
    {
      employeeId: z.string().min(1),
      leaveType: z.string().min(1),
      balance: z.number(),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await mcpUpdateLeaveBalance(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_accruals_run",
    "Trigger a leave accrual run for all employees",
    {
      asOfDate: z.string().optional().describe("ISO 8601 date; defaults to today"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpRunLeaveAccruals(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_holiday_create",
    "Create a public holiday",
    {
      name: z.string().min(1),
      date: z.string().describe("ISO 8601 date"),
      calendarId: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpCreateHoliday(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
