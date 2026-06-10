import { PrismaClient } from '@prisma/client';
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

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
  const { employeeId, date, check_in, status, timestamp } = data;

  if (!employeeId) throw new Error("employeeId is required");

  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) throw new Error("Invalid employeeId");

  // ✅ Ensure employee exists
  const employee = await prisma.employee.findUnique({
    where: { id: empId },
  });
  if (!employee) throw new Error("Employee not found");

  const parsedCheckIn = parseCheckInInput({ date, check_in, timestamp });
  const { start, end } = getDayRange(parsedCheckIn);
  const computedStatus = resolveStatus(parsedCheckIn, status);

  const existing = await prisma.attendance.findFirst({
    where: {
      employeeId: empId,
      date: {
        gte: start,
        lte: end,
      },
    },
    orderBy: { id: "desc" },
  });

  const attendanceIn = existing
    ? await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        check_in: existing.check_in
          ? new Date(Math.min(existing.check_in.getTime(), parsedCheckIn.getTime()))
          : parsedCheckIn,
        status: computedStatus,
      },
    })
    : await prisma.attendance.create({
      data: {
        employeeId: empId,
        date: start,
        check_in: parsedCheckIn,
        status: computedStatus,
      },
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
export const checkOutService = async (employeeId) => {
  return checkOutServiceWithTimestamp(employeeId);
};

export const checkOutServiceWithTimestamp = async (employeeId, timestamp) => {
  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) throw new Error("Invalid employeeId");

  const attendance = await prisma.attendance.findFirst({
    where: { employeeId: empId },
    orderBy: { date: "desc" }
  });

  if (!attendance || attendance.check_out)
    throw new Error("No active check-in found");

  const checkOutTime = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(checkOutTime.getTime())) throw new Error("Invalid checkout timestamp");

  const totalHours =
    (checkOutTime - attendance.check_in) / (1000 * 60 * 60);

  const checkOut=  await prisma.attendance.update({
    where: { id: attendance.id },
    data: { check_out: checkOutTime, total_hours: totalHours }
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

export const getAttendanceByEmployee = async (employeeId) => {
  return prisma.attendance.findMany({
    where: { employeeId },
    orderBy: { date: "desc" }
  });
};

export const listAttendanceRecords = async ({ date, limit = 100 } = {}) => {
  const target = date ? new Date(date) : new Date();
  const start = new Date(target);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return prisma.attendance.findMany({
    where: {
      date: {
        gte: start,
        lt: end,
      },
    },
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
