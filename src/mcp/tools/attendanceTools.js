import { z } from "zod";
import {
  mcpApproveTimesheet,
  mcpCheckIn,
  mcpCheckOut,
  mcpCreateOvertimeRule,
  mcpCreateTimeEntry,
  mcpCreateTimesheet,
  mcpCreateWorkSchedule,
  mcpDeleteOvertimeRule,
  mcpDeleteTimeEntry,
  mcpDeleteWorkSchedule,
  mcpGetAttendanceByEmployee,
  mcpListOvertimeRules,
  mcpListTimeEntries,
  mcpListTimesheets,
  mcpListWorkSchedules,
  mcpUpdateOvertimeRule,
  mcpUpdateTimeEntry,
  mcpUpdateWorkSchedule,
} from "../controllers/attendanceMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

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
      const data = await mcpGetAttendanceByEmployee(user, employeeId);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_timesheets_list",
    "hr://timesheets",
    { description: "List all employee timesheets" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListTimesheets(user);
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
      const data = await mcpCheckIn(user, args);
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
      const data = await mcpCheckOut(user, args);
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
      const data = await mcpCreateTimesheet(user, args);
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
      const data = await mcpApproveTimesheet(user, timesheetId, rest);
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
      const data = await mcpGetAttendanceByEmployee(user, id);
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
      const data = await mcpListTimeEntries(user);
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
      const data = await mcpCreateTimeEntry(user, args);
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
      const data = await mcpUpdateTimeEntry(user, id, rest);
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
      const data = await mcpDeleteTimeEntry(user, id);
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
      const data = await mcpListWorkSchedules(user);
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
      const data = await mcpCreateWorkSchedule(user, args);
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
      const data = await mcpUpdateWorkSchedule(user, id, rest);
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
      const data = await mcpDeleteWorkSchedule(user, id);
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
      const data = await mcpListOvertimeRules(user);
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
      const data = await mcpCreateOvertimeRule(user, args);
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
      const data = await mcpUpdateOvertimeRule(user, id, rest);
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
      const data = await mcpDeleteOvertimeRule(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
