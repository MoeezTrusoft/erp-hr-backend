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
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import { affectedDays } from '../lib/attendanceCapture.js';
import logger from "../lib/logger.js";

// An interactive transaction has a 5 second budget. A month of off-days is
// hundreds of rows per tenant, so the bulk writes below are chunked rather than
// opening one transaction and hoping.
const WRITE_CHUNK = 200;
const writeTx = (db, fn) => db.$transaction ? tenantTransaction(db, fn) : fn(db);

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * HR-ATT-ANOM-PERSIST-01 (2026-09-15) — persist the evaluator's anomalies.
 *
 * evaluateShift has always RETURNED anomalies (late check-in, early
 * departure, absent, missing punches) but the writer dropped them on the
 * floor: attendance_anomalies held only the paper forms HR raised by hand,
 * so the system-visible anomaly count was structurally zero and the
 * approval chain never saw a single machine-detected exception. Each
 * verdict's anomalies are upserted as PENDING rows owned by the day's
 * attendance row via (sourceKind, sourceRef) — replay-safe, so the daily
 * re-evaluation cannot duplicate them.
 *
 * HR-ATT-ANOM-PERSIST-01b (2026-09-15) — also called for UNCHANGED rows.
 * September rows written by live intake before the persistence feature
 * existed will agree forever (`same`), so gating on create/update left the
 * whole month anomaly-less: the KPI tile showed 0 and the approval chain
 * never saw them. The (sourceKind, sourceRef) upsert makes the extra call a
 * no-op for days already covered.
 */
async function persistEvaluatorAnomalies({ tenantId, employeeId, day, anomalies, rowId, summary, dryRun, db = prisma }) {
  if (dryRun || !rowId || !Array.isArray(anomalies) || !anomalies.length) return;
  await writeTx(db, async (tx) => {
    for (const a of anomalies) {
      if (!a?.type) continue;
      const sourceRef = `${rowId}:${a.type}`;
      const exists = await tx.attendanceAnomaly.findFirst({
        where: { tenantId, sourceKind: "evaluator", sourceRef },
        select: { id: true },
      });
      if (exists) continue;
      try {
        await tx.attendanceAnomaly.create({
          data: {
            employeeId,
            type: a.type,
            date: day,
            fromTime: a.fromTime ?? null,
            toTime: a.toTime ?? null,
            expectedTime: a.expectedTime ?? null,
            actualTime: a.actualTime ?? null,
            detail: a.minutesLate != null ? `auto-detected: ${a.minutesLate} min late`
              : a.type === "EARLY_CHECKOUT" ? "auto-detected: early departure"
              : "auto-detected by attendance evaluation",
            status: "PENDING",
            sourceKind: "evaluator",
            sourceRef,
            applicationDate: day,
            tenantId,
          },
        });
      } catch (e) {
        // A concurrent replay of the same day already inserted it — the
        // (tenantId, sourceKind, sourceRef) unique index is the backstop.
        if (e?.code !== "P2002") throw e;
      }
    }
  });
  summary.anomaliesPersisted = (summary.anomaliesPersisted ?? 0)
    + (anomalies?.length ?? 0);
}

