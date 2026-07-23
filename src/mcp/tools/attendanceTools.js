import { z } from "zod";
import {
  mcpApproveTimesheet,
  mcpCheckIn,
  mcpCheckOut,
  mcpAttendanceDailySummary,
  mcpCreateOvertimeRule,
  mcpCreateTimeEntry,
  mcpCreateTimesheet,
  mcpDeviceConnectivity,
  mcpDeviceSyncAttendance,
  mcpCreateWorkSchedule,
  mcpDeleteOvertimeRule,
  mcpDeleteTimeEntry,
  mcpDeleteWorkSchedule,
  mcpGetAttendanceByEmployee,
  mcpListAttendanceRecords,
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
import { toListEnvelope, toListQuery } from "../utils/listEnvelope.js";

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

  server.resource(
    "hr_attendance_records_list",
    "hr://attendance/records",
    { description: "List attendance records for a day" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListAttendanceRecords(user, {});
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_attendance_checkin",
    "Record employee check-in (creates/updates the day's attendance row; auto-computes PRESENT/LATE). notes is persisted to Attendance.remarks.",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string); must resolve to an existing tenant-scoped Employee"),
      timestamp: z.string().optional().describe("ISO 8601 datetime; defaults to now"),
      notes: z.string().optional().describe("Free-text note, persisted to Attendance.remarks"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
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
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await mcpCheckOut(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_attendance_device_connectivity",
    "Check if biometric attendance device is reachable on TCP",
    {
      host: z.string().optional().describe("Device IP/hostname; defaults to ATTENDANCE_DEVICE_HOST"),
      port: z.number().int().positive().optional().describe("Device TCP port; defaults to 4370"),
      timeoutMs: z.number().int().positive().optional().describe("Connection timeout in milliseconds"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await mcpDeviceConnectivity(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_attendance_device_sync",
    "Sync biometric punches into attendance with auto late calculation",
    {
      punches: z.array(z.object({
        employeeId: z.union([z.number(), z.string()]).optional().describe("Employee id (references Employee)"),
        employeeCode: z.string().optional().describe("Employee code (device/HR code) — alternate identity"),
        deviceUserId: z.string().optional().describe("Biometric device user id — alternate identity"),
        userId: z.string().optional().describe("Device/login user id — alternate identity"),
        timestamp: z.string().describe("ISO 8601 datetime of the punch"),
        type: z.string().optional().describe("Punch direction: IN or OUT (optional; falls back to time-order)"),
      }).refine(
        (p) => p.employeeId != null || p.employeeCode != null || p.deviceUserId != null || p.userId != null,
        { message: "Each punch must carry at least one of employeeId, employeeCode, deviceUserId, or userId" }
      )).min(1),
      shiftStart: z.string().optional().describe("HH:mm, default 09:00"),
      lateGraceMinutes: z.number().int().min(0).optional().describe("Grace minutes after shift start"),
      dryRun: z.boolean().optional().describe("Preview actions only; no DB writes"),
      testConnectivity: z.boolean().optional().describe("Check device reachability before sync"),
      host: z.string().optional(),
      port: z.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await mcpDeviceSyncAttendance(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_attendance_daily_summary",
    "Get present/late/absent totals for a day",
    {
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
      shiftStart: z.string().optional().describe("HH:mm, default 09:00"),
      lateGraceMinutes: z.union([z.number(), z.string()]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await mcpAttendanceDailySummary(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_timesheet_submit",
    "Create a timesheet (status DRAFT) for the calling employee over a pay period. Hours are derived server-side from the period's unassigned time entries (create those first via hr_time_entry_create).",
    {
      period_start: z.string().describe("ISO 8601 date YYYY-MM-DD; inclusive start of the pay period"),
      period_end: z.string().describe("ISO 8601 date YYYY-MM-DD; inclusive end of the pay period"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      if (!user.employeeId) throw Object.assign(new Error("No employeeId in session"), { status: 400 });
      const data = await mcpCreateTimesheet(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_timesheet_approve",
    "Approve a submitted timesheet. The approver is the calling employee (session-derived); the timesheet must be in SUBMITTED status.",
    {
      timesheetId: z.string().min(1).describe("Timesheet id to approve (references Timesheet)"),
      comments: z.string().optional().describe("Approval comment, stored on the TimeApproval record"),
    },
    withToolError(async ({ timesheetId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      if (!user.employeeId) throw Object.assign(new Error("No employeeId in session (approver required)"), { status: 400 });
      const data = await mcpApproveTimesheet(user, timesheetId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // IC-1: the HR FE binds the Attendance LIST screen to the `hr_attendance_list`
  // TOOL (tools/call). A same-named RESOURCE already exists (resources/read) but
  // callTool could not resolve it, so the screen fell back to mock data. This
  // TOOL wraps the existing records list service, tenant-scoped via ctx, and
  // returns the FE-expected paginated envelope. Gated on hr:attendance:VIEW.
  server.tool(
    "hr_attendance_list",
    "List attendance records (paginated) for the HR attendance screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      date: z.string().optional().describe("YYYY-MM-DD filter"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await mcpListAttendanceRecords(user, toListQuery(args));
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_attendance_list")
  );

  server.tool(
    "hr_attendance_get",
    "Get a specific attendance record by employee ID",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
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
    "Create a manual time entry for the calling employee (entry_type MANUAL_ENTRY). work_date is derived from start_time.",
    {
      start_time: z.string().describe("ISO 8601 datetime; also seeds work_date"),
      end_time: z.string().optional().describe("ISO 8601 datetime; omit for an open-ended entry (no duration)"),
      work_type: z.enum(["REGULAR", "OVERTIME", "HOLIDAY", "VACATION", "SICK"]).optional().describe("enum WorkType — one of REGULAR | OVERTIME | HOLIDAY | VACATION | SICK; defaults to REGULAR"),
      note: z.string().optional().describe("Free-text note on the entry"),
      sourceId: z.string().optional().describe("Time-source id (references Source)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      if (!user.employeeId) throw Object.assign(new Error("No employeeId in session"), { status: 400 });
      const data = await mcpCreateTimeEntry(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_time_entry_update",
    "Update a time entry (owner-only). Duration is recomputed when start_time/end_time change.",
    {
      id: z.string().min(1).describe("Time entry id (references TimeEntry)"),
      start_time: z.string().optional().describe("ISO 8601 datetime"),
      end_time: z.string().optional().describe("ISO 8601 datetime"),
      work_type: z.enum(["REGULAR", "OVERTIME", "HOLIDAY", "VACATION", "SICK"]).optional().describe("enum WorkType — one of REGULAR | OVERTIME | HOLIDAY | VACATION | SICK"),
      note: z.string().optional().describe("Free-text note on the entry"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
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
      assertPermission(permissions, "DELETE", "hr:attendance", user.isAdmin);
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
    "Create a work schedule for an employee. Rejects periods that overlap an existing schedule for the same employee.",
    {
      employeeId: z.string().min(1).describe("Employee the schedule is for (references Employee); defaults to the caller when omitted"),
      schedule_name: z.string().min(1).describe("Human-readable schedule name"),
      effective_start_date: z.string().describe("ISO 8601 date YYYY-MM-DD; inclusive start of the schedule"),
      total_hours_per_week: z.number().positive().describe("Contracted hours per week"),
      effective_end_date: z.string().optional().describe("ISO 8601 date YYYY-MM-DD; open-ended when omitted"),
      schedule_pattern: z.record(z.string()).optional().describe("JSON map of day -> shift window, e.g. { MON: '09:00-17:00' }"),
      overtimeRuleId: z.string().optional().describe("Overtime rule id to attach (references OvertimeRule)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await mcpCreateWorkSchedule(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_work_schedule_update",
    "Update a work schedule (partial). Only the fields you send are changed.",
    {
      id: z.string().min(1).describe("Work schedule id (references WorkSchedule)"),
      schedule_name: z.string().optional().describe("Human-readable schedule name"),
      effective_start_date: z.string().optional().describe("ISO 8601 date YYYY-MM-DD"),
      effective_end_date: z.string().optional().describe("ISO 8601 date YYYY-MM-DD; null-out by omitting"),
      total_hours_per_week: z.number().positive().optional().describe("Contracted hours per week"),
      schedule_pattern: z.record(z.string()).optional().describe("JSON map of day -> shift window"),
      overtimeRuleId: z.string().optional().describe("Overtime rule id to attach (references OvertimeRule)"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
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
      assertPermission(permissions, "DELETE", "hr:attendance", user.isAdmin);
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
    "Create an overtime rule. Only name is required; thresholds and rates fall back to Prisma defaults (8h/40h daily/weekly, 1.5x rates).",
    {
      name: z.string().min(1).describe("Overtime rule name"),
      description: z.string().optional().describe("Optional description"),
      daily_hours_threshold: z.number().positive().optional().describe("Daily hours before overtime applies (default 8)"),
      weekly_hours_threshold: z.number().positive().optional().describe("Weekly hours before overtime applies (default 40)"),
      daily_overtime_rate: z.number().positive().optional().describe("Daily overtime pay multiplier (default 1.5)"),
      weekly_overtime_rate: z.number().positive().optional().describe("Weekly overtime pay multiplier (default 1.5)"),
      max_hours_per_day: z.number().positive().optional().describe("Compliance cap on daily hours"),
      max_hours_per_week: z.number().positive().optional().describe("Compliance cap on weekly hours"),
      is_active: z.boolean().optional().describe("Whether the rule is active (default true)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await mcpCreateOvertimeRule(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_overtime_rule_update",
    "Update an overtime rule (partial). Only the fields you send are changed.",
    {
      id: z.string().min(1).describe("Overtime rule id (references OvertimeRule)"),
      name: z.string().optional().describe("Overtime rule name"),
      description: z.string().optional().describe("Optional description"),
      daily_hours_threshold: z.number().positive().optional().describe("Daily hours before overtime applies"),
      weekly_hours_threshold: z.number().positive().optional().describe("Weekly hours before overtime applies"),
      daily_overtime_rate: z.number().positive().optional().describe("Daily overtime pay multiplier"),
      weekly_overtime_rate: z.number().positive().optional().describe("Weekly overtime pay multiplier"),
      max_hours_per_day: z.number().positive().optional().describe("Compliance cap on daily hours"),
      max_hours_per_week: z.number().positive().optional().describe("Compliance cap on weekly hours"),
      is_active: z.boolean().optional().describe("Whether the rule is active"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
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
      assertPermission(permissions, "DELETE", "hr:attendance", user.isAdmin);
      const data = await mcpDeleteOvertimeRule(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
