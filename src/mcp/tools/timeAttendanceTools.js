// src/mcp/tools/timeAttendanceTools.js — MCP facade for the Time & Attendance
// DASHBOARD (summary KPIs, paginated records, export, pending approvals).
// Read-only surface; all tools gate on hr:attendance VIEW and tenant-scope via
// the request ctx (user.tenantId). Companion service: timeAttendance.service.js.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getAttendanceDashboard,
  listAttendanceRecords,
  exportAttendanceRecords,
  listPendingApprovals,
} from "../../services/timeAttendance.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTimeAttendanceTools(server) {
  server.tool(
    "hr_attendance_dashboard_get",
    "Time & Attendance dashboard summary KPIs for a day or date window (present, on-time/late arrival %, WFH, workforce, absent, leave, unplanned, absenteeism trend)",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      from: z.string().optional().describe("YYYY-MM-DD window start"),
      to: z.string().optional().describe("YYYY-MM-DD window end"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getAttendanceDashboard(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_dashboard_get")
  );

  server.tool(
    "hr_attendance_records_dashboard",
    "Paginated attendance records for the dashboard grid (worked/overtime/target hours, pending flag). Supports search, status/department/date filters, and sort.",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      q: z.string().optional().describe("Search by employee name"),
      status: z.enum(["PRESENT", "ABSENT", "LATE"]).optional(),
      department: z.string().optional().describe("Business unit name"),
      from: z.string().optional().describe("YYYY-MM-DD date filter start"),
      to: z.string().optional().describe("YYYY-MM-DD date filter end"),
      sort: z.enum(["date", "status", "workedHours"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listAttendanceRecords(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_records_dashboard")
  );

  server.tool(
    "hr_attendance_dashboard_export",
    "Export attendance records (csv|pdf|png) with the same filters as the records grid. Returns base64 file content.",
    {
      format: z.enum(["csv", "pdf", "png"]),
      q: z.string().optional(),
      status: z.enum(["PRESENT", "ABSENT", "LATE"]).optional(),
      department: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      sort: z.enum(["date", "status", "workedHours"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await exportAttendanceRecords(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_dashboard_export")
  );

  server.tool(
    "hr_attendance_pending_approvals",
    "List time & attendance items awaiting approval (best-effort from SUBMITTED timesheets): employee, request name, date, time hours, reason.",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listPendingApprovals(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_pending_approvals")
  );
}
