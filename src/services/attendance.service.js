import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { attendanceRecordedEvent } from "./hrEvents.js";

// C.2 — verified tenant (T-P2.1) threaded in as a `tenantId` field (on the data
// object) / trailing param; folded into attendance reads and stamped on the
// check-in create, fail-closed so tenant B can never read/mutate tenant A's
// attendance records. Employee carries snake_case `tenant_id` (REQ-007).

function parseCheckInInput({ date, check_in, timestamp }) {
  if (timestamp) {
    const ts = new Date(timestamp);
    if (Number.isNaN(ts.getTime())) throw new Error("Invalid timestamp");
    return ts;
  }

  if (!date) throw new Error("date is required");
  if (!check_in) throw new Error("check_in is required");

  const parsed = new Date(`${date} ${check_in}`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid check_in/date value");
  return parsed;
}

function getDayRange(dt) {
  const start = new Date(dt);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dt);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function resolveStatus(checkInTs, providedStatus) {
  if (providedStatus) return String(providedStatus).toUpperCase();
  const shiftStartRaw = process.env.ATTENDANCE_SHIFT_START || "09:00";
  const graceMinutes = Number(process.env.ATTENDANCE_LATE_GRACE_MINUTES || 15);
  const [h, m] = shiftStartRaw.split(":").map(Number);
  const cutoff = new Date(checkInTs);
  cutoff.setHours(Number.isInteger(h) ? h : 9, Number.isInteger(m) ? m + graceMinutes : graceMinutes, 0, 0);
  return checkInTs > cutoff ? "LATE" : "PRESENT";
}

export const createAttendanceService = async (data) => {
  const { employeeId, date, check_in, status, timestamp, notes, tenantId } = data;

  if (!employeeId) throw new Error("employeeId is required");

  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) throw new Error("Invalid employeeId");

  // ✅ Ensure employee exists (tenant-scoped on snake_case tenant_id when present)
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: empId }),
  });
  if (!employee) throw new Error("Employee not found");

  const parsedCheckIn = parseCheckInInput({ date, check_in, timestamp });
  const { start, end } = getDayRange(parsedCheckIn);
  const computedStatus = resolveStatus(parsedCheckIn, status);

  const existing = await prisma.attendance.findFirst({
    where: scopedWhere(tenantId, {
      employeeId: empId,
      date: {
        gte: start,
        lte: end,
      },
    }),
    orderBy: { id: "desc" },
  });

  // M1-HR: the attendance write + hr.attendance.recorded.v1 outbox event are
  // atomic (outbox-on-write, validate-before-write). The event is ids-only +
  // tenant-scoped; when the row carries no tenant the builder fails-closed and
  // the write still succeeds (no event).
  const attendanceIn = await tenantTransaction(prisma, async (tx) => {
    const row = existing
      ? await tx.attendance.update({
        where: { id: existing.id },
        data: {
          check_in: existing.check_in
            ? new Date(Math.min(existing.check_in.getTime(), parsedCheckIn.getTime()))
            : parsedCheckIn,
          status: computedStatus,
          ...(notes !== undefined ? { remarks: notes } : {}),
        },
      })
      : await tx.attendance.create({
        data: scopedData(tenantId, {
          employeeId: empId,
          date: start,
          check_in: parsedCheckIn,
          status: computedStatus,
          ...(notes !== undefined ? { remarks: notes } : {}),
        }),
      });

    const event = attendanceRecordedEvent(
      { id: row.id, employeeId: empId, action: 'checkin', at: parsedCheckIn.toISOString(), tenantId: row.tenantId ?? tenantId },
      { actorId: data?.ctx?.actorId ?? empId, correlationId: data?.ctx?.correlationId }
    );
    if (event) await enqueueHrDomainEvent(tx, event);

    return row;
  });

   // Log the update action
    await logAction({
      employeeId: 1,
      type: "Check In", // 👈 changed from CREATE to UPDATE
      module: "Attandance",
      result: "SUCCESS",
      notes: `Attandance check In "${empId}" successfully`,
    });
  return attendanceIn;
};
export const checkOutService = async (employeeId, tenantId) => {
  return checkOutServiceWithTimestamp(employeeId, undefined, tenantId);
};

export const checkOutServiceWithTimestamp = async (employeeId, timestamp, tenantId) => {
  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) throw new Error("Invalid employeeId");

  const attendance = await prisma.attendance.findFirst({
    where: scopedWhere(tenantId, { employeeId: empId }),
    orderBy: { date: "desc" }
  });

  if (!attendance || attendance.check_out)
    throw new Error("No active check-in found");

  const checkOutTime = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(checkOutTime.getTime())) throw new Error("Invalid checkout timestamp");

  const totalHours =
    (checkOutTime - attendance.check_in) / (1000 * 60 * 60);

  // M1-HR: the check-out write + hr.attendance.recorded.v1 (action=checkout)
  // outbox event are atomic.
  const checkOut = await tenantTransaction(prisma, async (tx) => {
    const row = await tx.attendance.update({
      where: { id: attendance.id },
      data: { check_out: checkOutTime, total_hours: totalHours }
    });

    const event = attendanceRecordedEvent(
      { id: row.id, employeeId: empId, action: 'checkout', at: checkOutTime.toISOString(), tenantId: row.tenantId ?? tenantId },
      { actorId: empId }
    );
    if (event) await enqueueHrDomainEvent(tx, event);

    return row;
  });

  // Log the update action
  await logAction({
    employeeId: 1,
    type: "Check Out", // 👈 changed from CREATE to UPDATE
    module: "Attandance",
    result: "SUCCESS",
    notes: `CHeck Out "${1}" updated successfully`,
  });
  return checkOut;
};

export const getAttendanceByEmployee = async (employeeId, tenantId) => {
  return prisma.attendance.findMany({
    where: scopedWhere(tenantId, { employeeId }),
    orderBy: { date: "desc" }
  });
};

export const listAttendanceRecords = async ({ date, limit = 100, tenantId } = {}) => {
  const target = date ? new Date(date) : new Date();
  const start = new Date(target);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return prisma.attendance.findMany({
    where: scopedWhere(tenantId, {
      date: {
        gte: start,
        lt: end,
      },
    }),
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
    orderBy: [{ check_in: "desc" }, { date: "desc" }],
    take: Number(limit) || 100,
  });
};
