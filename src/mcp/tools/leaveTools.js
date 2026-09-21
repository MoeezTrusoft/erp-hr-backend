import { z } from "zod";
import {
  mcpApproveLeaveRequest,
  mcpCancelLeaveRequest,
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
import { assertEmployeeScope, resolveActorScope } from "../utils/actorScope.js";
import prisma from "../../lib/prisma.js";

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
      // HR-LEAVE-SELFSCOPE-01 (2026-09-22) — an employee session (VIEW-only on
      // hr:leave) must see ONLY its own requests. Pin to the acting employee;
      // a foreign employeeId is refused, not remapped (D1=A).
      const { actingEmployeeId, canViewOthers } = resolveActorScope(user, permissions);
      const pinnedEmployeeId = assertEmployeeScope({
        user,
        permissions,
        explicit: args.employeeId,
        actingEmployeeId,
        canViewOthers,
        allowUnbound: true,
      });
      const data = await mcpListLeaveRequests(user, toListQuery({ ...args, employeeId: pinnedEmployeeId ?? undefined }));
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_leave_requests_list")
  );

  server.tool(
    "hr_leave_request_create",
    "Submit a leave request",
    {
      employeeId: z
        .string()
        .min(1)
        .optional()
        .describe("Employee id (Employee.id) the request is for; omit → the caller's own employeeId (self-service)"),
      leaveType: z
        .string()
        .min(1)
        .optional()
        .describe("HR-LEAVE-TYPELESS-01 — OPTIONAL: employees file WITHOUT a type (HR assigns one at approval). HR/manager may still create a pre-typed request by passing the policy code."),
      startDate: z.string().describe("ISO 8601 date YYYY-MM-DD; must be today or later and ≤ endDate"),
      endDate: z.string().describe("ISO 8601 date YYYY-MM-DD; must be ≥ startDate"),
      reason: z.string().optional().describe("Optional free-text reason shown on the request"),
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
      id: z.string().min(1).describe("Leave request ID (LeaveRequest.id)"),
      comments: z.string().optional().describe("Optional approver note; persisted on the LeaveRequestApproval row"),
      approverId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee id to record as the approver. Optional — defaults to the caller's own employeeId (resolved from userId/email for a super-admin without a session employee)."),
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
      id: z.string().min(1).describe("Leave request ID (LeaveRequest.id)"),
      reason: z.string().min(1).describe("Reason for rejection; persisted to the LeaveRequestApproval.comments column"),
      approverId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee id to record as the reviewer. Optional — defaults to the caller's own employeeId (resolved from userId/email for a super-admin without a session employee)."),
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
      id: z.string().min(1).describe("Leave request ID (LeaveRequest.id)"),
      reason: z.string().optional().describe("Optional cancellation reason; persisted to LeaveRequest.reason"),
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
      name: z.string().min(1).describe("Policy name (unique); e.g. 'Annual Leave Policy'"),
      leaveTypeCode: z
        .string()
        .optional()
        .describe("Type code that drives type bucketing (e.g. ANNUAL, SICK, CASUAL, MATERNITY)"),
      accrualPeriod: z
        .enum(["NONE", "MONTHLY", "QUARTERLY", "ANNUAL"])
        .describe("Accrual cadence (LeaveAccrualPeriod enum) — one of NONE | MONTHLY | QUARTERLY | ANNUAL; required and validated"),
      accrualRate: z.number().nonnegative().optional().describe("Days accrued per accrual period"),
      carryForwardAllowed: z
        .boolean()
        .optional()
        .describe("Whether unused balance carries forward; if true maxCarryForward must be > 0, if false it must be 0"),
      maxCarryForward: z.number().nonnegative().optional().describe("Max days that carry forward; see carryForwardAllowed rule"),
      minServiceMonths: z.number().int().nonnegative().optional().describe("Minimum months of service before accrual begins; defaults to 0"),
      active: z.boolean().optional().describe("Whether the policy is active; defaults to true"),
      approvalWorkflowId: z.number().int().optional().describe("FK to an ApprovalWorkflow that gates requests under this policy"),
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
      id: z.string().min(1).describe("Leave policy ID (LeavePolicy.id); numeric"),
      name: z.string().optional().describe("New policy name"),
      description: z.string().optional().describe("New description"),
      leaveTypeCode: z.string().optional().describe("Type code used for bucketing (e.g. ANNUAL, SICK)"),
      accrualRate: z.number().nonnegative().optional().describe("Days accrued per accrual period"),
      accrualPeriod: z
        .enum(["NONE", "MONTHLY", "QUARTERLY", "ANNUAL"])
        .optional()
        .describe("Accrual cadence (LeaveAccrualPeriod enum) — one of NONE | MONTHLY | QUARTERLY | ANNUAL"),
      carryForwardAllowed: z.boolean().optional().describe("Whether unused balance carries forward"),
      maxCarryForward: z.number().nonnegative().optional().describe("Max days that carry forward"),
      active: z.boolean().optional().describe("Whether the policy is active"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read — a stale value returns -32009"),
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
      employeeId: z.string().min(1).describe("Employee id (Employee.id); numeric"),
      leavePolicyId: z
        .union([z.string(), z.number()])
        .describe("Leave policy id (LeavePolicy.id); half of the LeaveBalance composite key employeeId+leavePolicyId"),
      balance: z.number().describe("Absolute new balance in days (replaces, not increments)"),
      carryOverBalance: z.number().optional().describe("Absolute carry-over balance in days; defaults to 0"),
      notes: z.string().optional().describe("Optional audit note for the adjustment"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await mcpUpdateLeaveBalance(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_delete",
    "Delete a leave balance record for an employee",
    {
      employeeId: z.string().min(1).describe("Employee id (Employee.id)"),
      leavePolicyId: z
        .union([z.string(), z.number()])
        .describe("Leave policy id (LeavePolicy.id)"),
    },
    withToolError(async ({ employeeId, leavePolicyId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:leave", user.isAdmin);
      await prisma.leaveBalance.delete({
        where: {
          employeeId_leavePolicyId: {
            employeeId: Number(employeeId),
            leavePolicyId: Number(leavePolicyId),
          },
        },
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    })
  );

  server.tool(
    "hr_leave_accruals_run",
    "Trigger a leave accrual run for all employees",
    {
      accrualDate: z
        .string()
        .optional()
        .describe("ISO 8601 date YYYY-MM-DD to accrue as-of; defaults to today"),
      policyIds: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("Optional list of LeavePolicy ids to scope the run to; omit → all active accruing policies"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await mcpRunLeaveAccruals(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // hr_holiday_create previously lived here too — a second registration of the
  // SAME tool name that holidayCalendarTools.js owns. The MCP SDK throws on a
  // duplicate name at registration time, which killed EVERY HR MCP call
  // ("Tool hr_holiday_create is already registered" → HR-5000 on all tool
  // traffic). The canonical tool lives in holidayCalendarTools.js, gated
  // hr:holiday (the RBAC resource seeded for the Holiday Management screen).
}
