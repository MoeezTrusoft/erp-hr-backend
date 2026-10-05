// src/services/attendanceOnCall.service.js
//
// HR-ATT-ONCALL-01 — weekend on-call: HR rings an employee in for ONE date.
//
// The call-in is the whole mechanism. workingDay.service reads these rows and
// gives the date precedence over the rostered off-day and the rotation rest,
// so the day becomes a working day for that employee: punches on it score
// normally, and a NO-SHOW is an ordinary absence — the next morning's absence
// marking restates the stale WEEKLY_OFF row to ABSENT (day_credit 0) and the
// existing deduction path charges it. No anomaly form sits in the way; that is
// the operator's ruling (2026-10-05): called-in means called-in.
//
// One row per (tenant, employee, day) — creating twice updates the reason
// instead of doubling the day.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value) {
  if (!ISO_DAY.test(String(value ?? ""))) {
    throw Object.assign(new Error("date: expected YYYY-MM-DD"), { status: 400, code: "HR-4000" });
  }
  return new Date(`${value}T00:00:00.000Z`);
}

const DTO = { id: true, employeeId: true, date: true, reason: true, calledBy: true, createdAt: true };

/**
 * Record (or refresh) a call-in for one employee-day.
 * tenantScope stamps tenantId on create and scopes every read.
 */
export async function createCallIn({ employeeId, date, reason, calledBy }) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("employeeId: expected a positive integer"), { status: 400, code: "HR-4000" });
  }
  const day = parseDay(date);

  // Tenant-scoped: an employee outside the caller's tenant reads as not found,
  // never as a cross-tenant write.
  const employee = await prisma.employee.findFirst({
    where: { id },
    select: { id: true, first_name: true, last_name: true },
  });
  if (!employee) {
    throw Object.assign(new Error(`employee ${id} not found`), { status: 404, code: "HR-4040" });
  }

  const existing = await prisma.attendanceCallIn.findFirst({
    where: { employeeId: id, date: day },
    select: { id: true },
  });

  const row = existing
    ? await prisma.attendanceCallIn.update({
        where: { id: existing.id },
        data: { reason: reason ?? null, calledBy: calledBy ?? null },
        select: DTO,
      })
    : await prisma.attendanceCallIn.create({
        data: { employeeId: id, date: day, reason: reason ?? null, calledBy: calledBy ?? null },
        select: DTO,
      });

  logger.info({ employeeId: id, date: day, id: row.id }, "on-call call-in recorded");
  return { ...row, employeeName: [employee.first_name, employee.last_name].filter(Boolean).join(" ").trim() };
}

/** Call-ins in a window (optionally one employee). */
export async function listCallIns({ from, to, employeeId } = {}) {
  const where = {};
  if (from || to) {
    where.date = {
      ...(from ? { gte: parseDay(from) } : {}),
      ...(to ? { lte: parseDay(to) } : {}),
    };
  }
  if (employeeId != null && String(employeeId).trim() !== "") {
    where.employeeId = Number(employeeId);
  }
  const rows = await prisma.attendanceCallIn.findMany({
    where,
    select: DTO,
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

  // No Prisma relation on purpose (plain ref, same as AttendanceDevicePunch):
  // names come from one batched read.
  const employees = rows.length
    ? await prisma.employee.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } },
        select: { id: true, first_name: true, last_name: true },
      })
    : [];
  const nameById = new Map(
    employees.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(" ").trim()]),
  );

  return {
    items: rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      date: r.date,
      reason: r.reason,
      calledBy: r.calledBy,
      createdAt: r.createdAt,
      employeeName: nameById.get(r.employeeId) || null,
    })),
    total: rows.length,
  };
}

/**
 * Cancel a call-in. The day falls back to the roster; any ABSENT row the
 * no-show path wrote for it (not HR-corrected) is reverted to WEEKLY_OFF so a
 * cancelled call-in never keeps charging the employee.
 */
export async function removeCallIn({ id }) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    throw Object.assign(new Error("id: expected a positive integer"), { status: 400, code: "HR-4000" });
  }

  const row = await prisma.attendanceCallIn.findFirst({ where: { id: rowId } });
  if (!row) throw Object.assign(new Error(`call-in ${rowId} not found`), { status: 404, code: "HR-4040" });

  const reverted = await prisma.attendance.updateMany({
    where: {
      employeeId: row.employeeId,
      date: row.date,
      status: "ABSENT",
      manually_corrected: false,
      remarks: "Called in (on-call) with no attendance recorded",
    },
    data: { status: "WEEKLY_OFF", day_credit: 0, requires_regularization: false, remarks: null },
  });

  await prisma.attendanceCallIn.delete({ where: { id: rowId } });
  logger.info({ id: rowId, employeeId: row.employeeId, reverted: reverted.count }, "on-call call-in cancelled");
  return { deleted: true, id: rowId, revertedAbsences: reverted.count };
}
