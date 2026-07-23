import prisma from "../../config/prisma.js";
import { runController } from "./_runner.js";
import {
  getLeaveRequests,
  getLeavePolicies,
  getLeaveBalances,
  getPendingApprovals,
  createLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  createLeavePolicy,
  updateLeavePolicy,
  deleteLeavePolicy,
  updateLeaveBalance,
  runLeaveAccruals,
} from "../../controllers/leave.controller.js";
import { getHolidays, createHoliday } from "../../controllers/holiday.controller.js";

export const mcpListLeaveRequests = (user, query = {}) => runController(getLeaveRequests, { user, query });
export const mcpListLeavePolicies = (user) => runController(getLeavePolicies, { user });
export const mcpListLeaveBalances = (user) => runController(getLeaveBalances, { user });
export const mcpListPendingLeaveApprovals = (user) => runController(getPendingApprovals, { user });
export const mcpListHolidays = (user) => runController(getHolidays, { user });

const resolveLeavePolicyId = async (leaveType) => {
  const code = String(leaveType || "").trim();
  if (!code) throw new Error("Leave type is required");

  const policy = await prisma.leavePolicy.findFirst({
    where: {
      active: true,
      OR: [
        { leaveTypeCode: { equals: code, mode: "insensitive" } },
        { name: { contains: code, mode: "insensitive" } },
      ],
    },
  });

  if (!policy) throw new Error(`Leave policy not found for type: ${leaveType}`);
  return policy.id;
};

// The acting employee must be present for writes that stamp a required
// createdById FK (leave policy / holiday). ctx.employeeId is sourced from the
// verified token; without it the Prisma FK write fails with an opaque error, so
// assert it up-front and return a clear 400 instead.
const assertActingEmployee = (user) => {
  const employeeId = user?.employeeId ?? user?.userId;
  if (employeeId == null || employeeId === "" || Number.isNaN(Number(employeeId))) {
    throw Object.assign(new Error("Acting employee context is required"), { status: 400 });
  }
};

export const mcpCreateLeaveRequest = async (user, data) => {
  const body = { ...data };
  if (body.leaveType && !body.leavePolicyId) {
    body.leavePolicyId = await resolveLeavePolicyId(body.leaveType);
  }
  if (!body.employeeId) {
    body.employeeId = user.employeeId || user.userId;
  }
  return runController(createLeaveRequest, { user, body });
};
export const mcpApproveLeaveRequest = (user, id, data) => runController(approveLeaveRequest, { user, params: { id: String(id) }, body: data });
// The service (and its outbox reason) reads `comments`; the tool exposes the
// rejection note as `reason` (matching the FE + Bruno callers) so map it here.
export const mcpRejectLeaveRequest = (user, id, { reason, ...rest } = {}) =>
  runController(rejectLeaveRequest, {
    user,
    params: { id: String(id) },
    body: { ...rest, ...(reason !== undefined ? { comments: reason } : {}) },
  });
export const mcpCancelLeaveRequest = (user, id, data) => runController(cancelLeaveRequest, { user, params: { id: String(id) }, body: data });

export const mcpCreateLeavePolicy = (user, data) => {
  assertActingEmployee(user);
  return runController(createLeavePolicy, { user, body: data });
};
export const mcpUpdateLeavePolicy = (user, id, data) => runController(updateLeavePolicy, { user, params: { id: String(id) }, body: data });
export const mcpDeleteLeavePolicy = (user, id) => runController(deleteLeavePolicy, { user, params: { id: String(id) } });

export const mcpUpdateLeaveBalance = (user, employeeId, data) =>
  runController(updateLeaveBalance, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpRunLeaveAccruals = (user, data) => runController(runLeaveAccruals, { user, body: data });
export const mcpCreateHoliday = (user, data) => {
  assertActingEmployee(user);
  return runController(createHoliday, { user, body: data });
};
