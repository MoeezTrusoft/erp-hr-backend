import { runController } from "./_runner.js";
import { getSelfProfile, updateSelfProfile, listSelfPayslips, listSelfLeaveBalances } from "../../controllers/self.controller.js";
import { createLeaveRequest } from "../../controllers/leave.controller.js";
import { checkIn, getEmployeeAttendance } from "../../controllers/attendance.controller.js";
import { requireEmployeeActor } from "../../lib/employeeActor.js";

export const mcpGetSelfProfile = (user) => runController(getSelfProfile, { user });
export const mcpGetSelfLeaveBalances = (user) => runController(listSelfLeaveBalances, { user });
export const mcpGetSelfPayslips = (user) => runController(listSelfPayslips, { user });
export const mcpGetSelfAttendance = async (user) =>
  runController(getEmployeeAttendance, { user, params: { id: String(await requireEmployeeActor(user)) } });

export const mcpUpdateSelfProfile = (user, data) => runController(updateSelfProfile, { user, body: data });
export const mcpCreateSelfLeaveRequest = async (user, data) =>
  runController(createLeaveRequest, {
    user,
    body: {
      ...data,
      employeeId: await requireEmployeeActor(user),
    },
  });
export const mcpSelfCheckin = async (user, data) =>
  runController(checkIn, {
    user,
    body: {
      ...data,
      employeeId: await requireEmployeeActor(user),
    },
  });
