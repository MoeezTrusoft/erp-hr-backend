// src/mcp/tools/timesheetReportTools.js
//
// HR → Timesheet read screen MCP tools: KPI cards, two graphs (weekly
// attendance %, day-wise absenteeism trend), and the check-in/out table.
//
// All tools are READS gated on hr:attendance:VIEW (method GET). The service
// reads the STORED Attendance.status / work_mode (authoritative) — see
// timesheetReport.service.js for the KPI/graph definitions.
import { z } from "zod";
import {
  getTimesheetKpis,
  getAttendanceSummaryWeekly,
  getAttendanceMonthGrid,
  getAbsenteeismTrend,
  listCheckInOuts,
} from "../../services/timesheetReport.service.js";
import {
  isTimesheetSubmitted,
  submitTimesheet,
} from "../../services/timesheetSubmission.service.js";
import { buildMonthlyReconciliation } from "../../services/attendanceReconciliation.service.js";
import { resolveActingEmployeeId } from "../../lib/actingEmployee.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTimesheetReportTools(server) {
  server.tool(
    "hr_timesheet_kpis",
    "Timesheet KPI cards over a period (default = current calendar month): present (distinct employees who showed up), lateArrivals (row count of LATE/HALF_DAY), wfhRemote (distinct employees Remote/Hybrid), absentees (distinct ABSENT employees), totalEmployees.",
    {
      from: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive start of the period. Defaults to the first day of the current calendar month."),
      to: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive end of the period. Defaults to the last day of the current calendar month."),
      // HR-FE-UNBLOCK-01 — without this the cards are tenant-wide only, so an
      // employee profile cannot show that employee's own attendance KPIs.
      employeeId: z.coerce.number().int().positive().optional()
        .describe("Scope every card to one employee. Omit for the whole tenant."),
    },
    withToolError(async ({ from, to, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getTimesheetKpis({ tenantId: user.tenantId, from, to, employeeId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_timesheet_kpis")
  );

  server.tool(
    "hr_attendance_summary_weekly",
    "GRAPH 1 (horizontal bar): weekly attendance % for a month. Each Mon-Sun week's attendancePct = round(presentDays / (totalEmployees * Mon-Sat working days) * 100).",
    {
      month: z.string().optional().describe("Month as YYYY-MM. Defaults to the current calendar month."),
    },
    withToolError(async ({ month }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getAttendanceSummaryWeekly({ tenantId: user.tenantId, month });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_summary_weekly")
  );

  server.tool(
    "hr_absenteeism_trend",
    "GRAPH 2 (trend): day-wise absenteeism % for a month (Mon-Sat working days; Sundays skipped), tagged by week label. Per day absenteeismPct = round(distinct ABSENT employees / totalEmployees * 100).",
    {
      month: z.string().optional().describe("Month as YYYY-MM. Defaults to the current calendar month."),
    },
    withToolError(async ({ month }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getAbsenteeismTrend({ tenantId: user.tenantId, month });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_absenteeism_trend")
  );

  server.tool(
    "hr_checkinout_list",
    "Paginated / filtered / sorted check-in-out table. Each row: attendanceId, date, employee{id,name,avatar}, status (display: on-time|late|half-day|absent), checkIn, checkOut, workMode.",
    {
      q: z.string().optional().describe("Employee-name contains, case-insensitive."),
      status: z
        .enum(["on-time", "late", "half-day", "absent", "missing-checkin", "missing-checkout", "on-leave", "weekly-off", "holiday"])
        .optional()
        .describe("Display status filter — on-time | late | half-day | absent | missing-checkin | missing-checkout | on-leave | weekly-off | holiday (mapped to the stored enum)."),
      exclude: z
        .string()
        .optional()
        .describe("Comma list of display tokens to EXCLUDE; shorthand 'nonworking' = weekly-off,holiday,on-leave. Server-side so page totals match the visible rows."),
      from: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive start of the date range on Attendance.date. Defaults to the first day of the current calendar month — the SAME default as hr_timesheet_kpis, so both tools on this screen always describe the same window."),
      to: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive end of the date range on Attendance.date. Defaults to the last day of the current calendar month. The applied window is echoed back as `period`."),
      employeeId: z.string().optional().describe("Exact employee id to filter by."),
      sortBy: z.enum(["date", "employee", "status", "checkIn", "checkOut"]).optional().describe("Sort column — one of date | employee | status | checkIn | checkOut (default date)."),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction — asc | desc (default desc)."),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)."),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page (default 20, max 100)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listCheckInOuts({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_checkinout_list")
  );

  server.tool(
    "hr_attendance_month_grid",
    "UI-FIX-2026-09-14 — coherent per-day month grid for the 'My attendance' heatmap: every calendar day of the month with present/absent/weekend/holiday/onLeave counts (stored statuses), plus noData for days with no row at all. Scopes to eligible employees tenant-wide, or a single employeeId for self-service.",
    {
      month: z.string().optional().describe("YYYY-MM (default current month)."),
      employeeId: z.string().optional().describe("Scope to one employee (self-service); omit for tenant-wide eligible staff."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getAttendanceMonthGrid({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_month_grid")
  );

  server.tool(
    "hr_attendance_reconciliation",
    "Month-end attendance reconciliation: per-employee status tallies (present/late/halfDay/absent/missingCheckin/missingCheckout/weeklyOff/holiday/onLeave/corrected/needsReview), expectedDays, attendedDays, attendancePct, and fleet totals. The source of truth is the STORED Attendance.status — this report does not re-derive.",
    {
      from: z.string().describe("ISO date string (YYYY-MM-DD); inclusive start of the period."),
      to: z.string().describe("ISO date string (YYYY-MM-DD); inclusive end of the period."),
    },
    withToolError(async ({ from, to }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await buildMonthlyReconciliation({ tenantId: user.tenantId, from, to });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_reconciliation")
  );

  // ── TS-SUBMIT-01 (operator item 3, 2026-09-17) — the Submit-Timesheet ─────
  // gatekeeper pair. Status is a read (any attendance viewer — the Submit
  // button greys itself from it); submit is a WRITE gated on PUT hr:attendance
  // (HR/admin), enforcing: attendance cycle locked (HR force override allowed,
  // audited) + ZERO unresolved anomaly requests (no override), then activating
  // the month's PENDING Payroll Vault run.
  server.tool(
    "hr_timesheet_submission_status",
    "Submission state of a month's timesheet: submitted or not, the vault run it activated, the unresolved anomaly count, and whether the attendance cutoff has passed.",
    {
      month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month as YYYY-MM."),
    },
    withToolError(async ({ month }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const state = await isTimesheetSubmitted(user.tenantId, month);
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    }, "hr_timesheet_submission_status")
  );

  server.tool(
    "hr_timesheet_submit",
    "Submit the month's timesheet — the payroll gatekeeper. Gates: attendance cycle locked (force override = audited HR discretion) and zero unresolved anomaly requests. Effect: the month's payroll run request is activated in the Payroll Vault as PENDING.",
    {
      month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month as YYYY-MM."),
      force: z
        .boolean()
        .optional()
        .describe("HR early-submission override for the attendance-lock gate only. Recorded in the audit trail. Never bypasses the unresolved-anomalies gate."),
    },
    withToolError(async ({ month, force = false }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      // HR/admin logins with no Employee row still submit (audit attributes by
      // email note); an employee-linked login attributes by Employee id.
      const actorEmployeeId = await resolveActingEmployeeId({ user, tenantId: user.tenantId });
      const data = await submitTimesheet({
        tenantId: user.tenantId,
        month,
        force: Boolean(force),
        actorEmployeeId,
        actorNote: user.email ?? `rbac-user-${user.id ?? "unknown"}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_timesheet_submit")
  );
}
