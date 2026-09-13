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
  getHolidaysByCalendar,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  getUpcomingHolidays,
  getEmployeeHolidays,
  assignEmployeeToCalendar,
  getEmployeeCalendarAssignments,
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

  // ── Day-level holiday management (Phase B — HR marks holidays per calendar) ──

  server.tool(
    "hr_holiday_list",
    "List holidays of one calendar (optionally filtered by date range)",
    {
      calendarId: z.union([z.number(), z.string()]).describe("Holiday calendar ID"),
      from: z.string().optional().describe("ISO date — inclusive lower bound"),
      to: z.string().optional().describe("ISO date — inclusive upper bound"),
    },
    withToolError(async ({ calendarId, from, to }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getHolidaysByCalendar(calendarId, { startDate: from, endDate: to });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_list")
  );

  server.tool(
    "hr_holiday_create",
    "Create a holiday in a calendar (future dates only — parity with REST rule)",
    {
      holidayCalendarId: z.union([z.number(), z.string()]).describe("Holiday calendar ID"),
      name: z.string().min(1).describe("Holiday name, e.g. Independence Day"),
      date: z.string().describe("ISO 8601 date (YYYY-MM-DD)"),
      description: z.string().optional().describe("Optional description"),
      fullDay: z.boolean().optional().describe("Full-day holiday (default true)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:holiday", user.isAdmin);
      const data = await createHoliday(args, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_create")
  );

  server.tool(
    "hr_holiday_update",
    "Update a holiday identified by calendar + date",
    {
      calendarId: z.union([z.number(), z.string()]).describe("Holiday calendar ID"),
      date: z.string().describe("ISO 8601 date of the existing holiday"),
      name: z.string().optional().describe("New holiday name"),
      description: z.string().optional().describe("New description"),
      fullDay: z.boolean().optional().describe("Full-day flag"),
    },
    withToolError(async ({ calendarId, date, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:holiday", user.isAdmin);
      const result = await updateHoliday(calendarId, date, data, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_holiday_update")
  );

  server.tool(
    "hr_holiday_delete",
    "Delete a holiday identified by calendar + date",
    {
      calendarId: z.union([z.number(), z.string()]).describe("Holiday calendar ID"),
      date: z.string().describe("ISO 8601 date of the holiday to remove"),
    },
    withToolError(async ({ calendarId, date }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:holiday", user.isAdmin);
      const data = await deleteHoliday(calendarId, date, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_delete")
  );

  server.tool(
    "hr_holiday_upcoming",
    "List upcoming holidays across the tenant (default next 30 days)",
    { days: z.number().int().positive().optional().describe("Look-ahead window in days (default 30)") },
    withToolError(async ({ days }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getUpcomingHolidays(days ?? 30);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_upcoming")
  );

  server.tool(
    "hr_holiday_employee",
    "List holidays applicable to one employee (calendar assignment aware)",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      from: z.string().optional().describe("ISO date — inclusive lower bound"),
      to: z.string().optional().describe("ISO date — inclusive upper bound"),
    },
    withToolError(async ({ employeeId, from, to }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getEmployeeHolidays(employeeId, { startDate: from, endDate: to });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_employee")
  );

  server.tool(
    "hr_holiday_employee_assign",
    "Assign (or upsert) an employee onto a holiday calendar, effective-dated",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      calendarId: z.union([z.number(), z.string()]).describe("Holiday calendar ID"),
      effectiveFrom: z.string().optional().describe("ISO datetime (default now)"),
      effectiveTo: z.string().nullable().optional().describe("ISO datetime or null (open-ended)"),
    },
    withToolError(async ({ employeeId, calendarId, effectiveFrom, effectiveTo }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:holiday", user.isAdmin);
      const data = await assignEmployeeToCalendar(
        employeeId,
        calendarId,
        effectiveFrom ? new Date(effectiveFrom) : new Date(),
        effectiveTo ? new Date(effectiveTo) : null,
        user.employeeId || user.userId
      );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_employee_assign")
  );

  server.tool(
    "hr_holiday_employee_assignments",
    "List an employee's holiday-calendar assignments",
    { employeeId: z.union([z.number(), z.string()]).describe("Employee ID") },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getEmployeeCalendarAssignments(employeeId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_holiday_employee_assignments")
  );
}
