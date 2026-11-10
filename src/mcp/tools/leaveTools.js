import { z } from "zod";
import {
  mcpApproveLeaveRequest,
  mcpCancelLeaveRequest,
  mcpCreateLeaveRequest,
  mcpListHolidays,
  mcpListLeaveBalances,
  mcpListLeavePolicies,
  mcpListLeaveRequests,
  mcpListPendingLeaveApprovals,
  mcpRejectLeaveRequest,
} from "../controllers/leaveMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission, hasPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { toListEnvelope, toListQuery } from "../utils/listEnvelope.js";
import { assertEmployeeScope, resolveActorScope } from "../utils/actorScope.js";
import prisma from "../../lib/prisma.js";
import { requireEmployeeActor } from "../../lib/employeeActor.js";
import { requestPolicyCreate, requestPolicyUpdate, requestPolicyDelete, requestBalanceSet, requestCancelLeave, listPendingLeaveChanges } from "../../services/leaveChangeRequest.service.js";
import { runAccruals, runCarryOver, balanceHistory } from "../../services/leaveLedger.service.js";
import { legacySubmit } from "../../services/approval/legacy.js";
import { fileLeaveForApproval } from "../../lib/leaveSubmission.js";
import {
  mayRaiseLeaveFor,
  RAISE_DENIED,
  RAISE_DENIED_MESSAGE,
  RAISE_SELF,
} from "../../lib/leaveOnBehalf.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Issue 395 — the target's line manager, read tenant-scoped. A missing employee
// answers null (the caller is then refused, not told whether the id exists).
async function resolveLineManagerId(tenantId, employeeId) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await prisma.employee.findFirst({
    where: { tenant_id: tenantId, id },
    select: { managerId: true },
  });
  return row?.managerId ?? null;
}

// Issue 395 — a line manager follows the leave of their DIRECT reports on their
// own leave screen (they hold no tenant-wide leave grant), so the list is
// scoped to self + reports for a manager with hr:approvals:manager.
async function directReportIds(tenantId, managerId) {
  if (!Number.isInteger(Number(managerId))) return [];
  const rows = await prisma.employee.findMany({
    where: { tenant_id: tenantId, managerId: Number(managerId) },
    select: { id: true },
  });
  return rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
}

