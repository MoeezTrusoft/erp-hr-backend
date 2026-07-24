// src/mcp/tools/overtimeShiftReportTools.js — read tools for the HR
// "Overtime & Shift Management" screen.
//
// Screen-shaped READ facades over overtimeShiftReport.service.js: OT table,
// 6-month OT trend, KPI tiles, department weekly roster, at-risk employees,
// shift templates (+assigned counts) and shift-swap requests. All are GET /
// hr:attendance (matching the existing OT/shift tools). The screen's WRITE
// actions reuse the EXISTING action tools (see below) — none are recreated here:
//   • request OT         → hr_overtime_request_create   (overtimeShiftTools.js)
//   • decide OT          → hr_overtime_request_decide    (overtimeShiftTools.js)
//   • withdraw OT        → hr_overtime_request_withdraw   (shiftTemplateSwapTools.js)
//   • shift template CRUD→ hr_shift_template_create/update/delete (shiftTemplateSwapTools.js)
//   • create shift swap  → hr_shift_swap_create           (shiftTemplateSwapTools.js)
//   • decide shift swap  → hr_shift_swap_decide           (shiftTemplateSwapTools.js)
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getOvertimeTable,
  getOvertimeTrend6mo,
  getShiftKpis,
  getDeptRosterWeek,
  getAtRiskEmployees,
  listShiftTemplatesWithCount,
  listSwapRequests,
} from "../../services/overtimeShiftReport.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOvertimeShiftReportTools(server) {
  server.tool(
    "hr_overtime_table",
    "Overtime requests table — one row per request with its employee, clock window, hours, reason and status. Filter/sort/paginate.",
    {
      q: z.string().optional().describe("Case-insensitive substring match on employee name"),
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"])
        .optional()
        .describe("Status filter — one of PENDING | APPROVED | REJECTED | WITHDRAWN"),
      employeeId: z.coerce.number().int().optional().describe("Filter to one employee (Employee.id)"),
      from: z.string().optional().describe("Inclusive start date (ISO YYYY-MM-DD) on OvertimeRequest.date"),
      to: z.string().optional().describe("Inclusive end date (ISO YYYY-MM-DD) on OvertimeRequest.date"),
      sortBy: z
        .enum(["date", "status", "hours"])
        .optional()
        .describe("Sort column — date (default) | status | hours"),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeTable({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_table")
  );

  server.tool(
    "hr_overtime_trend",
    "Overtime trend for the last 6 calendar months (including the current month): approved/pending/rejected hours and counts per month.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeTrend6mo({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_trend")
  );

  server.tool(
    "hr_shift_kpis",
    "Overtime & Shift KPI tiles: on-shift now, total employees, pending overtime, total approved overtime this month, and employees approaching the monthly OT limit.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getShiftKpis({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_kpis")
  );

  server.tool(
    "hr_dept_roster_week",
    "Weekly shift roster for a department (employees whose businessUnitId matches): per-day shift per employee (off/leave/holiday → 'off') plus weekly overtime hours.",
    {
      departmentId: z.coerce.number().int().describe("Department id (Employee.businessUnitId) — required"),
      weekStart: z
        .string()
        .optional()
        .describe("ISO date within the target week; the week is resolved Mon–Sun. Defaults to the current week."),
      q: z.string().optional().describe("Case-insensitive substring match on employee name"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Employee rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getDeptRosterWeek({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_dept_roster_week")
  );

  server.tool(
    "hr_overtime_at_risk",
    "Employees at/over 75% of the monthly overtime limit (approved OT this month), sorted by hours descending.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getAtRiskEmployees({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_at_risk")
  );

  server.tool(
    "hr_shift_templates_with_count",
    "Shift templates with the number of shift assignments referencing each (assignedCount). Filter by name / paginate.",
    {
      q: z.string().optional().describe("Case-insensitive substring match on template name"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listShiftTemplatesWithCount({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_templates_with_count")
  );

  server.tool(
    "hr_shift_swaps_list",
    "Shift-swap requests with both parties (requester + target) resolved. Filter by status / employee name; paginate.",
    {
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"])
        .optional()
        .describe("Status filter — one of PENDING | APPROVED | REJECTED | WITHDRAWN"),
      q: z.string().optional().describe("Case-insensitive substring match on either party's name"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listSwapRequests({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_swaps_list")
  );
}
