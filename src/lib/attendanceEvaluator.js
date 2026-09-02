// src/lib/attendanceEvaluator.js
//
// The attendance rules, as one pure function. No database, no clock of its own,
// no imports — everything it needs arrives as arguments. That is deliberate:
// the shadow replay has to run this over 4314 real punches and diff the result
// against what is stored, which is only honest if evaluation cannot touch
// anything.
//
// Rules implemented, in the order they interact:
//
//   1. anti-passback — identical punches inside a small window collapse to one
//   2. missing punches — an IN with no OUT (past the cutoff), or an OUT with no IN
//   3. arrival — PRESENT / LATE / HALF_DAY against the employee's own shift start
//   4. early departure — leaving before shift end, beyond a grace
//   5. duration — worked time as a PERCENTAGE of the rostered shift
//   6. precedence — the day takes the WORSE of the arrival and duration verdicts
//
// Rule 5 is a percentage rather than absolute hours because this fleet runs
// 3-hour shifts (EMG 15:30-18:30) alongside 12-hour ones (Homenet 22:00-10:00);
// an absolute "<4h = absent" band would mark whole teams absent every day.
//
// HR-ATT-POLICY-01.

export const DAY_CREDIT = { FULL: 1.0, HALF: 0.5, NONE: 0.0 };

const MIN_MS = 60 * 1000;

/** Whole minutes from a to b; negative when b precedes a. */
function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MIN_MS);
}

/**
 * Collapse repeated scans. The device emits bursts — one real enrolment
 * produced 23:05:15, :16 and :17 — and without this they inflate the punch
 * count and can turn a lone check-in into a phantom in/out pair.
 */
function dedupePunches(punches, windowMin) {
  const sorted = [...punches]
    .filter((p) => p?.timestamp instanceof Date && !Number.isNaN(p.timestamp.getTime()))
    .sort((a, b) => a.timestamp - b.timestamp);

  const out = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    const sameDirection = prev && (prev.type ?? "") === (p.type ?? "");
    if (prev && sameDirection && minutesBetween(prev.timestamp, p.timestamp) <= windowMin) {
      continue; // a repeat of the scan we already have
    }
    out.push(p);
  }
  return out;
}

/**
 * Lateness in minutes, tolerant of midnight.
 *
 * Comparing raw minutes-of-day breaks both ways here: 00:30 on a 22:00 shift is
 * 2.5h late, not 21.5h early, and 23:05 on a 00:00 shift is 55m early, not 23h
 * late. Comparing absolute timestamps and folding by whole days handles both.
 */
