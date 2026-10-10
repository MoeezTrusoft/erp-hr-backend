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
//   3. arrival — PRESENT / LATE against the employee's own shift start
//   4. early departure — leaving before shift end, beyond a grace
//   5. duration — worked time as a PERCENTAGE of the rostered shift
//   6. precedence — the day takes the WORSE of the arrival and duration verdicts
//
// T&A-RULE-06 / T&A-RULE-07 (2026-10-05) — display and deduction are split:
//
//   * RULE-07 — arrival past the half-day mark still DEDUCTS a half day
//     (dayCredit HALF), but the table shows LATE. HALF_DAY as an arrival
//     verdict is gone; the deduction lives in day_credit, the label in status.
//   * RULE-06 — an early CHECKOUT (beyond earlyLeaveGraceMin) labels the day
//     by where the checkout fell against the half-day mark:
//         checked out BEFORE half the shift  → status HALF_DAY  (half credit)
//         checked out AFTER  half the shift  → status EARLY_CHECKOUT (half credit)
//     Both count as early checkout: both cost half a day and both raise an
//     EARLY_CHECKOUT anomaly. A short day caused by a LATE ARRIVAL (checkout
//     at the rostered end) is NOT an early checkout — it stays LATE.
//
// Rule 5 is a percentage rather than absolute hours because this fleet runs
// 3-hour shifts (EMG 15:30-18:30) alongside 12-hour ones (Homenet 22:00-10:00);
// an absolute "<4h = absent" band would mark whole teams absent every day.
//
// HR-ATT-POLICY-01.

import { pairAttendance, accountAttendance } from './attendanceIntervals.js';
import { shiftDeadline } from './attendanceClock.js';
export const DAY_CREDIT = { FULL: 1.0, HALF: 0.5, NONE: 0.0 };

const MIN_MS = 60 * 1000;

/** Whole minutes from a to b; negative when b precedes a. */
function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MIN_MS);
}

