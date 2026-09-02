// src/mcp/tools/attendanceAnomalyTools.js
//
// Attendance regularization: raise a request, see the queue, decide it.
// Gated on the existing hr:attendance resourceKey (these are employee and
// approver actions; the CONFIG for them lives under hr:payroll in
// attendanceSetupTools.js).
//
// Identity is taken from the verified service-JWT context, never from
// arguments. An employeeId in the payload would let anyone file a request in
// someone else's name, or approve as somebody else — and approval releases a
// held day while rejection triggers a deduction.
//
// HR-ATT-POLICY-01.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getAnomalyFormDefaults,
  createAnomalyRequest,
} from "../../services/attendanceAnomalyRequest.service.js";
import { setDayWorkMode, getDayWorkMode } from "../../services/dayWorkMode.service.js";
import { correctAttendanceDay, listCorrections } from "../../services/attendanceCorrection.service.js";
import { markAbsences } from "../../services/absenceMarking.service.js";
import {
  resolveApprovalChain,
  decideAnomaly,
  listPendingForApprover,
} from "../../services/attendanceAnomalyRouting.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

/** The acting employee, from the verified claim only. */
function actingEmployeeId(user) {
  const id = Number(user?.employeeId);
  if (!Number.isInteger(id) || id < 1) {
    throw Object.assign(
      new Error("No employee is linked to this login; cannot act on attendance requests"),
      { status: 403 },
    );
  }
  return id;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerAttendanceAnomalyTools(server) {
  server.tool(
    "hr_attendance_anomaly_form_defaults",
    "Pre-fill the regularization request form for one date; every field except reason is derived",
    {
      date: z.string().describe("The affected work date (YYYY-MM-DD)"),
    },
    withToolError(async ({ date }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return ok(
        await getAnomalyFormDefaults({
          tenantId: user.tenantId,
          employeeId: actingEmployeeId(user),
          date,
        }),
      );
    }, "hr_attendance_anomaly_form_defaults")
  );

  server.tool(
    "hr_attendance_anomaly_create",
    "Raise a regularization request. Category and times are derived server-side; only reason is accepted",
    {
      date: z.string().describe("The affected work date (YYYY-MM-DD)"),
      reason: z.string().min(1).describe("Why the day should be regularized — the only employee-supplied field"),
    },
    withToolError(async ({ date, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      return ok(
        await createAnomalyRequest({
          tenantId: user.tenantId,
          employeeId: actingEmployeeId(user),
          date,
          reason,
        }),
      );
    }, "hr_attendance_anomaly_create")
  );

  server.tool(
    "hr_attendance_anomaly_chain_preview",
    "Show who would approve this employee's request, level by level, with unresolved levels explained",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return ok(
        await resolveApprovalChain({
          tenantId: user.tenantId,
          employeeId: actingEmployeeId(user),
        }),
      );
    }, "hr_attendance_anomaly_chain_preview")
  );

  server.tool(
    "hr_attendance_anomaly_pending_list",
    "Regularization requests currently waiting on the caller as approver",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return ok(
        await listPendingForApprover({
          tenantId: user.tenantId,
          approverId: actingEmployeeId(user),
        }),
      );
    }, "hr_attendance_anomaly_pending_list")
  );

  server.tool(
    "hr_attendance_day_work_mode_get",
    "The work mode in force for an employee on one day, and whether it is a day override or their default",
    {
      employeeId: z.coerce.number().int().min(1).describe("Employee.id"),
      date: z.string().describe("YYYY-MM-DD"),
    },
    withToolError(async ({ employeeId, date }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return ok(await getDayWorkMode({ employeeId, date }));
    }, "hr_attendance_day_work_mode_get")
  );

  server.tool(
    "hr_attendance_day_work_mode_set",
    "Set the work mode for one employee on one day — sudden WFH. Pass null to clear the override",
    {
      employeeId: z.coerce.number().int().min(1).describe("Employee.id"),
      date: z.string().describe("YYYY-MM-DD"),
      workMode: z.enum(["Remote", "Hybrid", "Onsite"]).nullable()
        .describe("null clears the override so the day falls back to the employee's default"),
      note: z.string().optional().describe("Optional remark stored on the attendance row"),
    },
    withToolError(async ({ employeeId, date, workMode, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      return ok(await setDayWorkMode({ tenantId: user.tenantId, employeeId, date, workMode, note }));
    }, "hr_attendance_day_work_mode_set")
  );

  // ── HR / ADMIN MANUAL CORRECTION ───────────────────────────────────────────
  // PUT on hr:attendance, which RBAC grants to HR and admin roles only. The
  // acting employee comes from the verified claim, never from arguments, so a
  // correction can always be attributed to a real person.
  server.tool(
    "hr_attendance_correct_day",
    "HR/admin: correct one employee's attendance for one day. Survives the next device sync and is recorded in the audit log",
    {
      employeeId: z.coerce.number().int().min(1).describe("Employee.id"),
      date: z.string().describe("The work date being corrected (YYYY-MM-DD)"),
      checkIn: z.string().nullable().optional()
        .describe("HH:MM, or null to clear. Anchored to the work date"),
      checkOut: z.string().nullable().optional()
        .describe("HH:MM, or null. Rolls to the next day automatically when earlier than check-in, so night shifts need no special handling"),
      status: z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY", "MISSING_CHECKIN", "MISSING_CHECKOUT"]).optional()
        .describe("Overrides the derived status. PRESENT/LATE credit a full day, HALF_DAY a half, ABSENT none"),
      workMode: z.enum(["Remote", "Hybrid", "Onsite"]).optional()
        .describe("Optionally set the day's work mode at the same time"),
      reason: z.string().min(1)
        .describe("Why the day was changed. Required — corrections feed payroll and must be explainable"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      return ok(await correctAttendanceDay({
        ...args,
        tenantId: user.tenantId,
        actorEmployeeId: actingEmployeeId(user),
      }));
    }, "hr_attendance_correct_day")
  );

  server.tool(
    "hr_attendance_corrections_list",
    "Every manually corrected attendance day in a window, with who changed it and why",
    {
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      employeeId: z.coerce.number().int().min(1).optional(),
    },
    withToolError(async ({ from, to, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return ok(await listCorrections({ tenantId: user.tenantId, from, to, employeeId }));
    }, "hr_attendance_corrections_list")
  );

  server.tool(
    "hr_attendance_mark_absences",
    "Mark scheduled working days with no attendance as ABSENT. Defaults to a dry run — pass dryRun:false to write",
    {
      from: z.string().describe("YYYY-MM-DD"),
      to: z.string().describe("YYYY-MM-DD"),
      dryRun: z.boolean().optional()
        .describe("Defaults to TRUE. This creates unpaid days, so writing must be asked for explicitly"),
    },
    withToolError(async ({ from, to, dryRun }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      return ok(await markAbsences({ tenantId: user.tenantId, from, to, dryRun: dryRun !== false }));
    }, "hr_attendance_mark_absences")
  );

  server.tool(
    "hr_attendance_anomaly_decide",
    "Approve or reject a regularization request at the caller's approval level",
    {
      anomalyId: z.coerce.number().int().min(1).describe("AttendanceAnomaly.id"),
      decision: z.enum(["APPROVED", "REJECTED"])
        .describe("REJECTED is terminal and is what a DISAPPROVED_LEAVE deduction keys off"),
      comments: z.string().optional().describe("Optional note recorded with the decision"),
    },
    withToolError(async ({ anomalyId, decision, comments }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      return ok(
        await decideAnomaly({
          tenantId: user.tenantId,
          anomalyId,
          approverId: actingEmployeeId(user),
          decision,
          comments,
        }),
      );
    }, "hr_attendance_anomaly_decide")
  );
}
