// src/services/attendanceCorrection.service.js
//
// HR/admin correction of a single attendance day.
//
// This exists because the device cannot be the only authority: it was out of
// service on some days, people press the wrong key, and HR holds a reconciled
// record the machine never saw. August alone produced 527 employee-days needing
// human review.
//
// Two properties matter more than anything else here:
//
//   1. A correction SURVIVES the next device sync. syncAttendanceFromPunches
//      skips any day flagged manually_corrected. Without that, HR fixes a day,
//      the next push overwrites it, and the whole feature is theatre.
//   2. Every correction is ATTRIBUTED. Who, when, why — written to the day
//      itself and to the Log audit trail. These days feed payroll, so "someone
//      changed it at some point" is not good enough.
//
// HR-ATT-CORRECTION-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** The state a day was in before a correction, for the audit trail.
 *  Times are HH:MM — the minute is what a reviewer compares, and the full
 *  ISO stamp buries it. */
function describePrevious(row) {
  const hhmm = (v) => (v ? new Date(v).toISOString().slice(11, 16) : "-");
  return `in=${hhmm(row.check_in)} out=${hhmm(row.check_out)} `
    + `status=${row.status ?? "-"} credit=${row.day_credit ?? "-"}`;
}

function startOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** HH:MM of a stored punch, for integrity-conflict messages. */
function describeHhmm(value) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" (seconds tolerated and truncated) on the given day. A check-out
 *  earlier than the check-in rolls to the next day, so a night shift can be
 *  corrected without gymnastics.
 *
 *  TS-MANUAL-04 (operator item 2.4, 2026-09-17) — the API previously rejected
 *  "15:00:23" with `Time must be HH:MM`, though browsers' time inputs and
 *  several client flows emit HH:MM:SS. Minute granularity remains the storage
 *  contract (status derivation and late-grace math are minute-based), so
 *  seconds are ACCEPTED and truncated. */
