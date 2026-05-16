import { runController } from "./_runner.js";
import { getSelfProfile, updateSelfProfile, listSelfPayslips, listSelfLeaveBalances } from "../../controllers/self.controller.js";
import { createLeaveRequest } from "../../controllers/leave.controller.js";
import { checkIn, getEmployeeAttendance } from "../../controllers/attendance.controller.js";

export const mcpGetSelfProfile = (user) => runController(getSelfProfile, { user });
export const mcpGetSelfLeaveBalances = (user) => runController(listSelfLeaveBalances, { user });
export const mcpGetSelfPayslips = (user) => runController(listSelfPayslips, { user });
export const mcpGetSelfAttendance = (user) =>
  runController(getEmployeeAttendance, { user, params: { id: String(user.employeeId || user.userId || "") } });

export const mcpUpdateSelfProfile = (user, data) => runController(updateSelfProfile, { user, body: data });
export const mcpCreateSelfLeaveRequest = (user, data) =>
  runController(createLeaveRequest, {
    user,
    body: {
      ...data,
      employeeId: Number(user.employeeId || user.userId),
    },
  });
export const mcpSelfCheckin = (user, data) =>
  runController(checkIn, {
    user,
    body: {
      ...data,
      employeeId: Number(user.employeeId || user.userId),
    },
  });