// Union excluded windows before subtracting them: an overlapping break and
// partial holiday must never be subtracted twice.
export function excludedMinutes(start, end, exclusions = []) {
  const ranges = exclusions.map(x => [Math.max(+start,+new Date(x.start)),Math.min(+end,+new Date(x.end))])
    .filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
  let total=0, left=null, right=null;
  for(const [a,b] of ranges) { if(left===null){left=a;right=b;}else if(a<=right)right=Math.max(right,b);else{total+=right-left;left=a;right=b;} }
  return (total+(left===null?0:right-left))/60000;
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
    const sameDirection = prev && (prev.type ?? "") === (p.type ?? "") &&
      prev.sn === p.sn && prev.siteId === p.siteId;
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
  // ATT-GRACE-MIN-01 (2026-09-14) — HR counts grace in elapsed whole minutes:
  // an 8:05 PM arrival against an 8:00 PM shift is 5 minutes late (ON TIME
  // under a 5-minute grace), not 5.78 rounded up to 6 (operator report:
  // Huzaifa/Asad 20:05:47 with a 5-min grace were flagged LATE by second
  // rounding). Truncate to elapsed minutes; never round up into a penalty.
  let diff = Math.floor((checkIn.getTime() - shiftStart.getTime()) / MIN_MS);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

function creditToStatus(credit, arrivalStatus, durationStatus) {
  if (credit === DAY_CREDIT.NONE) return "ABSENT";
  // T&A-RULE-06 — when the CHECKOUT shortened the day, its label wins
  // (EARLY_CHECKOUT / HALF_DAY-by-early-leave), even if the arrival was also
  // late. Otherwise the arrival label carries the half credit: T&A-RULE-07,
  // an arrival past the half-day mark shows LATE while day_credit holds 0.5.
  if (credit < DAY_CREDIT.FULL && durationStatus) return durationStatus;
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
export function evaluateShift(args = {}) {
  const result = evaluateShiftCore(args);
  const cutoff = shiftDeadline(args.shift, args.policy);
  return {
    ...result,
    processingState: result.processingState || (result.inProgress ? 'OPEN' :
      result.dayCredit == null ? 'NEEDS_REVIEW' : 'FINALIZED'),
    deadline: cutoff,
  };
}
function evaluateShiftCore({ punches = [], shift = {}, policy = {}, now = null, credits = [] } = {}) {
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
  const raw = trust ? punches : punches.map((x) => x.directionVerified ? x : ({ ...x, type: "" }));

  let clean = dedupePunches(raw, p.duplicatePunchWindowMin);
  // Only a wholly untyped legacy stream permits positional inference.
  // Mixed or authenticated streams must never have direction invented.
  if (clean.length && clean.every(x=>!x.type)) clean = clean.map((x,i)=>({
    ...x, type:i===0?'IN':i===clean.length-1?'OUT':'',
  }));
  const pairing = pairAttendance(clean);
  const accounting = accountAttendance(pairing.intervals, shift, policy, credits);
  const anomalies = [];

  const scheduledMinutes =
    shift.start && shift.end ? Math.max(minutesBetween(shift.start, shift.end) - excludedMinutes(shift.start, shift.end, shift.exclusions), 0) : null;

  // Half-day threshold: a percentage of the employee's OWN shift when the tenant
  // is configured that way ("half the shift" for four of five tenants), else the
  // fixed minutes. Falls back to the fixed value when there is no rostered shift
  // to take a percentage of — 16 employees are roster-only.
  // Hoisted here (was mid-function) because the IN-PROGRESS branch needs the
  // same threshold — see ATT-LIVE-LATE-01 below.
  const halfDayAfter =
    p.halfDayAfterPercentOfShift != null && scheduledMinutes
      ? (scheduledMinutes * p.halfDayAfterPercentOfShift) / 100
      : p.halfDayAfterMinutes;

  // ── No scan at all ────────────────────────────────────────────────────────
  if (!clean.length) {
    const due = shiftDeadline(shift, policy);
    if (!due || evalTime < due) return {
      status:'PENDING_ATTENDANCE',dayCredit:null,requiresRegularization:false,
      anomalies:[],...accounting,scheduledMinutes,workedPercent:null,
      checkIn:null,checkOut:null,inProgress:true,intervals:[],issues:[],
    };
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
      intervals: [], issues: [], ...accounting,
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
  }
  if (checkIn && checkOut && checkOut <= checkIn) checkOut = null;
  if (pairing.issues.length && !(pairing.issues.every(i=>i.code==='UNMATCHED_OUT') && !checkIn)) {
    return {status:'PUNCH_CONFLICT',dayCredit:null,requiresRegularization:true,
      anomalies:[{type:'OTHER',detail:pairing.issues.map(i=>i.code).join(', ')}],
      ...accounting,scheduledMinutes,workedPercent:null,latenessMinutes:null,
      checkIn,checkOut,intervals:pairing.intervals,issues:pairing.issues};
  }
  // A completed interval followed by another arrival still has a missing OUT.
  if (pairing.open) checkOut = null;

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
      ...accounting, intervals:pairing.intervals, issues:pairing.issues,
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
    const cutoff = shiftDeadline(shift, policy) ??
      new Date(checkIn.getTime() + 24 * 60 * MIN_MS);

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
        ...accounting, intervals:pairing.intervals, issues:pairing.issues,
      };
    }
    // Window still open: the shift is in progress, not an exception yet.
    // ATT-LIVE-LATE-01 (2026-09-14) — arrival facts are FINAL at check-in even
    // while the day is open. This branch used to hardcode PRESENT, so a 23-min-
    // late arrival showed "On Time" on the live table until the window closed
    // (operator report: Faiq, 15:23 vs a 15:00 shift). Status now reflects the
    // arrival (LATE, or HALF_DAY once the half-day threshold is crossed);
    // dayCredit stays null and inProgress stays true — credit is only granted
    // when the window closes and the row finalizes.
    // T&A-RULE-07 — the live row shows LATE for every arrival past grace;
    // the half-day deduction only materialises when the row finalises
    // (dayCredit stays null while in progress).
    const lateNow = latenessMinutes(checkIn, shift.start);
    const openStatus =
      lateNow != null && lateNow > p.graceMinutes ? "LATE" : "PRESENT";
    return {
      status: openStatus,
      dayCredit: null,
      requiresRegularization: false,
      anomalies:
        lateNow != null && lateNow > p.graceMinutes
          ? [{
              type: "LATE_CHECKIN",
              fromTime: shift.start ?? null,
              toTime: checkIn,
              expectedTime: shift.start ?? null,
              actualTime: checkIn,
              minutesLate: lateNow,
            }]
          : [],
      workedMinutes: 0,
      scheduledMinutes,
      workedPercent: null,
      latenessMinutes: lateNow,
      checkIn,
      checkOut: null,
      inProgress: true,
      ...accounting, intervals:pairing.intervals, issues:pairing.issues,
    };
  }

  // ── Arrival ───────────────────────────────────────────────────────────────
  const late = latenessMinutes(checkIn, shift.start);
  let arrivalStatus = "PRESENT";
  let arrivalCredit = DAY_CREDIT.FULL;

  // Half-day threshold is hoisted above (shared with the in-progress branch).

  if (late != null && late > p.graceMinutes) {
    // T&A-RULE-07 — the label is LATE for any arrival past grace; crossing the
    // half-day threshold (default 30 min) changes only the CREDIT: the day is
    // docked half a day, the table still says Late (display ≠ deduction).
    arrivalStatus = "LATE";
    if (late >= halfDayAfter) {
      arrivalCredit = DAY_CREDIT.HALF;
    } else {
      // Late but still a full day's credit — the flag is the penalty, and a
      // deduction rule may convert repeated lates separately.
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
  let leftEarlyBeyondGrace = false;
  if (shift.end && checkOut) {
    // ATT-GRACE-MIN-01 — same elapsed-minutes rule as lateness: floor, never
    // round, so a 04:59:5x checkout against a 05:00 shift end is 0 minutes
    // early, not 1.
    const early = Math.floor((shift.end.getTime() - checkOut.getTime()) / MIN_MS);
    if (early > p.earlyLeaveGraceMin) {
      // T&A-RULE-06 — this is the fact that decides the day's LABEL below,
      // not just whether an anomaly is raised.
      leftEarlyBeyondGrace = true;
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
  const workedMinutes = accounting.creditedMinutes;
  let workedPercent = null;
  let durationCredit = DAY_CREDIT.FULL;
  // T&A-RULE-06 — the label the CHECKOUT earns; null when duration does not
  // shorten the day (or the shortfall is an arrival problem, not a departure).
  let durationStatus = null;

  if (scheduledMinutes && scheduledMinutes > 0) {
    workedPercent = (workedMinutes / scheduledMinutes) * 100;
    if (workedPercent >= p.fullDayMinPercent) {
      durationCredit = DAY_CREDIT.FULL;
    } else if (leftEarlyBeyondGrace) {
      // An actual early checkout: BOTH bands cost half a day and BOTH count
      // as early checkout. Checked out BEFORE the half-day mark the day reads
      // HALF_DAY (it used to fall through to ABSENT); AFTER the mark it reads
      // EARLY_CHECKOUT.
      durationCredit = DAY_CREDIT.HALF;
      durationStatus =
        workedPercent >= p.halfDayMinPercent ? "EARLY_CHECKOUT" : "HALF_DAY";
    } else if (workedPercent >= p.halfDayMinPercent) {
      durationCredit = DAY_CREDIT.HALF;
    } else {
      durationCredit = DAY_CREDIT.NONE;
    }
  }
  // With no rostered shift there is nothing to measure against, so duration
  // cannot downgrade the day. The 16 roster-only employees land here.

  // ── Precedence: the worse verdict wins ────────────────────────────────────
  // On-time but two hours worked is not a full day; late but a full shift
  // worked is not half a day.
  const dayCredit = Math.min(arrivalCredit, durationCredit);
  const status = creditToStatus(dayCredit, arrivalStatus, durationStatus);

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
    ...accounting, intervals:pairing.intervals, issues:pairing.issues,
  };
}
