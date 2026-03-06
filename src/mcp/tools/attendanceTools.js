import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerAttendanceTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_attendance_list",
    "hr://attendance",
    { description: "Get current user's attendance records" },
    async (uri) => {
      const { user } = getCtx();
      const employeeId = user?.employeeId || user?.userId;
      if (!employeeId) throw Object.assign(new Error("Employee ID not found in session"), { status: 400 });
      const data = await self("GET", `/api/attendance/get-attandance/${employeeId}`, user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_timesheets_list",
    "hr://timesheets",
    { description: "List all employee timesheets" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/time-attendance/timesheets", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_attendance_checkin",
    "Record employee check-in",
    {
      employeeId: z.string().min(1),
      timestamp: z.string().optional().describe("ISO 8601 datetime; defaults to now"),
      location: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/attendance/checkin", user.isAdmin);
      const data = await self("POST", "/api/attendance/checkin", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_attendance_checkout",
    "Record employee check-out",
    {
      employeeId: z.string().min(1),
      timestamp: z.string().optional().describe("ISO 8601 datetime; defaults to now"),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/attendance/checkout", user.isAdmin);
      const data = await self("POST", "/api/attendance/checkout", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_timesheet_submit",
    "Submit a timesheet for approval",
    {
      employeeId: z.string().min(1),
      periodStart: z.string().describe("ISO 8601 date"),
      periodEnd: z.string().describe("ISO 8601 date"),
      entries: z.array(z.object({
        date: z.string(),
        hoursWorked: z.number().positive(),
        projectId: z.string().optional(),
        notes: z.string().optional(),
      })).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/time-attendance/timesheets", user.isAdmin);
      const data = await self("POST", "/api/time-attendance/timesheets", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_timesheet_approve",
    "Approve a submitted timesheet",
    {
      timesheetId: z.string().min(1),
      comment: z.string().optional(),
    },
    withToolError(async ({ timesheetId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/time-attendance/timesheets/${timesheetId}/approve`, user.isAdmin);
      const data = await self("POST", `/api/time-attendance/timesheets/${timesheetId}/approve`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_attendance_get",
    "Get a specific attendance record by employee ID",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", `/hr/api/attendance/get-attandance/${id}`, user.isAdmin);
      const data = await self("GET", `/api/attendance/get-attandance/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── TIME ENTRIES ─────────────────────────────────────────────────────────

  server.resource(
    "hr_time_entries_list",
    "hr://time-entries",
    { description: "List all time entries" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/time-attendance/entries", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_time_entry_create",
    "Create a manual time entry",
    {
      employeeId: z.string().min(1),
      date: z.string().describe("ISO 8601 date"),
      startTime: z.string().describe("ISO 8601 datetime"),
      endTime: z.string().describe("ISO 8601 datetime"),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/time-attendance/entries", user.isAdmin);
      const data = await self("POST", "/api/time-attendance/entries", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_time_entry_update",
    "Update a time entry",
    {
      id: z.string().min(1),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/time-attendance/entries/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/time-attendance/entries/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_time_entry_delete",
    "Delete a time entry",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/time-attendance/entries/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/time-attendance/entries/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── WORK SCHEDULES ────────────────────────────────────────────────────────

  server.resource(
    "hr_work_schedules_list",
    "hr://work-schedules",
    { description: "List all work schedules" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/time-attendance/work-schedules", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_work_schedule_create",
    "Create a work schedule",
    {
      name: z.string().min(1),
      timezone: z.string().optional(),
      shifts: z.array(z.object({
        day: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      })).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/time-attendance/work-schedules", user.isAdmin);
      const data = await self("POST", "/api/time-attendance/work-schedules", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_work_schedule_update",
    "Update a work schedule",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      timezone: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/time-attendance/work-schedules/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/time-attendance/work-schedules/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_work_schedule_delete",
    "Delete a work schedule",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/time-attendance/work-schedules/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/time-attendance/work-schedules/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── OVERTIME RULES ────────────────────────────────────────────────────────

  server.resource(
    "hr_overtime_rules_list",
    "hr://overtime-rules",
    { description: "List all overtime rules" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/time-attendance/overtime-rules", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_overtime_rule_create",
    "Create an overtime rule",
    {
      name: z.string().min(1),
      thresholdHours: z.number().positive().describe("Daily/weekly hours before overtime kicks in"),
      multiplier: z.number().positive().describe("Pay multiplier for overtime hours"),
      type: z.enum(["DAILY", "WEEKLY"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/time-attendance/overtime-rules", user.isAdmin);
      const data = await self("POST", "/api/time-attendance/overtime-rules", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_overtime_rule_update",
    "Update an overtime rule",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      thresholdHours: z.number().optional(),
      multiplier: z.number().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/time-attendance/overtime-rules/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/time-attendance/overtime-rules/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_overtime_rule_delete",
    "Delete an overtime rule",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/time-attendance/overtime-rules/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/time-attendance/overtime-rules/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
