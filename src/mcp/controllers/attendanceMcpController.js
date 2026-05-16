import { runController } from "./_runner.js";
import {
  checkIn,
  checkOut,
  getDailyAttendanceStatusSummary,
  getEmployeeAttendance,
  syncDeviceAttendance,
  testDeviceConnectivity,
} from "../../controllers/attendance.controller.js";
import { getTimesheets, createTimesheet, approveTimesheet } from "../../controllers/timesheetController.js";
import { getTimeEntries, createTimeEntry, updateTimeEntry, deleteTimeEntry } from "../../controllers/timeEntryController.js";
import { getWorkSchedules, createWorkSchedule, updateWorkSchedule, deleteWorkSchedule } from "../../controllers/workScheduleController.js";
import { getOvertimeRules, createOvertimeRule, updateOvertimeRule, deleteOvertimeRule } from "../../controllers/overtimeController.js";

export const mcpGetAttendanceByEmployee = (user, id) => runController(getEmployeeAttendance, { user, params: { id: String(id) } });
export const mcpListTimesheets = (user) => runController(getTimesheets, { user });
export const mcpCheckIn = (user, data) => runController(checkIn, { user, body: data });
export const mcpCheckOut = (user, data) => runController(checkOut, { user, body: data });
export const mcpDeviceConnectivity = (user, data) => runController(testDeviceConnectivity, { user, body: data });
export const mcpDeviceSyncAttendance = (user, data) => runController(syncDeviceAttendance, { user, body: data });
export const mcpAttendanceDailySummary = (user, query) => runController(getDailyAttendanceStatusSummary, { user, query });
export const mcpCreateTimesheet = (user, data) => runController(createTimesheet, { user, body: data });
export const mcpApproveTimesheet = (user, id, data) => runController(approveTimesheet, { user, params: { id: String(id) }, body: data });

export const mcpListTimeEntries = (user) => runController(getTimeEntries, { user });
export const mcpCreateTimeEntry = (user, data) => runController(createTimeEntry, { user, body: data });
export const mcpUpdateTimeEntry = (user, id, data) => runController(updateTimeEntry, { user, params: { id: String(id) }, body: data });
export const mcpDeleteTimeEntry = (user, id) => runController(deleteTimeEntry, { user, params: { id: String(id) } });

export const mcpListWorkSchedules = (user) => runController(getWorkSchedules, { user });
export const mcpCreateWorkSchedule = (user, data) => runController(createWorkSchedule, { user, body: data });
export const mcpUpdateWorkSchedule = (user, id, data) => runController(updateWorkSchedule, { user, params: { id: String(id) }, body: data });
export const mcpDeleteWorkSchedule = (user, id) => runController(deleteWorkSchedule, { user, params: { id: String(id) } });

export const mcpListOvertimeRules = (user) => runController(getOvertimeRules, { user });
export const mcpCreateOvertimeRule = (user, data) => runController(createOvertimeRule, { user, body: data });
export const mcpUpdateOvertimeRule = (user, id, data) => runController(updateOvertimeRule, { user, params: { id: String(id) }, body: data });
export const mcpDeleteOvertimeRule = (user, id) => runController(deleteOvertimeRule, { user, params: { id: String(id) } });
