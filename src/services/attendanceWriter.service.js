// src/services/attendanceWriter.service.js
//
// Writes Attendance from the EVALUATOR — the cutover (A17).
//
// Until now the evaluator only ever produced reports: the live roll-up still
// used the older calendar-day logic, so what the shadow replay showed and what
// the product stored were two different things. This closes that gap, and is
// used for both the historical backfill and the live device path so the two
// cannot drift apart again.
//
// Non-negotiable behaviours:
//   * a day HR corrected by hand is NEVER touched (HR-ATT-CORRECTION-01);
//   * MISSING_* days are written with day_credit NULL and
//     requires_regularization set, so payroll HOLDS them rather than paying
//     zero or docking;
//   * dryRun defaults to TRUE, because this rewrites days that feed pay.
//
// HR-ATT-CUTOVER-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { replayTenant, dayKey } from "../lib/attendanceReplay.js";
import { resolveWorkingDays } from "./workingDay.service.js";
import { getAttendancePolicy } from "./attendancePolicyConfig.service.js";
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import logger from "../lib/logger.js";

export async function applyEvaluatedShifts({ tenantId, from, to, dryRun = true, now = new Date() }) {
  const policy = await getAttendancePolicy({ tenantId });
  const shifts = await replayTenant({ tenantId, from, to, policy, now });

  const summary = {
    tenantId, from, to, dryRun,
    shifts: shifts.length, created: 0, updated: 0, unchanged: 0, retracted: 0,
    nonWorking: 0, skippedManuallyCorrected: 0, held: 0, corrections: 0, byStatus: {},
  };

  for (const { employeeId, day, verdict, corrections } of shifts) {
    summary.byStatus[verdict.status] = (summary.byStatus[verdict.status] ?? 0) + 1;
    if (verdict.dayCredit == null) summary.held += 1;
    summary.corrections += (corrections || []).length;

    const existing = await prisma.attendance.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
    });

    // HR's ruling outranks the device, always.
    if (existing?.manually_corrected) { summary.skippedManuallyCorrected += 1; continue; }

    // A per-day work-mode override beats the employee default.
    const assignment = await prisma.shiftAssignment.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
      select: { workMode: true },
    });
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { work_mode: true, tenant_id: true },
    });
    const workMode = normalizeWorkMode(assignment?.workMode) ?? normalizeWorkMode(employee?.work_mode);

    const data = {
      check_in: verdict.checkIn,
      check_out: verdict.checkOut,
      total_hours: verdict.workedMinutes ? Number((verdict.workedMinutes / 60).toFixed(2)) : null,
      status: verdict.status,
      day_credit: verdict.dayCredit,
      requires_regularization: verdict.requiresRegularization,
      ...(workMode ? { work_mode: workMode } : {}),
      remarks: (corrections || []).length
        ? `device (${corrections.length} punch direction${corrections.length > 1 ? "s" : ""} auto-resolved)`
        : "device",
    };

    const same = existing
      && existing.status === data.status
      && existing.day_credit === data.day_credit
      && Number(existing.total_hours ?? 0) === Number(data.total_hours ?? 0);
    if (same) { summary.unchanged += 1; continue; }

    if (!dryRun) {
      await tenantTransaction(prisma, async (tx) => {
        if (existing) {
          await tx.attendance.update({ where: { id: existing.id }, data });
        } else {
          await tx.attendance.create({
            data: { employeeId, date: day, tenantId: employee?.tenant_id ?? tenantId, ...data },
          });
        }
      });
    }
    summary[existing ? "updated" : "created"] += 1;
  }

  await retractInvalidatedRows({ tenantId, from, to, shifts, summary, dryRun });
  await assertNonWorkingDays({ tenantId, from, to, shifts, summary, dryRun });

  logger[dryRun ? "info" : "warn"](
    {
      tenantId, shifts: summary.shifts, created: summary.created,
      updated: summary.updated, retracted: summary.retracted,
      nonWorking: summary.nonWorking, dryRun,
    },
    dryRun ? "attendance write (dry run)" : "attendance written from evaluator",
  );
  return summary;
}

/**
 * Retract stored rows the roster no longer supports (HR-ATT-RETRACT-01).
 *
 * The loop above only adds and updates. A day with no punches yields no shift,
 * so it is never visited — which means a stored row outlives any correction to
 * the roster underneath it. Writing the EMG rotation phase stopped new rest-day
 * absences appearing but left 31 already-written ones reported as "unchanged",
 * and a stale ABSENT is an unpaid day for work that was never missed.
 *
 * Three guards, each of which must hold before a row is removed:
 *   1. the evaluator produced NO shift for that employee-day — a day with
 *      punches belongs to the update path above, even if it is a rest day
 *      (people do work rest days);
 *   2. the roster now calls the day non-working. An absent `working` verdict is
 *      NOT treated as non-working: silence from the resolver must never delete;
 *   3. HR has not corrected the row by hand (HR-ATT-CORRECTION-01).
 *
 * Punches are untouched — they still belong to their own shift and are re-read
 * on the next evaluation.
 */
