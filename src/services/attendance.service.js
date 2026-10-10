import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as a `tenantId` field (on the data
// object) / trailing param; folded into attendance reads and stamped on the
// check-in create, fail-closed so tenant B can never read/mutate tenant A's
// attendance records. Employee carries snake_case `tenant_id` (REQ-007).

// Direct/manual punches are evidence, evaluated by the same published policy
// as device punches. HR day corrections remain the separate audited workflow.
export const createAttendanceService = async (data) => {
  const { receiveCapture } = await import("./attendanceCapture.service.js");
  const timestamp =
    data.timestamp ??
    (data.date && data.check_in
      ? `${data.date}T${data.check_in.length === 5 ? data.check_in + ":00" : data.check_in}`
      : new Date().toISOString());
  return receiveCapture({
    source: "MANUAL",
    notes: data.notes,
    tenantId: data.tenantId,
    actorId: data.actorId,
    manualEmployeeId: Number(data.employeeId),
    requestKey: data.requestKey,
    rows: [`${data.employeeId}\t${timestamp}\t0\t0\t0`],
  });
};
export const checkOutService = (employeeId, tenantId) =>
  checkOutServiceWithTimestamp(employeeId, undefined, tenantId);
export const checkOutServiceWithTimestamp = async (
  employeeId,
  timestamp,
  tenantId,
  actorId,
  requestKey,
  notes,
) => {
  const { receiveCapture } = await import("./attendanceCapture.service.js");
  return receiveCapture({
    source: "MANUAL",
    tenantId,
    actorId,
    requestKey,
    notes,
    manualEmployeeId: Number(employeeId),
    rows: [`${employeeId}\t${timestamp ?? new Date().toISOString()}\t1\t0\t0`],
  });
};

export const getAttendanceByEmployee = async (employeeId, tenantId) => {
  return prisma.attendance.findMany({
    where: scopedWhere(tenantId, { employeeId }),
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
};

export const listAttendanceRecords = async ({
  date,
  limit = 100,
  tenantId,
  employeeId,
} = {}) => {
  const target = date ? new Date(date) : new Date();
  const start = new Date(target);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  // HR-RBAC-01 T1.5 — employee-scope pin. When the tool layer forces an
  // employeeId (a VIEW-only session), the where-clause narrows to that person's
  // rows; a forced pin of null (unbound employee session) matches NOTHING
  // (Prisma `in: []` semantics) — fail-closed, never the whole tenant.
  const scope = { date: { gte: start, lt: end } };
  if (employeeId !== undefined) {
    const pin = Number(employeeId);
    scope.employeeId = Number.isInteger(pin) && pin > 0 ? pin : { in: [] };
  }

  return prisma.attendance.findMany({
    where: scopedWhere(tenantId, scope),
    include: {
      employee: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          job_title: true,
          photo_url: true,
        },
      },
    },
    orderBy: [{ check_in: "desc" }, { date: "desc" }, { id: "desc" }],
    take: Number(limit) || 100,
  });
};
