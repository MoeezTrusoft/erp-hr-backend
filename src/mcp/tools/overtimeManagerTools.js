// src/mcp/tools/overtimeManagerTools.js — Overtime & Shift MANAGER-view MCP tools.
//
// Surfaces the HR manager-facing "Overtime & Shift" screens as MCP tools: the
// team overview KPIs, the weekly team roster, the monthly overtime trend, the
// at-risk list, the pending-approvals list (read), and the bulk shift-assign
// write (gated POST). All handlers resolve the request context locally
// (getCtx over mcpCtx.getStore()) and pass the verified tenant into the
// tenant-scoped service. Reads gate on hr:attendance VIEW; the write on CREATE.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getOvertimeManagerOverview,
  getShiftRosterWeek,
  getOvertimeTrend,
  getOvertimeAtRisk,
  listPendingOvertimeApprovals,
  bulkAssignShifts,
} from "../../services/overtimeManager.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOvertimeManagerTools(server) {
  server.tool(
    "hr_ot_manager_overview",
    "Manager overview KPIs: team on shift now, pending OT approvals, total approved OT this month, employees at ≥90% of the monthly OT limit",
    {},
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeManagerOverview(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_ot_manager_overview")
  );

  server.tool(
    "hr_shift_roster_week",
    "Weekly team shift roster (7 days). One row per employee with a per-day shift; days with no assignment show as off. Optional department filter",
    {
      department: z.string().optional(),
      weekStart: z.string().optional().describe("ISO date; defaults to the current week (Monday)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getShiftRosterWeek(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_roster_week")
  );

  server.tool(
    "hr_ot_trend",
    "Monthly overtime trend over the last ~6 months for a bar chart: approved hours plus pending/approved/rejected counts per month",
    {},
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeTrend(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_ot_trend")
  );

  server.tool(
    "hr_ot_at_risk",
    "Employees at risk of the monthly OT limit (approved OT this month ≥ 80% of the limit), with hours, limit, and pct",
    {},
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeAtRisk(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_ot_at_risk")
  );

  server.tool(
    "hr_ot_pending_approvals_list",
    "Paginated list of PENDING overtime requests (manager approval queue). Optional department filter",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      department: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listPendingOvertimeApprovals(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_ot_pending_approvals_list")
  );

  server.tool(
    "hr_shift_bulk_assign",
    "Bulk-create shift assignments for the team (tenant-stamped). Returns the created count",
    {
      assignments: z
        .array(
          z.object({
            employeeId: z.union([z.number(), z.string()]),
            date: z.string().describe("ISO 8601 date/datetime"),
            shiftType: z.enum(["morning", "evening", "night"]),
            workMode: z.enum(["remote", "hybrid", "onsite"]),
            fromTime: z.string().optional(),
            toTime: z.string().optional(),
            templateId: z.union([z.number(), z.string()]).optional(),
          })
        )
        .min(1),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await bulkAssignShifts(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_bulk_assign")
  );
}