async function retractInvalidatedRows({ tenantId, from, to, shifts, summary, dryRun }) {
  const evaluated = new Set(shifts.map((s) => `${s.employeeId}|${dayKey(s.day)}`));

  const rows = await prisma.attendance.findMany({
    where: {
      tenantId,
      date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
    },
    select: { id: true, employeeId: true, date: true, status: true, manually_corrected: true },
  });

  const candidates = new Map();
  for (const r of rows) {
    if (evaluated.has(`${r.employeeId}|${dayKey(r.date)}`)) continue;
    if (!candidates.has(r.employeeId)) candidates.set(r.employeeId, []);
    candidates.get(r.employeeId).push(r);
  }

  // HR-ATT-STATUS-01 — restate rather than delete.
  //
  // A deleted row leaves the same blank that means "we never got the data".
  // Writing what the day actually was makes it answerable, and takes the last
  // cleanup path that was a DELETE out of the system.
  const statusFor = (reason) => {
    if (reason === "HOLIDAY") return "HOLIDAY";
    if (reason === "APPROVED_LEAVE") return "ON_LEAVE";
    return "WEEKLY_OFF"; // OFF_DAY and ROTATION_OFF are both a rostered rest day
  };

  const restate = [];
  for (const [employeeId, list] of candidates) {
    const working = await resolveWorkingDays({ employeeId, from, to });
    for (const r of list) {
      const info = working.get(dayKey(r.date));
      if (info?.working !== false) continue;
      if (r.manually_corrected) { summary.skippedManuallyCorrected += 1; continue; }
      const status = statusFor(info.reason);
      if (r.status === status) continue; // already says so
      restate.push({ id: r.id, status, reason: info.reason, detail: info.detail ?? null });
    }
  }

  summary.retracted = restate.length;
  if (dryRun || !restate.length) return;

  await tenantTransaction(prisma, async (tx) => {
    for (const r of restate) {
      await tx.attendance.update({
        where: { id: r.id },
        data: {
          status: r.status,
          check_in: null,
          check_out: null,
          total_hours: null,
          day_credit: 0,
          requires_regularization: false,
          remarks: `not a working day (${r.reason}${r.detail ? `: ${r.detail}` : ""})`,
        },
      });
    }
  });
}

/**
 * State the non-working days that have no row at all (HR-ATT-STATUS-01).
 *
 * Retraction above fixes rows that exist. This covers the other half: a rest day
 * nobody scanned on has no row, and a blank is indistinguishable from data that
 * never arrived.
 *
 * Covers the tenant's tracked roster, not merely the people who scanned. An
 * employee's rest day is a fact about the roster, and it is exactly the person
 * with NO rows whose blank month is ambiguous — scoping this to those who
 * already have rows would leave the worst case unanswered.
 *
 * People excluded from payroll (HR-PAY-ELIG-01) are left out: nothing about
 * their attendance is being derived.
 */
async function assertNonWorkingDays({ tenantId, from, to, shifts, summary, dryRun }) {
  const roster = await prisma.employee.findMany({
    where: { tenant_id: tenantId, NOT: { payroll_included: false } },
    select: { id: true },
  });

  const seen = new Map(); // employeeId -> day keys already accounted for
  for (const e of roster) seen.set(e.id, new Set());
  const note = (employeeId, key) => {
    if (!seen.has(employeeId)) return; // not on this tenant's tracked roster
    seen.get(employeeId).add(key);
  };
  for (const s of shifts) note(s.employeeId, dayKey(s.day));

  const rows = await prisma.attendance.findMany({
    where: {
      tenantId,
      date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
    },
    select: { employeeId: true, date: true },
  });
  for (const r of rows) note(r.employeeId, dayKey(r.date));

  const statusFor = (reason) => {
    if (reason === "HOLIDAY") return "HOLIDAY";
    if (reason === "APPROVED_LEAVE") return "ON_LEAVE";
    return "WEEKLY_OFF";
  };

  const toWrite = [];
  for (const [employeeId, days] of seen) {
    const working = await resolveWorkingDays({ employeeId, from, to });
    for (const [key, info] of working) {
      if (info?.working !== false) continue;
      if (days.has(key)) continue; // already has a row, or a shift was evaluated
      toWrite.push({ employeeId, key, status: statusFor(info.reason), reason: info.reason });
    }
  }

  summary.nonWorking = toWrite.length;
  if (dryRun || !toWrite.length) return;

  await tenantTransaction(prisma, async (tx) => {
    for (const w of toWrite) {
      const employee = await prisma.employee.findUnique({
        where: { id: w.employeeId },
        select: { tenant_id: true },
      });
      await tx.attendance.create({
        data: {
          employeeId: w.employeeId,
          date: new Date(`${w.key}T00:00:00.000Z`),
          tenantId: employee?.tenant_id ?? tenantId,
          status: w.status,
          check_in: null,
          check_out: null,
          total_hours: null,
          day_credit: 0,
          requires_regularization: false,
          remarks: `not a working day (${w.reason})`,
        },
      });
    }
  });
}

/**
 * Live path: re-evaluate only the days a punch batch touched.
 *
 * Narrow on purpose — an ingest must not rewrite a month because one punch
 * arrived. dayKey is used to collapse a batch to its distinct days.
 */
export async function applyEvaluatedShiftsForDays({ tenantId, days, now = new Date() }) {
  const unique = [...new Set(days.map((d) => dayKey(d)))].sort();
  if (!unique.length) return { shifts: 0, created: 0, updated: 0 };
  // One window covering the batch; a shift starting the previous evening is
  // picked up because replayTenant reads a day either side.
  return applyEvaluatedShifts({
    tenantId, from: unique[0], to: unique[unique.length - 1], dryRun: false, now,
  });
}