function atClock(day, hhmm, { after = null } = {}) {
  if (hhmm == null || hhmm === "") return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw badRequest(`Time must be HH:MM (HH:MM:SS tolerated), got "${hhmm}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw badRequest(`Time out of range: "${hhmm}"`);
  const d = new Date(day);
  d.setHours(h, mi, 0, 0);
  if (after && d <= after) d.setDate(d.getDate() + 1);
  return d;
}

/** Day credit from the corrected status. Kept explicit rather than derived from
 *  hours: HR is stating what the day is worth, not asking us to infer it. */
function creditFor(status) {
  if (status === "PRESENT" || status === "LATE") return 1.0;
  if (status === "HALF_DAY") return 0.5;
  if (status === "ABSENT") return 0.0;
  return null; // MISSING_* stays unresolved
}

// HR-ATT-CORRECTION-POLICY-01 (operator items 7+8, 2026-09-15):
//
//   #7 — manual intervention may ONLY fix a missing check-in or check-out.
//   A day the machine already scored (PRESENT/LATE/ABSENT/...) is not
//   correctable by hand; the anomaly-form / leave workflow is the remedy
//   channel for those. This keeps the device verdict authoritative and the
//   correction surface narrow and auditable.
//
//   #8 — creating attendance from NOTHING (manual entry, no device row) is
//   allowed only for WFH shifts (Remote/Hybrid) and lands as PENDING
//   management approval: requires_regularization stays true and day_credit
//   stays null, so payroll holds the day until it is approved.
const CORRECTABLE_STATUSES = ["MISSING_CHECKIN", "MISSING_CHECKOUT"];

export async function correctAttendanceDay({
  tenantId, employeeId, date, checkIn, checkOut, status, workMode, reason, actorEmployeeId, actorNote,
}) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required — corrections feed payroll and must be explainable");
  // HR-ATT-CORRECTION-03 — HR/admin logins with no Employee row (bound to RBAC
  // only) can still correct days: the RBAC gate already authorized the action,
  // so the audit trail attributes it by RBAC identity instead of an employee
  // FK. Both columns are nullable in the Log model by design. A caller with
  // NEITHER an employee id nor an identity note is a bug, not a flow.
  if (!Number.isInteger(actorEmployeeId) || actorEmployeeId < 1) {
    if (!actorNote) throw badRequest("actorEmployeeId is required");
    actorEmployeeId = null;
  }
  // `status` is DERIVED from the supplied times (#7) and is no longer
  // accepted as an input: a correction supplies the missing punch, it does not
  // re-grade the day. Callers that still send it (older clients) are honored
  // by derivation, not by assertion.
  void status;

  const day = startOfDay(date);

  // TS-MANUAL-01 (operator items 2.1 + 8, 2026-09-17) — attendance cannot be
  // created or corrected for a FUTURE date. Day arithmetic uses the PKT
  // calendar (+05:00, the workforce's clock — same convention as the anomaly
  // request deadline): now + 5h then UTC start-of-day, so a 2 AM PKT entry
  // for "today" is not rejected and a 10 PM entry for "tomorrow" is.
  const pktToday = new Date(Date.now() + 5 * 3600 * 1000);
  pktToday.setUTCHours(0, 0, 0, 0);
  if (day.getTime() > pktToday.getTime()) {
    throw badRequest("Attendance cannot be entered or corrected for a future date");
  }

  const cin = atClock(day, checkIn);
  const cout = atClock(day, checkOut, { after: cin });

  if (cin && cout && cout <= cin) {
    throw badRequest("check-out must be after check-in");
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, tenant_id: true, work_mode: true },
  });
  // Numeric employee ids are only tenant-local identifiers. Do not allow a
  // caller from tenant B to correct tenant A's employee by guessing the id.
  if (!employee || employee.tenant_id !== tenantId) {
    throw badRequest(`Employee ${employeeId} not found in this tenant`);
  }

  const preExisting = await prisma.attendance.findFirst({
    where: { employeeId, date: day },
    orderBy: { id: "desc" },
    // TS-MANUAL-05 — the punch columns are part of the guard: without them the
    // immutability check cannot see recorded times (the unit-mock returned the
    // whole row and masked the gap). Read them explicitly.
    select: {
      id: true,
      status: true,
      requires_regularization: true,
      check_in: true,
      check_out: true,
    },
  });

  // TS-MANUAL-05 — COALESCE semantics: the effective punch set is the union of
  // the recorded punches and the supplied ones. An omitted field falls back to
  // the recorded value (and must not be nulled out at write time), so a
  // checkout-only correction keeps the morning's device check-in intact.
  const effCin = cin ?? (preExisting?.check_in ? new Date(preExisting.check_in) : null);
  let effCout = cout ?? (preExisting?.check_out ? new Date(preExisting.check_out) : null);
  if (effCin && effCout && effCout <= effCin) {
    // Overnight shift (e.g. 22:00 → 07:00): a checkout-only correction arrives
    // without the check-in context that atClock's rollover needs, so try the
    // next-day interpretation before refusing.
    const rolled = new Date(effCout);
    rolled.setDate(rolled.getDate() + 1);
    if (rolled > effCin) {
      effCout = rolled;
    } else {
      throw badRequest("check-out must be after check-in");
    }
  }

  let manualEntryPendingApproval = false;
  if (preExisting) {
    // #7 — the day must be a missing-punch day. HR's own flag (already
    // pending) is also correctable, e.g. finishing a WFH entry's approval.
    const pendingDay =
      CORRECTABLE_STATUSES.includes(preExisting.status) || preExisting.requires_regularization;
    if (!pendingDay) {
      throw badRequest(
        `Only days with a missing check-in or check-out can be corrected manually `
        + `(this day is ${preExisting.status}). Use the anomaly/leave workflow for other days.`,
      );
    }

    // TS-MANUAL-05 (operator item 9, 2026-09-17) — PUNCH-TIME INTEGRITY:
    // recorded biometric/machine punch timestamps are IMMUTABLE. A correction
    // may only LOG a missing check-in or check-out; it must never alter a
    // punch the device already recorded. A payload supplying a time where the
    // day already carries one is rejected outright (same-time payloads are
    // treated as idempotent no-ops for that field, not alterations).
    const conflicts = [];
    if (cin && preExisting.check_in) {
      const same = new Date(preExisting.check_in).getTime() === cin.getTime();
      if (!same) conflicts.push(`check-in ${describeHhmm(preExisting.check_in)} already recorded`);
    }
    if (cout && preExisting.check_out) {
      const same = new Date(preExisting.check_out).getTime() === cout.getTime();
      if (!same) conflicts.push(`check-out ${describeHhmm(preExisting.check_out)} already recorded`);
    }
    if (conflicts.length > 0) {
      throw badRequest(
        `Recorded punch times are immutable and cannot be altered — `
        + `${conflicts.join(" and ")}. Corrections may only supply a MISSING punch.`,
      );
    }
  } else {
    // #8 — a day with NO device row is a manual ENTRY, and that is WFH-only,
    // pending management approval.
    const mode = workMode !== undefined ? normalizeWorkMode(workMode) : normalizeWorkMode(employee.work_mode);
    if (mode !== "Remote" && mode !== "Hybrid") {
      throw badRequest(
        "Manual attendance entry is allowed only for WFH (Remote/Hybrid) shifts. "
        + "On-site days must come from the device or a missing-punch correction.",
      );
    }
    manualEntryPendingApproval = true;
  }

  // Hours/status derive from the MERGED punch set (supplied ∪ recorded) —
  // a checkout-only correction grades against the device check-in too (#7).
  const hours = effCin && effCout ? Number(((effCout - effCin) / 3600000).toFixed(2)) : null;
  // Status is DERIVED from the merged times, never asserted: a correction
  // supplies the missing punch, it does not re-grade the day (#7).
  const finalStatus = effCin && effCout
    ? "PRESENT"
    : effCin
      ? "MISSING_CHECKOUT"
      : effCout
        ? "MISSING_CHECKIN"
        : "ABSENT";
  const mode = workMode !== undefined ? normalizeWorkMode(workMode) : undefined;

  const result = await tenantTransaction(prisma, async (tx) => {
    const existing = await tx.attendance.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
    });

    const data = {
      // Never write a null over a recorded punch: omitted fields stay absent
      // from the update so COALESCE-with-DB semantics hold (TS-MANUAL-05).
      ...(cin ? { check_in: cin } : {}),
      ...(cout ? { check_out: cout } : {}),
      total_hours: hours,
      status: finalStatus,
      // A missing-punch correction is HR's final word on the day (#7) — it no
      // longer waits on regularization, and the day credits immediately. A
      // brand-new manual ENTRY (#8) holds its credit at null until management
      // approves — payroll must not pay an unapproved entry.
      day_credit: manualEntryPendingApproval ? null : creditFor(finalStatus),
      // A missing-punch correction is HR's final word — the hold clears. A
      // brand-new manual ENTRY stays held until management approves it.
      requires_regularization: manualEntryPendingApproval,
      manually_corrected: true,
      corrected_by_id: actorEmployeeId,
      corrected_at: new Date(),
      correction_reason: manualEntryPendingApproval ? `${text} — pending management approval` : text,
      ...(mode !== undefined ? { work_mode: mode } : {}),
    };

    const row = existing
      ? await tx.attendance.update({ where: { id: existing.id }, data })
      : await tx.attendance.create({
          data: { employeeId, date: day, tenantId: employee.tenant_id ?? tenantId, ...data },
        });

    // Audit trail. Log is the existing HR audit table and already relates to
    // Attendance, so corrections sit alongside every other tracked action.
    await tx.log.create({
      data: {
        tenantId,
        employeeId,
        attendanceId: row.id,
        actionById: actorEmployeeId,
        type: "ATTENDANCE",
        action_type: existing ? "ATTENDANCE_CORRECTED" : "ATTENDANCE_CREATED_MANUALLY",
        module: "attendance",
        ip: "internal",
        os: "internal",
        result: "success",
        // HR-ATT-CORRECTION-02 — record what the day WAS, not only what it
        // became. Without the before-state nobody can tell a correction that
        // moved a day from ABSENT to PRESENT — a day's pay — from one that
        // tidied a check-out minute, and reconstructing it means diffing
        // backups. A day that had no row has no "before", and claiming one
        // would be a fabrication, so only an existing row gets the clause.
        notes: `${actorNote ? `${actorNote} — ` : ""}${day.toISOString().slice(0, 10)}: ` +
               (existing ? `was ${describePrevious(existing)} -> ` : "") +
               `in=${cin ? cin.toISOString() : "-"} out=${cout ? cout.toISOString() : "-"} ` +
               `status=${finalStatus} credit=${creditFor(finalStatus)} — ${text}`,
      },
    });

    return { row, created: !existing };
  });

  logger.info(
    { employeeId, date: day.toISOString().slice(0, 10), status: finalStatus, by: actorEmployeeId },
    "attendance day corrected",
  );

  return {
    attendanceId: result.row.id,
    created: result.created,
    employeeId,
    date: day,
    check_in: result.row.check_in,
    check_out: result.row.check_out,
    total_hours: result.row.total_hours,
    status: result.row.status,
    day_credit: result.row.day_credit,
    manually_corrected: true,
  };
}

/** Corrections in a window, for review and for proving what was changed. */
export async function listCorrections({ tenantId, from, to, employeeId } = {}) {
  const where = { tenantId, manually_corrected: true };
  if (employeeId) where.employeeId = Number(employeeId);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = startOfDay(from);
    if (to) where.date.lte = startOfDay(to);
  }
  return prisma.attendance.findMany({
    where,
    select: {
      id: true, employeeId: true, date: true, check_in: true, check_out: true,
      total_hours: true, status: true, day_credit: true,
      corrected_by_id: true, corrected_at: true, correction_reason: true,
    },
    orderBy: [{ date: "asc" }, { employeeId: "asc" }],
  });
}