export async function applyEvaluatedShifts({ tenantId, from, to, dryRun = true, now = new Date(), db = prisma, employeeIds }) {
  const shifts = await replayTenant({ tenantId, from, to, now, db, employeeIds });

  const summary = {
    tenantId, from, to, dryRun,
    shifts: shifts.length, created: 0, updated: 0, unchanged: 0, retracted: 0,
    nonWorking: 0, skippedManuallyCorrected: 0, held: 0, corrections: 0, byStatus: {},
    vanishedEmployee: 0,
  };

  // HR-ATT-DEVICE-ENROLMENT-01 guard — a punch can carry an employeeId whose
  // Employee row no longer exists (stale id surviving a re-import until the
  // reresolve script runs). Evaluating it is harmless; INSERTING its Attendance
  // row violates the FK and aborts the whole tenant's rollup. Skip with a
  // counter instead of crashing — the underlying punch keeps its id for a
  // later re-link.
  const aliveIds = new Set(
    (await db.employee.findMany({
      where: { id: { in: [...new Set(shifts.map((s) => s.employeeId))] } },
      select: { id: true },
    })).map((e) => e.id),
  );

  // Primary enrolment is resolved for the attendance day from its published configuration.
  for (const { employeeId, day, verdict, corrections, punchSn, setupVersion, setupSnapshot } of shifts) {
    if (!aliveIds.has(employeeId)) { summary.vanishedEmployee += 1; continue; }
    summary.byStatus[verdict.status] = (summary.byStatus[verdict.status] ?? 0) + 1;
    if (verdict.dayCredit == null) summary.held += 1;
    summary.corrections += (corrections || []).length;

    const existing = await db.attendance.findFirst({
      where: { tenantId, employeeId, date: day },
      orderBy: { id: "desc" },
    });
    // eslint-disable-next-line no-await-in-loop -- sequential by design: each day's write depends on the previous verdict

    // HR's ruling outranks the device, always.
    if (existing?.manually_corrected) { summary.skippedManuallyCorrected += 1; continue; }

    // A per-day work-mode override beats the employee default.
    const assignment = await db.shiftAssignment.findFirst({
      where: { tenantId, employeeId, date: day },
      orderBy: { id: "desc" },
      select: { workMode: true },
    });
    const employee = await db.employee.findUnique({
      where: { id: employeeId },
      select: { work_mode: true, tenant_id: true },
    });
    const workMode = normalizeWorkMode(assignment?.workMode) ?? normalizeWorkMode(employee?.work_mode);

    const data = {
      setupVersion: setupVersion ?? null,
      setupSnapshot: JSON.parse(JSON.stringify(setupSnapshot ?? {})),
      check_in: verdict.checkIn,
      check_out: verdict.checkOut,
      total_hours: verdict.workedMinutes ? Number((verdict.workedMinutes / 60).toFixed(2)) : null,
      status: verdict.status,
      day_credit: verdict.dayCredit,
      requires_regularization: verdict.requiresRegularization,
      ...(workMode ? { work_mode: workMode } : {}),
      remarks: verdict.status === 'SETUP_REQUIRED' ? `Attendance setup required: ${setupSnapshot?.reason}` : (corrections || []).length
        ? `device (${corrections.length} punch direction${corrections.length > 1 ? "s" : ""} auto-resolved)`
        : "device",
    };

    // HR-ATT-PRIMARY-DEVICE-01 — device provenance of the day. Punches on the
    // employee's primary device are the normal case; punches on any OTHER
    // device are counted explicitly on the row (the raw punch store keeps the
    // per-punch trace). No primary ⇒ the row stays unmarked (NULL/0), which is
    // not the same as "all primary".
    Object.assign(data, computePrimaryProvenance({
      primarySn: setupSnapshot?.primarySn ?? null,
      punchSn,
    }));

    const same = existing
      && existing.setupVersion === data.setupVersion
      && Number(existing.check_in) === Number(data.check_in)
      && Number(existing.check_out) === Number(data.check_out)
      && existing.requires_regularization === data.requires_regularization
      && existing.status === data.status
      && existing.day_credit === data.day_credit
      && Number(existing.total_hours ?? 0) === Number(data.total_hours ?? 0)
      // Provenance participates in agreement only when a primary exists —
      // otherwise unmarked rows (NULL/0) would be rewritten forever.
      && (data.primary_sn == null
        || (existing.primary_sn === data.primary_sn
          && Number(existing.secondary_punches ?? 0) === Number(data.secondary_punches ?? 0)));
    if (same) {
      summary.unchanged += 1;
      // HR-ATT-ANOM-PERSIST-01b — unchanged rows still need their anomalies
      // (see the helper's doc: pre-feature September rows agree forever).
      await persistEvaluatorAnomalies({
        tenantId: employee?.tenant_id ?? tenantId,
        employeeId, day, anomalies: verdict.anomalies,
        rowId: existing?.id ?? null, summary, dryRun, db,
      });
      continue;
    }

    let rowId = existing?.id ?? null;
    if (!dryRun) {
      await writeTx(db, async (tx) => {
        if (existing) {
          const row = await tx.attendance.update({ where: { id: existing.id, tenantId, manually_corrected: false, updated_at: existing.updated_at }, data });
          rowId = row.id;
        } else {
          const row = await tx.attendance.create({
            data: { employeeId, date: day, tenantId: employee?.tenant_id ?? tenantId, ...data },
          });
          rowId = row.id;
        }
      });
    }
    summary[existing ? "updated" : "created"] += 1;

    await persistEvaluatorAnomalies({
      tenantId: employee?.tenant_id ?? tenantId,
      employeeId, day, anomalies: verdict.anomalies, rowId, summary, dryRun, db,
    });
  }

  await retractInvalidatedRows({ tenantId, from, to, shifts, summary, dryRun, db, employeeIds });
  await assertNonWorkingDays({ tenantId, from, to, shifts, summary, dryRun, db, employeeIds });

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
 * HR-ATT-PRIMARY-DEVICE-01 — the day's device-provenance fields.
 *
 * Punches on the employee's primary device are the normal case and need no
 * mark of their own; punches that arrived on any OTHER device are counted
 * explicitly on the row (per-punch trace stays in the raw punch store, keyed
 * by sn + deviceUserId). With no SN-scoped primary the row stays unmarked —
 * NULL/0 means "no primary assigned", never "all punches were primary".
 *
 * Pure so the rule is testable without a database.
 */
export function computePrimaryProvenance({ primarySn, punchSn }) {
  if (!primarySn) return {};
  return {
    primary_sn: primarySn,
    secondary_punches: (punchSn || []).filter((sn) => sn && sn !== primarySn).length,
  };
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
async function retractInvalidatedRows({ tenantId, from, to, shifts, summary, dryRun, db = prisma, employeeIds }) {
  const evaluated = new Set(shifts.map((s) => `${s.employeeId}|${dayKey(s.day)}`));

  const rows = await db.attendance.findMany({
    where: {
      tenantId,
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
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
    const working = await resolveWorkingDays({ employeeId, tenantId, from, to, db });
    for (const r of list) {
      const info = working.get(dayKey(r.date));
      if (info?.working !== false) continue;
      if (['NOT_ELIGIBLE','MANUAL_MONTHLY'].includes(info.reason)) continue;
      if (r.manually_corrected) { summary.skippedManuallyCorrected += 1; continue; }
      const status = statusFor(info.reason);
      if (r.status === status) continue; // already says so
      restate.push({ id: r.id, status, reason: info.reason, detail: info.detail ?? null });
    }
  }

  summary.retracted = restate.length;
  if (dryRun || !restate.length) return;

  // Rows that say the same thing are written together. An interactive
  // transaction has a 5s budget and a month can restate hundreds of days, so
  // one statement per row exhausts it and rolls the whole pass back.
  const groups = new Map();
  for (const r of restate) {
    const remarks = `not a working day (${r.reason}${r.detail ? `: ${r.detail}` : ""})`;
    const bucket = `${r.status}|${remarks}`;
    if (!groups.has(bucket)) groups.set(bucket, { status: r.status, remarks, ids: [] });
    groups.get(bucket).ids.push(r.id);
  }

  for (const g of groups.values()) {
    for (const ids of chunk(g.ids, WRITE_CHUNK)) {
      await writeTx(db, async (tx) => {
        await tx.attendance.updateMany({
          where: { tenantId, id: { in: ids }, manually_corrected: false },
          data: {
            status: g.status,
            check_in: null,
            check_out: null,
            total_hours: null,
            day_credit: 0,
            requires_regularization: false,
            remarks: g.remarks,
          },
        });
      });
    }
  }
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
async function assertNonWorkingDays({ tenantId, from, to, shifts, summary, dryRun, db = prisma, employeeIds }) {
  const roster = await db.employee.findMany({
    where: { tenant_id: tenantId, ...(employeeIds ? { id: { in: employeeIds } } : {}), NOT: { payroll_included: false } },
    select: { id: true },
  });

  const seen = new Map(); // employeeId -> day keys already accounted for
  for (const e of roster) seen.set(e.id, new Set());
  const note = (employeeId, key) => {
    if (!seen.has(employeeId)) return; // not on this tenant's tracked roster
    seen.get(employeeId).add(key);
  };
  for (const s of shifts) note(s.employeeId, dayKey(s.day));

  const rows = await db.attendance.findMany({
    where: {
      tenantId,
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
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
    const working = await resolveWorkingDays({ employeeId, tenantId, from, to, db });
    for (const [key, info] of working) {
      if (info?.working !== false) continue;
      if (['NOT_ELIGIBLE','MANUAL_MONTHLY'].includes(info.reason)) continue;
      if (days.has(key)) continue; // already has a row, or a shift was evaluated
      toWrite.push({ employeeId, key, status: statusFor(info.reason), reason: info.reason });
    }
  }

  summary.nonWorking = toWrite.length;
  if (dryRun || !toWrite.length) return;

  // Every employee's tenant resolved ONCE, before any transaction opens. The
  // first version looked this up per row inside the transaction; a month is
  // ~300 rows per tenant, and the per-row round trips alone exhausted the 5s
  // interactive-transaction budget and rolled the whole pass back (P2028).
  const tenantOf = new Map(
    (await db.employee.findMany({
      where: { id: { in: [...new Set(toWrite.map((w) => w.employeeId))] } },
      select: { id: true, tenant_id: true },
    })).map((e) => [e.id, e.tenant_id]),
  );

  for (const batch of chunk(toWrite, WRITE_CHUNK)) {
    await writeTx(db, async (tx) => {
      await tx.attendance.createMany({
        data: batch.map((w) => ({
          employeeId: w.employeeId,
          date: new Date(`${w.key}T00:00:00.000Z`),
          tenantId: tenantOf.get(w.employeeId) ?? tenantId,
          status: w.status,
          check_in: null,
          check_out: null,
          total_hours: null,
          day_credit: 0,
          requires_regularization: false,
          remarks: `not a working day (${w.reason})`,
        })),
        // Attendance is unique on (tenantId, employeeId, date). A concurrent
        // ingest could have created the day between the read above and here.
        skipDuplicates: true,
      });
    });
  }
}

/**
 * HR-ATT-STALE-REFRESH-01 (2026-09-15) — recompute a tenant's recent window so
 * rows written under an OLDER schedule/policy agree with the CURRENT one.
 *
 * Live intake only re-evaluates the days a punch touches, so a row written
 * before a roster correction stays frozen (operator report: Afsha/Pervaiz
 * 10:11 & 10:13 vs a 10:00 shift showing "On Time" — written pre-correction,
 * never revisited because later punches landed on other days). This sweep re
 * runs the evaluator over the window; the writer's `same` check makes it a
 * no-op for rows that already agree, and manually-corrected days are skipped
 * by design — HR's word outranks the machine.
 */
export async function refreshStaleAttendance({ tenantId, days = 35, now = new Date() }) {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const summary = await applyEvaluatedShifts({ tenantId, from, to, dryRun: false, now });
  logger.warn({ tenantId, from, to, ...summary }, "stale-attendance refresh sweep");
  return { from, to, ...summary };
}

/**
 * Live path: re-evaluate only the days a punch batch touched.
 *
 * Narrow on purpose — an ingest must not rewrite a month because one punch
 * arrived. dayKey is used to collapse a batch to its distinct days.
 */
export async function applyEvaluatedShiftsForDays({ tenantId, days, employeeIds, now = new Date(), db = prisma }) {
  const summaries = [];
  for (const day of affectedDays(days)) {
    summaries.push(await applyEvaluatedShifts({ tenantId, from: day, to: day, employeeIds, dryRun: false, now, db }));
  }
  return { windows: summaries };
}
