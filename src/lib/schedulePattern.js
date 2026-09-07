// src/lib/schedulePattern.js
//
// What a roster is allowed to say (HR-ROSTER-03).
//
// schedule_pattern is untyped JSON, and every consumer degrades QUIETLY on
// nonsense rather than complaining:
//
//   offDays: [8]       no such weekday, so the person is never off
//   offDays: ["Sat"]   Number("Sat") is NaN — same result
//   shift: {from:"9"}  fails the HH:MM match, so the day has no window and
//                      every scan on it is unrostered
//   cycle, no anchor   the rotation stops applying and rest days read as work
//
// Each is a silent wrong answer with a payroll cost, and this month produced
// real ones: Akash's 07:00 start against a 07:30 arrival turned 18 days into
// lates; Zubair's missing cycle left 9 artefacts nothing could clean; Tanveer's
// weekend was simply the wrong two days. All were found by eye against a
// workbook, which does not scale and did not catch them for a month.
//
// Validation belongs where the pattern is WRITTEN, not spread through every
// reader. At the write boundary a wrong roster is still cheap.
//
// This is deliberately not a schema migration. The shape is genuinely
// open-ended — rotating shifts, cycles, per-weekday hours and per-tenant notes
// have all arrived since it was created — and a validated JSON column keeps
// that flexibility while removing the silent failures, which is the part that
// actually hurt.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isWeekday = (v) => Number.isInteger(v) && v >= 1 && v <= 7;

function checkWindow(win, label, errors) {
  if (!win || typeof win !== "object") {
    errors.push(`${label}: expected { from, to }`);
    return;
  }
  for (const end of ["from", "to"]) {
    if (!HHMM.test(String(win[end] ?? ""))) {
      errors.push(`${label}.${end}: expected HH:MM, got ${JSON.stringify(win[end])}`);
    }
  }
}

/**
 * Check a schedule_pattern before it is stored.
 *
 * Collects EVERY problem rather than stopping at the first: whoever is fixing a
 * roster should see the whole list, not discover the next one on the next save.
 *
 * @param {object|null} pattern
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSchedulePattern(pattern) {
  const errors = [];

  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) {
    return { valid: false, errors: ["pattern: expected an object"] };
  }

  // ── off days ────────────────────────────────────────────────────────────
  const offDays = pattern.offDays;
  if (offDays !== undefined) {
    if (!Array.isArray(offDays)) {
      errors.push("offDays: expected an array of ISO weekdays (Mon=1 .. Sun=7)");
    } else {
      for (const d of offDays) {
        if (!isWeekday(d)) {
          errors.push(`offDays: ${JSON.stringify(d)} is not an ISO weekday (Mon=1 .. Sun=7)`);
        }
      }
      if (offDays.length >= 7) {
        errors.push("offDays: off every day is not a roster");
      }
    }
  }

  // ── shifts ──────────────────────────────────────────────────────────────
  const rotating = Array.isArray(pattern.rotatingShifts) ? pattern.rotatingShifts : null;
  if (pattern.rotatingShifts !== undefined && !rotating) {
    errors.push("rotatingShifts: expected an array of { from, to }");
  }
  if (rotating) {
    rotating.forEach((w, i) => checkWindow(w, `rotatingShifts[${i}]`, errors));
  }
  if (pattern.shift !== undefined) checkWindow(pattern.shift, "shift", errors);

  if (pattern.shiftByDay !== undefined) {
    if (!pattern.shiftByDay || typeof pattern.shiftByDay !== "object") {
      errors.push("shiftByDay: expected an object keyed by ISO weekday");
    } else {
      for (const [k, win] of Object.entries(pattern.shiftByDay)) {
        if (!isWeekday(Number(k))) {
          errors.push(`shiftByDay: ${JSON.stringify(k)} is not an ISO weekday (Mon=1 .. Sun=7)`);
        }
        checkWindow(win, `shiftByDay.${k}`, errors);
      }
    }
  }

  // Without one of these, nothing knows when the person works: every scan is
  // unrostered and grouping falls back to the calendar day, which is the exact
  // defect the sessionisation rewrite existed to remove.
  if (pattern.shift === undefined && !rotating?.length) {
    errors.push("pattern: needs a shift or rotatingShifts — otherwise no day has a window");
  }

  // ── rotation phase ──────────────────────────────────────────────────────
  if (pattern.cycle !== undefined) {
    const c = pattern.cycle;
    if (!c || typeof c !== "object") {
      errors.push("cycle: expected { days, anchor, offIndex }");
    } else {
      const days = Number(c.days);
      const daysOk = Number.isInteger(days) && days > 0;
      if (!daysOk) {
        errors.push(`cycle.days: expected a positive integer, got ${JSON.stringify(c.days)}`);
      }
      if (!ISO_DATE.test(String(c.anchor ?? ""))) {
        errors.push(`cycle.anchor: expected YYYY-MM-DD, got ${JSON.stringify(c.anchor)}`);
      }
      const off = Number(c.offIndex);
      if (!Number.isInteger(off) || off < 0 || (daysOk && off >= days)) {
        errors.push(
          `cycle.offIndex: expected 0..${daysOk ? days - 1 : "days-1"}, `
          + `got ${JSON.stringify(c.offIndex)}`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Throwing form, for write paths that should refuse rather than branch. */
export function assertSchedulePattern(pattern) {
  const { valid, errors } = validateSchedulePattern(pattern);
  if (!valid) {
    throw Object.assign(
      new Error(`invalid schedule pattern: ${errors.join("; ")}`),
      { status: 400, errors },
    );
  }
  return pattern;
}
