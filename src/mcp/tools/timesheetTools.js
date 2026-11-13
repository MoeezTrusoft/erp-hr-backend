// src/mcp/tools/timesheetTools.js — Timesheet LIST + GET + CREATE (补齐 CRUD).
//
// Timesheet has SUBMIT/APPROVE/REJECT via existing tools; this adds LIST, GET, CREATE.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getTimesheets, getTimesheetById, createTimesheet } from "../../services/timesheetService.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTimesheetTools(server) {
  server.tool(
    "hr_timesheet_list",
    "List timesheets with optional filters (employee, period, status)",
    {
      employeeId: z.union([z.number(), z.string()]).optional().describe("Filter by employee ID"),
      periodStart: z.string().optional().describe("Period start (ISO 8601)"),
      periodEnd: z.string().optional().describe("Period end (ISO 8601)"),
      status: z.string().optional().describe("Filter by status"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:timesheet", user.isAdmin);
      const data = await getTimesheets({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_timesheet_list")
  );

  server.tool(
    "hr_timesheet_get",
    "Get a timesheet by ID",
    {
      id: z.union([z.number(), z.string()]).describe("Timesheet ID"),
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
    },
    withToolError(async ({ id, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:timesheet", user.isAdmin);
      const data = await getTimesheetById(id, employeeId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_timesheet_get")
  );

  server.tool(
    "hr_timesheet_create",
    "Create a new timesheet for an employee period",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      periodStart: z.string().describe("Period start (ISO 8601)"),
      periodEnd: z.string().describe("Period end (ISO 8601)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:timesheet", user.isAdmin);
      const data = await createTimesheet({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_timesheet_create")
  );
}
