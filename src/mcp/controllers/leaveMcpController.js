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
import { resolveActingEmployeeId } from "../../lib/actingEmployee.js";

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
  // The acting employee (may be null for a super-admin with no linked Employee).
  const actingId = await resolveActingEmployeeId(user, { tenantId: user.tenantId });
  // Subject of the request: an explicit employeeId (on-behalf) wins; else the
  // caller's own resolved employee (self-service).
  if (!body.employeeId) body.employeeId = actingId ?? undefined;
  // Creator FK must be a valid Employee — NEVER NaN. Acting employee, else fall
  // back to the request's own subject (a self-service create by that employee).
  body.createdById =
    actingId ??
    (await resolveActingEmployeeId(user, {
      tenantId: user.tenantId,
      fallbackEmployeeId: body.employeeId,
    }));
  if (body.createdById == null) {
    throw Object.assign(
      new Error(
        "Could not resolve an acting employee for this leave request. " +
          "Pass a valid employeeId, or link an Employee to your account."
      ),
      { status: 400 }
    );
  }
  return runController(createLeaveRequest, { user, body });
};
// approverId/createdById on the approval row are NOT-NULL Employee FKs. A
// super-admin carries no session employeeId (no x-employee-id), so resolve one
// (explicit arg → session → userId → email) and thread it on the body; the
// controller prefers it over the empty header. Fail with a clear 400.
const resolveReviewerOrThrow = async (user, explicit) => {
  const approverId = await resolveActingEmployeeId(user, { explicit, tenantId: user.tenantId });
  if (approverId == null) {
    throw Object.assign(
      new Error(
        "Could not resolve the acting reviewer. Pass approverId, or link an Employee to your account."
      ),
      { status: 400 }
    );
  }
  return approverId;
};

export const mcpApproveLeaveRequest = async (user, id, { approverId: explicit, ...rest } = {}) => {
  const approverId = await resolveReviewerOrThrow(user, explicit);
  return runController(approveLeaveRequest, {
    user,
    params: { id: String(id) },
    body: { ...rest, approverId, createdById: approverId },
  });
};
// The service (and its outbox reason) reads `comments`; the tool exposes the
// rejection note as `reason` (matching the FE + Bruno callers) so map it here.
export const mcpRejectLeaveRequest = async (user, id, { reason, approverId: explicit, ...rest } = {}) => {
  const approverId = await resolveReviewerOrThrow(user, explicit);
  return runController(rejectLeaveRequest, {
    user,
    params: { id: String(id) },
    body: {
      ...rest,
      approverId,
      createdById: approverId,
      ...(reason !== undefined ? { comments: reason } : {}),
    },
  });
};
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
