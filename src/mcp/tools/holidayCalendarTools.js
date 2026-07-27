// src/mcp/tools/holidayCalendarTools.js — Holiday Calendar management MCP tools.
//
// Five tools for HolidayCalendar CRUD, all gated on hr:holiday and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getHolidayCalendars,
  getHolidayCalendarById,
  createHolidayCalendar,
  updateHolidayCalendar,
  deleteHolidayCalendar,
} from "../../services/holiday.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerHolidayCalendarTools(server) {
  server.tool(
    "hr_holiday_calendar_list",
    "List all holiday calendars with optional search and pagination",
    {
      q: z.string().optional().describe("Search by calendar name"),
      page: z.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.number().int().positive().optional().describe("Rows per page (default 20)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getHolidayCalendars(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_calendar_list")
  );

  server.tool(
    "hr_holiday_calendar_get",
    "Get a single holiday calendar by ID with its holidays",
    { id: z.union([z.number(), z.string()]).describe("Holiday calendar ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getHolidayCalendarById(id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_calendar_get")
  );

  server.tool(
    "hr_holiday_calendar_create",
    "Create a new holiday calendar with optional initial holidays",
    {
      name: z.string().min(1).describe("Calendar name"),
      year: z.number().int().describe("Calendar year"),
      regionId: z.union([z.number(), z.string()]).optional().describe("Associated region ID"),
      holidays: z.array(z.object({
        name: z.string().min(1).describe("Holiday name"),
        date: z.string().describe("ISO 8601 date"),
        type: z.string().optional().describe("Holiday type"),
      })).optional().describe("Initial holidays to include"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:holiday", user.isAdmin);
      const data = await createHolidayCalendar(args, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_calendar_create")
  );

  server.tool(
    "hr_holiday_calendar_update",
    "Update a holiday calendar",
    {
      id: z.union([z.number(), z.string()]).describe("Calendar ID"),
      name: z.string().optional().describe("Calendar name"),
      year: z.number().int().optional().describe("Calendar year"),
      regionId: z.union([z.number(), z.string()]).optional().describe("Associated region ID"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:holiday", user.isAdmin);
      const result = await updateHolidayCalendar(id, data, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_holiday_calendar_update")
  );

  server.tool(
    "hr_holiday_calendar_delete",
    "Delete a holiday calendar",
    { id: z.union([z.number(), z.string()]).describe("Calendar ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:holiday", user.isAdmin);
      const data = await deleteHolidayCalendar(id, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_calendar_delete")
  );
}
