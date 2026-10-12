import { z } from 'zod';
import { mcpCtx } from '../context.js';
import { assertPermission } from '../utils/assertPermission.js';
import { withToolError } from '../utils/toolError.js';
import {
  getAttendanceSetup,
  saveAttendanceSettings,
  previewAttendanceSetup,
  publishAttendanceSetup,
  simulateAttendance,
  restoreAttendanceDraft,
} from '../../services/attendanceSetup.service.js';
import {
  bulkAssignRosters,
  previewDeviceMapping,
  rolloverHolidayCalendar,
  importSetupHolidays,
  assignSetupCalendar,
  createSetupCalendar,
} from '../../services/attendanceSetupOperations.service.js';
import { requireEmployeeActor } from '../../lib/employeeActor.js';

export function registerAttendanceReadinessTools(server) {
  const object = z.record(z.string(), z.unknown());
  const dates = { from: z.string(), to: z.string() };
  const register = (name, description, schema, method, fn) =>
    server.tool(
      name,
      description,
      schema,
      withToolError(async (args) => {
        const { user, permissions } = mcpCtx.getStore() || {};
        if (!user)
          throw Object.assign(new Error('Unauthenticated'), { status: 401 });
        assertPermission(permissions, method, 'hr:payroll', user.isAdmin);
        const actorId =
          user.employeeId ??
          (await requireEmployeeActor(user).catch(() => null));
        const data = await fn({
          ...args,
          tenantId: user.tenantId,
          publishedById: actorId,
          actorId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }, name),
    );
  register(
    'hr_attendance_setup_get',
    'Read attendance setup, employee profiles and published history',
    {},
    'GET',
    getAttendanceSetup,
  );
  register(
    'hr_attendance_setup_save',
    'Save draft timezone, calendar, policy profiles and assignments',
    { settings: object, expectedVersion: z.number().int().min(0) },
    'PUT',
    saveAttendanceSettings,
  );
  register(
    'hr_attendance_setup_preview',
    'Validate every employee and date; preview changes before publication',
    dates,
    'GET',
    previewAttendanceSetup,
  );
  register(
    'hr_attendance_setup_publish',
    'Publish a validated immutable configuration for an operating period',
    { ...dates, reason: z.string().min(1), previewToken: z.string() },
    'POST',
    publishAttendanceSetup,
  );
  register(
    'hr_attendance_setup_restore',
    'Copy saved profile settings to a draft; publication remains a separate step',
    {
      version: z.number().int().positive(),
      expectedVersion: z.number().int().min(0),
    },
    'PUT',
    restoreAttendanceDraft,
  );
  register(
    'hr_attendance_setup_simulate',
    'Explain attendance, overtime and deduction rules for sample punches',
    {
      employeeId: z.number().int().positive(),
      date: z.string(),
      useDraft: z.boolean().optional(),
      punches: z
        .array(z.object({ time: z.string(), type: z.enum(['IN', 'OUT']) }))
        .max(50),
    },
    'GET',
    simulateAttendance,
  );
  register(
    'hr_attendance_rosters_bulk',
    'Preview or apply dated roster assignments with per-employee results',
    {
      employeeIds: z.array(z.number().int().positive()).min(1).max(500),
      data: object,
      dryRun: z.boolean().default(true),
    },
    'PUT',
    bulkAssignRosters,
  );
  register(
    'hr_attendance_device_mapping_preview',
    'Check a sample device identity against dated enrolments',
    { deviceUserId: z.string(), sn: z.string().optional(), date: z.string() },
    'GET',
    previewDeviceMapping,
  );
  register(
    'hr_attendance_calendar_rollover',
    'Preview or copy a calendar to another year',
    {
      calendarId: z.number().int().positive(),
      year: z.number().int().min(1900).max(2200),
      dryRun: z.boolean().default(true),
    },
    'POST',
    rolloverHolidayCalendar,
  );
  register(
    'hr_attendance_calendar_create',
    'Create an empty annual calendar',
    {
      name: z.string().min(1).max(150),
      year: z.number().int().min(1900).max(2200),
    },
    'POST',
    createSetupCalendar,
  );
  register(
    'hr_attendance_holidays_import',
    'Validate or import full and partial holidays',
    {
      calendarId: z.number().int().positive(),
      holidays: z.array(object).min(1).max(500),
      dryRun: z.boolean().default(true),
    },
    'POST',
    importSetupHolidays,
  );
  register(
    'hr_attendance_calendar_assign',
    'Assign a calendar from a date, preserving earlier assignments',
    {
      employeeId: z.number().int().positive(),
      calendarId: z.number().int().positive(),
      ...dates,
    },
    'PUT',
    assignSetupCalendar,
  );
}
