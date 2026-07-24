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
  getAbsenteeismTrend,
  listCheckInOuts,
} from "../../services/timesheetReport.service.js";
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
    },
    withToolError(async ({ from, to }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getTimesheetKpis({ tenantId: user.tenantId, from, to });
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
      status: z.enum(["on-time", "late", "half-day", "absent"]).optional().describe("Display status filter — one of on-time | late | half-day | absent (mapped to the stored enum)."),
      from: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive start of the date range on Attendance.date."),
      to: z.string().optional().describe("ISO date string (YYYY-MM-DD); inclusive end of the date range on Attendance.date."),
      employeeId: z.string().optional().describe("Exact employee id to filter by."),
      sortBy: z.enum(["date", "employee", "status", "checkIn"]).optional().describe("Sort column — one of date | employee | status | checkIn (default date)."),
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
}
