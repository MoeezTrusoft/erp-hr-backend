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
import { tenantTransaction } from "../lib/rlsTenant.js";
import { dateKey } from "../lib/attendanceDates.js";
import { todayInZone } from "../lib/holidayDates.js";
import { assertAttendancePeriodOpen } from "./attendancePeriod.service.js";
import { enqueueEvaluationRange } from "./attendanceFinalization.service.js";

// HR-ATT-ONCALL-02 — a call-in changes whether a day is worked, so it follows the
// same rules as every other attendance-changing write (roster, leave, holiday):
//   • refused while a payroll run covers the day (recall or cancel it first);
//   • a day already evaluated (today or earlier) is re-queued in the same
//     transaction, so marking last Saturday on Monday turns a no-show into
//     ABSENT, and cancelling it turns the day back into an off day.
// A future day needs no job: the daily planner evaluates it when it arrives.
async function requeueIfEvaluated(tx, tenantId, employeeId, day) {
  if (dateKey(day) > dateKey(todayInZone())) return false;
  await enqueueEvaluationRange({ tenantId, from: day, to: day, employeeIds: [employeeId] }, tx);
  await tx.attendanceEvaluationJob.updateMany({
    where: { tenantId, employeeId, date: day },
    data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null, completedAt: null },
  });
  return true;
}

const requireTenant = (tenantId) => {
  if (!tenantId) throw Object.assign(new Error("Tenant is required"), { status: 401, code: "HR-4010" });
  return tenantId;
};

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
export async function createCallIn({ employeeId, date, reason, calledBy, tenantId }) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("employeeId: expected a positive integer"), { status: 400, code: "HR-4000" });
  }
  const day = parseDay(date);
  requireTenant(tenantId);

  const result = await tenantTransaction(
    prisma,
    async (tx) => {
      await assertAttendancePeriodOpen(tx, tenantId, day, day);
      // Tenant-scoped: an employee outside the caller's tenant reads as not found,
      // never as a cross-tenant write.
      const employee = await tx.employee.findFirst({
        where: { id, tenant_id: tenantId },
        select: { id: true, employee_code: true },
      });
      if (!employee) {
        throw Object.assign(new Error(`employee ${id} not found`), { status: 404, code: "HR-4040" });
      }
      const existing = await tx.attendanceCallIn.findFirst({
        where: { tenantId, employeeId: id, date: day },
        select: { id: true },
      });
      const row = existing
        ? await tx.attendanceCallIn.update({
            where: { id: existing.id },
            data: { reason: reason ?? null, calledBy: calledBy ?? null },
            select: DTO,
          })
        : await tx.attendanceCallIn.create({
            data: { tenantId, employeeId: id, date: day, reason: reason ?? null, calledBy: calledBy ?? null },
            select: DTO,
          });
      const reevaluated = existing ? false : await requeueIfEvaluated(tx, tenantId, id, day);
      return { ...row, employeeName: employee.employee_code || "Employee code required", reevaluated };
    },
    { tenantId },
  );

  logger.info({ employeeId: id, date: day, id: result.id, reevaluated: result.reevaluated }, "on-call call-in recorded");
  return result;
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
        select: { id: true, employee_code: true },
      })
    : [];
  const nameById = new Map(
    employees.map((e) => [e.id, e.employee_code || "Employee code required"]),
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
 * Cancel a call-in. The day falls back to the roster and, when it was already
 * evaluated, is re-queued so a no-show ABSENT becomes the off day again. (The
 * old revert matched a remark the interval evaluator no longer writes, so it
 * never fired and a cancelled call-in kept charging the employee.)
 */
export async function removeCallIn({ id, tenantId }) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    throw Object.assign(new Error("id: expected a positive integer"), { status: 400, code: "HR-4000" });
  }
  requireTenant(tenantId);

  const result = await tenantTransaction(
    prisma,
    async (tx) => {
      const row = await tx.attendanceCallIn.findFirst({ where: { id: rowId, tenantId } });
      if (!row) throw Object.assign(new Error(`call-in ${rowId} not found`), { status: 404, code: "HR-4040" });
      await assertAttendancePeriodOpen(tx, tenantId, row.date, row.date);
      await tx.attendanceCallIn.delete({ where: { id: rowId } });
      const reevaluated = await requeueIfEvaluated(tx, tenantId, row.employeeId, row.date);
      return { deleted: true, id: rowId, employeeId: row.employeeId, reevaluated };
    },
    { tenantId },
  );
  logger.info(result, "on-call call-in cancelled");
  return { deleted: true, id: rowId, reevaluated: result.reevaluated };
}