function latenessMinutes(checkIn, shiftStart) {
  if (!checkIn || !shiftStart) return null;
  let diff = minutesBetween(shiftStart, checkIn);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

function creditToStatus(credit, arrivalStatus) {
  if (credit === DAY_CREDIT.NONE) return "ABSENT";
  if (credit === DAY_CREDIT.HALF) return "HALF_DAY";
  return arrivalStatus;
}

/**
 * Score one shift.
 *
 * @param {object[]} punches   [{ timestamp: Date, type: 'IN'|'OUT'|'' }]
 * @param {object}   shift     { start: Date|null, end: Date|null }
 * @param {object}   policy    AttendancePolicyConfig (or its defaults)
 * @param {object}   nextDay   { working: boolean, nextShiftStart: Date|null }
 * @param {Date}     now       evaluation time — decides whether a cutoff has passed
 *
 * @returns {{status, dayCredit, requiresRegularization, anomalies, workedMinutes,
 *            scheduledMinutes, workedPercent, latenessMinutes, checkIn, checkOut}}
 */
export function evaluateShift({ punches = [], shift = {}, policy = {}, nextDay = {}, now = null } = {}) {
  const p = {
    graceMinutes: policy.graceMinutes ?? 0,
    halfDayAfterMinutes: policy.halfDayAfterMinutes ?? 30,
    halfDayAfterPercentOfShift: policy.halfDayAfterPercentOfShift ?? null,
    earlyLeaveGraceMin: policy.earlyLeaveGraceMin ?? 0,
    checkoutLeniencyMin: policy.checkoutLeniencyMin ?? 240,
    fullDayMinPercent: policy.fullDayMinPercent ?? 90,
    halfDayMinPercent: policy.halfDayMinPercent ?? 50,
    duplicatePunchWindowMin: policy.duplicatePunchWindowMin ?? 5,
  };

  const evalTime = now instanceof Date ? now : new Date();

  // The device's direction code IS trustworthy. Validated 2026-09-02 against
  // HR's own ClockingReport export of the same period: 4404 rows joined on
  // (user, timestamp) with ZERO disagreement —
  //   status 0 -> Check-In (2174)   status 1 -> Check-Out (2191)
  //   status 4 -> Overtime-In (4)   status 5 -> Overtime-Out (32)
  //   verifyMode 1 -> FP, 15 -> FACE, 3 -> PW
  // An earlier reading of this data concluded the flag was unreliable because
  // 462 sessions open with a check-out code. They do — but because the check-IN
  // was never recorded, which is a real missing punch, not a mislabelled one.
  // trustDeviceDirection:false falls back to positional inference for hardware
  // that genuinely does not record direction.
  const trust = policy.trustDeviceDirection !== false;
  const raw = trust ? punches : punches.map((x) => ({ ...x, type: "" }));

  const clean = dedupePunches(raw, p.duplicatePunchWindowMin);
  const anomalies = [];

  const scheduledMinutes =
    shift.start && shift.end ? Math.max(minutesBetween(shift.start, shift.end), 0) : null;

  // ── No scan at all ────────────────────────────────────────────────────────
  if (!clean.length) {
    return {
      status: "ABSENT",
      dayCredit: DAY_CREDIT.NONE,
      requiresRegularization: false,
      anomalies: [{ type: "ABSENT", fromTime: shift.start ?? null, toTime: shift.end ?? null }],
      workedMinutes: 0,
      scheduledMinutes,
      workedPercent: 0,
      latenessMinutes: null,
      checkIn: null,
      checkOut: null,
    };
  }

  const ins = clean.filter((x) => x.type === "IN");
  const outs = clean.filter((x) => x.type === "OUT");

  let checkIn = ins.length ? ins[0].timestamp : null;
  let checkOut = outs.length ? outs[outs.length - 1].timestamp : null;

  // Untyped punches: first is the arrival, last is the departure, and a single
  // untyped scan is an arrival with no departure.
  if (!checkIn && !checkOut) {
    checkIn = clean[0].timestamp;
    if (clean.length > 1) checkOut = clean[clean.length - 1].timestamp;
  } else if (!checkIn && checkOut) {
    // OUT with no IN — genuinely a missing check-in, handled below.
  } else if (checkIn && !checkOut && clean.length > 1) {
    const last = clean[clean.length - 1].timestamp;
    if (last > checkIn) checkOut = last;
  }
  if (checkIn && checkOut && checkOut <= checkIn) checkOut = null;

  // ── Missing check-in ──────────────────────────────────────────────────────
  // A departure with no arrival. Blocking: the day cannot be scored, so it is
  // held rather than paid or docked.
  if (!checkIn && checkOut) {
    return {
      status: "MISSING_CHECKIN",
      dayCredit: null,
      requiresRegularization: true,
      anomalies: [{ type: "MISSING_CHECKIN", fromTime: shift.start ?? null, toTime: checkOut, actualTime: null }],
      workedMinutes: 0,
      scheduledMinutes,
      workedPercent: null,
      latenessMinutes: null,
      checkIn: null,
      checkOut,
    };
  }

  // ── Missing check-out ─────────────────────────────────────────────────────
  // Only once the search window has closed. Before that the employee may simply
  // still be at work, and flagging early would raise an exception that resolves
  // itself an hour later.
  if (checkIn && !checkOut) {
    // Cutoff, strongest signal first. The last arm matters: an employee with no
    // rostered shift end (16 of this roster are roster-only) previously yielded
    // a null cutoff, so the day NEVER closed — it sat "in progress" with null
    // credit indefinitely, neither flagged nor paid. 252 August shifts were
    // stuck that way. A shift that began more than a day ago is over, whatever
    // the roster does or does not say.
    const cutoff = nextDay.working && nextDay.nextShiftStart
      ? nextDay.nextShiftStart
      : shift.end
        ? new Date(shift.end.getTime() + p.checkoutLeniencyMin * MIN_MS)
        : new Date(checkIn.getTime() + 24 * 60 * MIN_MS);

    const closed = evalTime >= cutoff;
    if (closed) {
      return {
        status: "MISSING_CHECKOUT",
        dayCredit: null,
        requiresRegularization: true,
        anomalies: [{ type: "MISSING_CHECKOUT", fromTime: checkIn, toTime: shift.end ?? null, actualTime: null }],
        workedMinutes: 0,
        scheduledMinutes,
        workedPercent: null,
        latenessMinutes: latenessMinutes(checkIn, shift.start),
        checkIn,
        checkOut: null,
      };
    }
    // Window still open: the shift is in progress, not an exception yet.
    return {
      status: "PRESENT",
      dayCredit: null,
      requiresRegularization: false,
      anomalies: [],
      workedMinutes: 0,
      scheduledMinutes,
      workedPercent: null,
      latenessMinutes: latenessMinutes(checkIn, shift.start),
      checkIn,
      checkOut: null,
      inProgress: true,
    };
  }

  // ── Arrival ───────────────────────────────────────────────────────────────
  const late = latenessMinutes(checkIn, shift.start);
  let arrivalStatus = "PRESENT";
  let arrivalCredit = DAY_CREDIT.FULL;

  // Half-day threshold: a percentage of the employee's OWN shift when the tenant
  // is configured that way ("half the shift" for four of five tenants), else the
  // fixed minutes. Falls back to the fixed value when there is no rostered shift
  // to take a percentage of — 16 employees are roster-only.
  const halfDayAfter =
    p.halfDayAfterPercentOfShift != null && scheduledMinutes
      ? (scheduledMinutes * p.halfDayAfterPercentOfShift) / 100
      : p.halfDayAfterMinutes;

  if (late != null && late > p.graceMinutes) {
    if (late >= halfDayAfter) {
      arrivalStatus = "HALF_DAY";
      arrivalCredit = DAY_CREDIT.HALF;
    } else {
      // Late but still a full day's credit — the flag is the penalty, and a
      // deduction rule may convert repeated lates separately.
      arrivalStatus = "LATE";
      arrivalCredit = DAY_CREDIT.FULL;
    }
    anomalies.push({
      type: "LATE_CHECKIN",
      fromTime: shift.start ?? null,
      toTime: checkIn,
      expectedTime: shift.start ?? null,
      actualTime: checkIn,
      minutesLate: late,
    });
  }

  // ── Early departure ───────────────────────────────────────────────────────
  if (shift.end && checkOut) {
    const early = minutesBetween(checkOut, shift.end);
    if (early > p.earlyLeaveGraceMin) {
      anomalies.push({
        type: "EARLY_CHECKOUT",
        fromTime: checkOut,
        toTime: shift.end,
        expectedTime: shift.end,
        actualTime: checkOut,
        minutesEarly: early,
      });
    }
  }

  // ── Duration ──────────────────────────────────────────────────────────────
  const workedMinutes = Math.max(minutesBetween(checkIn, checkOut), 0);
  let workedPercent = null;
  let durationCredit = DAY_CREDIT.FULL;

  if (scheduledMinutes && scheduledMinutes > 0) {
    workedPercent = (workedMinutes / scheduledMinutes) * 100;
    if (workedPercent >= p.fullDayMinPercent) durationCredit = DAY_CREDIT.FULL;
    else if (workedPercent >= p.halfDayMinPercent) durationCredit = DAY_CREDIT.HALF;
    else durationCredit = DAY_CREDIT.NONE;
  }
  // With no rostered shift there is nothing to measure against, so duration
  // cannot downgrade the day. The 16 roster-only employees land here.

  // ── Precedence: the worse verdict wins ────────────────────────────────────
  // On-time but two hours worked is not a full day; late but a full shift
  // worked is not half a day.
  const dayCredit = Math.min(arrivalCredit, durationCredit);
  const status = creditToStatus(dayCredit, arrivalStatus);

  return {
    status,
    dayCredit,
    requiresRegularization: false,
    anomalies,
    workedMinutes,
    scheduledMinutes,
    workedPercent,
    latenessMinutes: late,
    checkIn,
    checkOut,
  };
}