const isLineManager = (permissions) =>
  hasPermission(permissions, "hr:approvals:manager", "VIEW");

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

  // TOOL twin of the resource (IC-1 pattern, same trap hr_leave_requests_list
  // fell into): callTool cannot resolve resources, and the Leave screen needs
  // the policies catalog to render the HR type-assignment select. Gated on
  // hr:leave:VIEW; the catalog is global (LeavePolicy has no tenant column).
  server.tool(
    "hr_leave_policies_list",
    "List active leave policies (the leave TYPES HR assigns at approval). includeInactive adds the ones no longer in use",
    { includeInactive: z.boolean().optional() },
    withToolError(async ({ includeInactive } = {}) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await mcpListLeavePolicies(user, includeInactive ? { includeInactive: "true" } : {});
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_policies_list")
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
      // HR-LEAVE-MONTH-01 — month-window filter (requests OVERLAPPING the
      // range), passed through to getLeaveRequests verbatim.
      startDate: z.string().optional().describe("ISO date — only requests overlapping the window are returned (with endDate)"),
      endDate: z.string().optional().describe("ISO date — window end for the overlap filter"),
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
      const query = toListQuery({ ...args, employeeId: pinnedEmployeeId ?? undefined });
      // Issue 395 — a line manager has no write grant, so a request they raised
      // for a report belongs to that report and would vanish from their screen.
      // "Involving me" = my own rows + the ones I raised for someone else; the
      // id always comes from the session, never from the call, and the controller
      // re-derives it for an EMPLOYEE-role session.
      if (!canViewOthers && isLineManager(permissions) && actingEmployeeId && args.employeeId == null) {
        query.involvingEmployeeId = actingEmployeeId;
        delete query.employeeId;
      }
      const data = await mcpListLeaveRequests(user, query);
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
      startDate: z.string().describe("ISO 8601 date YYYY-MM-DD; must be today or later and ≤ endDate (a raise ON BEHALF may start in the past)"),
      endDate: z.string().describe("ISO 8601 date YYYY-MM-DD; must be ≥ startDate"),
      reason: z.string().optional().describe("Optional free-text reason shown on the request"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      // HR-LEAVE-SELFSCOPE-02 (2026-09-22) — filing a request is SELF-SERVICE:
      // an employee (hr:leave VIEW only) may create a request for THEMSELVES
      // even without the hr:leave POST grant. The admin/HR write path is
      // unchanged (POST grant → may create for anyone, pre-typed or not). A
      // VIEW-only session naming someone else is refused, never remapped.
      //
      // Issue 395 — the LINE MANAGER is the second on-behalf door: a manager may
      // raise leave for a DIRECT report with no write grant at all, because the
      // reporting line is what authorises the request (it feeds their own queue).
      // The decision itself lives in lib/leaveOnBehalf.js so it is testable.
      let canWriteOthers = false;
      try {
        assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
        canWriteOthers = true;
      } catch {
        canWriteOthers = false;
      }
      const { actingEmployeeId } = resolveActorScope(user, permissions);
      const requestedId =
        args.employeeId == null || args.employeeId === ""
          ? actingEmployeeId
          : Number(args.employeeId);
      if (requestedId == null || !Number.isInteger(Number(requestedId))) {
        throw Object.assign(
          new Error("employeeId is required (pass one or authenticate as an employee)"),
          { status: 400, code: "HR-4000" },
        );
      }
      // Only read the target's reporting line when the caller is not HR
      // (HR needs no manager lookup, and a VIEW-only stranger gets no lookup).
      const targetManagerId = canWriteOthers
        ? null
        : await resolveLineManagerId(user.tenantId, requestedId);
      const basis = mayRaiseLeaveFor({
        actingEmployeeId,
        canWriteOthers,
        targetEmployeeId: requestedId,
        targetManagerId,
      });
      if (basis === RAISE_DENIED) {
        throw Object.assign(new Error(RAISE_DENIED_MESSAGE), { status: 403, code: "HR-4030" });
      }
      const onBehalf = basis !== RAISE_SELF;
      args.employeeId = String(requestedId);
      // A raise on behalf is usually retrospective (the manager files for a day
      // already taken), so the employee-only "no past dates" rule is lifted for
      // it — and only for it.
      if (onBehalf) args.allowPastDates = true;
      const data = await mcpCreateLeaveRequest(user, args);
      // A request nobody submitted never reaches the Approval Centre, so file it
      // there now: the employee's own request as themselves, an on-behalf one as
      // the employee but ON BEHALF, so the filer is on record and the route is
      // the employee's (a manager who files for a report cannot also be the
      // approving level — the submit marks that manager stage as the filer's).
      // A submit failure keeps the request and says so.
      const body = await fileLeaveForApproval({
        response: data,
        filedForSelf: !onBehalf,
        onBehalf,
        raisedBy: onBehalf ? basis : null,
        reason: args.reason,
        submit: legacySubmit,
      });
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
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
    "Request a new leave type. It is sent for approval through the attendance approval route and exists only once approved",
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
      reason: z.string().trim().min(3).max(4000).describe("Why this leave type is being added; shown to the approvers"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await requestPolicyCreate({ ...args, tenantId: user.tenantId, requestedById: user.employeeId ?? (await requireEmployeeActor(user)) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_update",
    "Request a change to a leave type. Sent for approval; applies once approved",
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
      minServiceMonths: z.number().int().nonnegative().optional().describe("Minimum months of service before accrual begins"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read"),
      reason: z.string().trim().min(3).max(4000).describe("Why the leave type is being changed; shown to the approvers"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await requestPolicyUpdate({ ...rest, id, tenantId: user.tenantId, requestedById: user.employeeId ?? (await requireEmployeeActor(user)) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_delete",
    "Request removal of an unused leave type. Sent for approval",
    { id: z.string().min(1), reason: z.string().trim().min(3).max(4000) },
    withToolError(async ({ id, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:leave", user.isAdmin);
      const data = await requestPolicyDelete({ id, reason, tenantId: user.tenantId, requestedById: user.employeeId ?? (await requireEmployeeActor(user)) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_update",
    "Request a new leave balance for an employee. Sent for approval; recorded as a ledger entry once approved",
    {
      employeeId: z.string().min(1).describe("Employee id (Employee.id); numeric"),
      leavePolicyId: z
        .union([z.string(), z.number()])
        .describe("Leave policy id (LeavePolicy.id); half of the LeaveBalance composite key employeeId+leavePolicyId"),
      balance: z.number().describe("Absolute new balance in days (replaces, not increments)"),
      carryOverBalance: z.number().optional().describe("Absolute carry-over balance in days; defaults to 0"),
      reason: z.string().trim().min(3).max(4000).describe("Why the balance is being set; shown to the approvers and kept in the ledger"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await requestBalanceSet({ ...rest, employeeId, tenantId: user.tenantId, requestedById: user.employeeId ?? (await requireEmployeeActor(user)) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_delete",
    "Not available: balances are never deleted. Request a balance of 0 instead",
    {
      employeeId: z.string().min(1).describe("Employee id (Employee.id)"),
      leavePolicyId: z
        .union([z.string(), z.number()])
        .describe("Leave policy id (LeavePolicy.id)"),
    },
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:leave", user.isAdmin);
      throw Object.assign(new Error("A balance is never deleted, because its history would be lost. Request a balance of 0 instead."), { status: 409 });
    })
  );

  server.tool(
    "hr_leave_accruals_run",
    "Credit leave for the period that contains accrualDate. Each person is credited once per leave type and period, however often it is run. Defaults to a dry run that lists who would be credited and writes nothing",
    {
      accrualDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD inside the period to credit; defaults to today"),
      policyIds: z.array(z.union([z.string(), z.number()])).optional().describe("Leave type ids to include; omit for all that accrue"),
      dryRun: z.boolean().default(true).describe("true lists only; false credits"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await runAccruals({ ...args, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_carryover_run",
    "Year-end carry-over: keep up to each leave type's limit and expire the rest, once per person, type and year. Defaults to a dry run",
    {
      effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD in the year to close; defaults to today"),
      policyIds: z.array(z.union([z.string(), z.number()])).optional(),
      dryRun: z.boolean().default(true),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const data = await runCarryOver({ ...args, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_cancel_approved",
    "Request cancelling approved leave. Sent for approval; once approved the days go back to the balance and attendance is re-checked",
    { leaveRequestId: z.number().int().positive(), reason: z.string().trim().min(3).max(4000) },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await requestCancelLeave({ ...args, tenantId: user.tenantId, requestedById: user.employeeId ?? (await requireEmployeeActor(user)) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_changes_pending",
    "Leave changes (types, balances, cancellations) waiting for approval",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await listPendingLeaveChanges({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_history",
    "The movements behind a leave balance, newest first. HR sees anyone; an employee sees only their own",
    { employeeId: z.number().int().positive().optional(), leavePolicyId: z.number().int().positive().optional() },
    withToolError(async ({ employeeId, leavePolicyId }) => {
      const { user, permissions } = getCtx();
      const own = Number(user.employeeId) || null;
      const target = employeeId ?? own;
      if (!target) throw Object.assign(new Error("Choose an employee"), { status: 400 });
      if (target !== own) assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await balanceHistory({ tenantId: user.tenantId, employeeId: target, leavePolicyId });
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
