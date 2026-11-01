const DAY = 86400000;
const MINUTE = 60000;
export const clockMinutes = (value) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};

// A cutoff belongs to the work date, including overnight shifts. An explicit
// day offset removes ambiguity for cutoffs after midnight.
export function checkoutAt(window, day) {
  if (!window?.checkoutCutoffTime) return null;
  const minutes = clockMinutes(window.checkoutCutoffTime);
  const start = clockMinutes(window.from ?? window.fromTime);
  const offset = window.checkoutCutoffDayOffset ?? (minutes <= start ? 1 : 0);
  if (minutes == null || ![0, 1].includes(offset)) return null;
  const base = new Date(day);
  base.setUTCHours(0, 0, 0, 0);
  return new Date(+base + offset * DAY + minutes * MINUTE);
}

export function validateCheckoutWindow(window, nextStart = null) {
  const from = clockMinutes(window.from ?? window.fromTime);
  const to = clockMinutes(window.to ?? window.toTime);
  if (from == null || to == null)
    throw Object.assign(new Error("Shift times must be HH:MM"), {
      status: 400,
    });
  if (!window.checkoutCutoffTime) return;
  const base = new Date("2026-01-01T00:00:00Z");
  const cutoff = checkoutAt(window, base);
  const end = +base + (to + (to <= from ? 1440 : 0)) * MINUTE;
  if (
    !cutoff ||
    +cutoff < end ||
    (nextStart != null && +cutoff > +nextStart - 60 * MINUTE)
  )
    throw Object.assign(
      new Error(
        "Latest checkout must be at or after shift end and at least one hour before the next shift starts",
      ),
      { status: 400 },
    );
}

// How early before a shift starts its check-in is accepted (the replay's check-in window). A check-out for the
// previous shift stays open until this window opens, so the two never overlap.
export const CHECKIN_WINDOW_MIN = 5 * 60;

// The latest moment a punch still belongs to this shift as its check-out.
//  - A latest check-out HR set on the roster wins (never within an hour of the next shift).
//  - Otherwise, with a later shift rostered: until that shift's check-in window opens, never before the
//    shift ends and never more than a day after it (a weekend gap must not swallow off-day work).
//  - With no later shift: the shift end plus the policy's leniency minutes.
export function boundedCheckout(shift, policy = {}, nextStart = null) {
  if (!shift?.end) return null;
  const next = nextStart || shift.nextShiftStart;
  const end = +shift.end;
  if (shift.checkoutCutoff) {
    const configured = +new Date(shift.checkoutCutoff);
    return new Date(next ? Math.min(configured, +new Date(next) - 60 * MINUTE) : configured);
  }
  if (!next) return new Date(end + (policy.checkoutLeniencyMin ?? 240) * MINUTE);
  const opens = +new Date(next) - (policy.checkinWindowMin ?? CHECKIN_WINDOW_MIN) * MINUTE;
  return new Date(Math.min(Math.max(end, opens), end + DAY));
}
