// src/mcp/tools/overtimeShiftTools.js — Overtime & Shift Management MCP tools.
//
// Surfaces the HR "Overtime & Shift" screens as MCP tools: shift/overtime
// overview, weekly schedule, overtime request history (read), and the
// create/decide overtime-request writes (gated on hr:attendance). All handlers
// resolve the request context locally (getCtx over mcpCtx.getStore()) and pass
// the verified tenant into the tenant-scoped service.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getOvertimeShiftOverview,
  getShiftScheduleWeek,
  listOvertimeHistory,
  createOvertimeRequest,
  decideOvertimeRequest,
} from "../../services/overtimeShift.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOvertimeShiftTools(server) {
  server.tool(
    "hr_overtime_shift_overview",
    "Current shift, this month's approved/pending overtime hours, and the monthly overtime limit",
    {
      employeeId: z.union([z.number(), z.string()]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeShiftOverview(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_shift_overview")
  );

  server.tool(
    "hr_shift_schedule_week",
    "Current week's shift schedule (Mon..Sun) from the employee's work schedule; off days flagged",
    {
      employeeId: z.union([z.number(), z.string()]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getShiftScheduleWeek(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_schedule_week")
  );

  server.tool(
    "hr_overtime_history_list",
    "Paginated overtime request history (tenant-scoped, newest first)",
    {
      employeeId: z.union([z.number(), z.string()]).optional(),
      status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listOvertimeHistory(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_history_list")
  );

  server.tool(
    "hr_overtime_request_create",
    "Create an overtime request (status PENDING)",
    {
      employeeId: z.union([z.number(), z.string()]),
      date: z.string().describe("ISO 8601 date/datetime"),
      hours: z.coerce.number().positive(),
      project: z.string().optional(),
      reason: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await createOvertimeRequest(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_request_create")
  );

  server.tool(
    "hr_overtime_request_decide",
    "Approve or reject an overtime request; sets decidedAt and approver to the caller",
    {
      id: z.union([z.number(), z.string()]),
      decision: z.enum(["approve", "reject"]),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const approverEmployeeId = user.employeeId ?? user.userId;
      const data = await decideOvertimeRequest(
        { ...args, approverEmployeeId },
        user.tenantId
      );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_request_decide")
  );
}
