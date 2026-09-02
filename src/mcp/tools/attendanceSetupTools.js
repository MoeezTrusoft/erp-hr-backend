// src/mcp/tools/attendanceSetupTools.js
//
// Payroll Setup → Attendance Policy, Deduction Rules, and the anomaly Approval
// Chain. MCP facade over the three attendance config services.
//
// Gated on the SAME hr:payroll resourceKey as the rest of Payroll Setup: these
// screens live there, and reusing the key means no new RBAC permission has to be
// seeded (an unseeded key just returns 403 at runtime).
//
// assertPermission takes an HTTP METHOD, not an action name — METHOD_ACTION maps
// POST->CREATE and PUT->EDIT. Passing "CREATE" directly silently bypasses the
// check.
//
// HR-ATT-POLICY-01.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getAttendancePolicy,
  updateAttendancePolicy,
} from "../../services/attendancePolicyConfig.service.js";
import {
  DEDUCTION_RULE_KEYS,
  listDeductionRules,
  upsertDeductionRule,
} from "../../services/attendanceDeductionRule.service.js";
import {
  listApprovalLevels,
  listApproverCandidates,
  upsertApprovalLevel,
  deleteApprovalLevel,
} from "../../services/attendanceApprovalLevel.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerAttendanceSetupTools(server) {
  // ── ATTENDANCE POLICY ──────────────────────────────────────────────────────
  server.tool(
    "hr_attendance_policy_get",
    "Get the tenant's attendance policy thresholds (grace, half-day, duration bands, session gap)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      return ok(await getAttendancePolicy({ tenantId: user.tenantId }));
    }, "hr_attendance_policy_get")
  );

  server.tool(
    "hr_attendance_policy_update",
    "Update the tenant's attendance policy thresholds (returns config to DRAFT)",
    {
      graceMinutes: z.coerce.number().int().min(0).optional()
        .describe("Minutes after shift start still counted PRESENT (AttendancePolicyConfig.graceMinutes)"),
      halfDayAfterMinutes: z.coerce.number().int().min(0).optional()
        .describe("Lateness in minutes at which the day becomes HALF_DAY (AttendancePolicyConfig.halfDayAfterMinutes)"),
      halfDayAfterPercentOfShift: z.coerce.number().min(0).max(100).nullable().optional()
        .describe("When set, the half-day threshold is this PERCENT of the employee's own rostered shift instead of the fixed minutes. Half a shift is 90 min on a 3h roster and 360 on a 12h one, so a fixed number cannot serve both. Null = use halfDayAfterMinutes"),
      earlyLeaveGraceMin: z.coerce.number().int().min(0).optional()
        .describe("Minutes before shift end a check-out is still not an early departure"),
      checkoutLeniencyMin: z.coerce.number().int().min(0).optional()
        .describe("How long past shift end a check-out still counts, used when the next day is non-working"),
      overtimeAfterMinutes: z.coerce.number().int().min(0).optional()
        .describe("Minutes past shift end before overtime starts accruing"),
      overtimeNeedsApproval: z.boolean().optional()
        .describe("Require manager approval before overtime counts"),
      fullDayMinPercent: z.coerce.number().min(0).max(100).optional()
        .describe("PERCENT of the rostered shift that must be worked for a full day. Percent, not hours: shifts here range 3h to 12h"),
      halfDayMinPercent: z.coerce.number().min(0).max(100).optional()
        .describe("PERCENT of the rostered shift that must be worked for a half day; must be <= fullDayMinPercent"),
      duplicatePunchWindowMin: z.coerce.number().int().min(0).optional()
        .describe("Anti-passback: identical punches within this many minutes collapse to one"),
      shiftGapHours: z.coerce.number().int().min(2).max(23).optional()
        .describe("Gap that separates one shift from the next. Below this, punches belong to the same shift — this is what carries a night shift past midnight"),
      defaultShiftStart: z.string().optional()
        .describe("HH:MM fallback shift start for employees with no rostered shift"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      return ok(await updateAttendancePolicy({ ...args, tenantId: user.tenantId }));
    }, "hr_attendance_policy_update")
  );

  // ── DEDUCTION RULES ────────────────────────────────────────────────────────
  server.tool(
    "hr_attendance_deduction_rules_list",
    "List the tenant's attendance deduction rules; unconfigured keys come back as disabled defaults",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      return ok(await listDeductionRules({ tenantId: user.tenantId }));
    }, "hr_attendance_deduction_rules_list")
  );

  server.tool(
    "hr_attendance_deduction_rule_upsert",
    "Create or update one attendance deduction rule (returns config to DRAFT)",
    {
      ruleKey: z.enum(DEDUCTION_RULE_KEYS)
        .describe("Which anomaly this rule deducts for. MISSING_CHECKIN and MISSING_CHECKOUT are separate: a missing check-out is routine on this device, a missing check-in is not"),
      enabled: z.boolean().optional()
        .describe("Rules ship disabled. Enable only after reviewing a deduction dry-run"),
      triggerCount: z.coerce.number().int().min(1).optional()
        .describe("N occurrences in the period before the deduction applies; 1 means per occurrence"),
      deductionDays: z.coerce.number().min(0).max(31).optional()
        .describe("X days deducted, fractional allowed (0.5 = half day)"),
      periodScope: z.enum(["PAY_PERIOD", "MONTH"]).optional()
        .describe("Window the occurrence count resets over; PAY_PERIOD follows PayrollCalendar"),
      maxDeductionDaysPerPeriod: z.coerce.number().min(0).max(31).nullable().optional()
        .describe("Cap on days deducted per employee per period; null for no cap"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      return ok(await upsertDeductionRule({ ...args, tenantId: user.tenantId }));
    }, "hr_attendance_deduction_rule_upsert")
  );

  // ── ANOMALY APPROVAL CHAIN ─────────────────────────────────────────────────
  server.tool(
    "hr_attendance_approval_levels_list",
    "List the attendance anomaly approval chain in order, with resolved approvers",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      return ok(await listApprovalLevels({ tenantId: user.tenantId }));
    }, "hr_attendance_approval_levels_list")
  );

  server.tool(
    "hr_attendance_approver_candidates_list",
    "Employees selectable as approvers, for the Payroll Setup approver picker",
    {
      search: z.string().optional().describe("Filter by name or employee code"),
      limit: z.coerce.number().int().min(1).max(200).optional().describe("Page size, default 50, max 200"),
    },
    withToolError(async ({ search, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      return ok(await listApproverCandidates({ tenantId: user.tenantId, search, limit }));
    }, "hr_attendance_approver_candidates_list")
  );

  server.tool(
    "hr_attendance_approval_level_upsert",
    "Create or update one level of the attendance anomaly approval chain (returns config to DRAFT)",
    {
      level: z.coerce.number().int().min(1)
        .describe("Order in the chain, ascending. Typically 1 = the requester's manager, 2 = HR, 3 = management"),
      role: z.string().optional()
        .describe("Approving role label, e.g. MANAGER / HR / MANAGEMENT. Required when creating a level"),
      approverId: z.coerce.number().int().min(1).nullable().optional()
        .describe("Employee id of a fixed approver, chosen from hr_attendance_approver_candidates_list"),
      useEmployeeManager: z.boolean().optional()
        .describe("Resolve the approver from the requester's own manager at routing time instead of a fixed person"),
      skipIfUnresolved: z.boolean().optional()
        .describe("Step over this level when no approver resolves — this is the 'hop to the next level when there is no manager' rule"),
      autoEscalateAfterHours: z.coerce.number().int().min(1).nullable().optional()
        .describe("Escalate to the next level after this many hours without a decision"),
      rowStatus: z.enum(["ACTIVE", "INACTIVE"]).optional()
        .describe("Disable a level without deleting it"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      return ok(await upsertApprovalLevel({ ...args, tenantId: user.tenantId }));
    }, "hr_attendance_approval_level_upsert")
  );

  server.tool(
    "hr_attendance_approval_level_delete",
    "Remove one level from the attendance anomaly approval chain",
    {
      level: z.coerce.number().int().min(1).describe("Level to remove"),
    },
    withToolError(async ({ level }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:payroll", user.isAdmin);
      return ok(await deleteApprovalLevel({ tenantId: user.tenantId, level }));
    }, "hr_attendance_approval_level_delete")
  );
}
