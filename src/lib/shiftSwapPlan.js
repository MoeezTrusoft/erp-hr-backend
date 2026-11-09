// Shift swap planning — turns an approved swap request into the per-day shift overrides that attendance reads.
//
// A swap exchanges two employees' shifts:
//   • same day (toDate empty or equal to fromDate): each takes the other's shift that day;
//   • two days: the requester gives up `fromDate` (the colleague covers it) and takes the colleague's `toDate`
//     (the colleague is off that day). Nobody ends up on two shifts, and nobody works on a leave or holiday.
// `resolve(employeeId, date)` is the attendance runtime's day resolver, so the plan sees exactly what attendance sees.
import { dateKey } from "./attendanceDates.js";

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, statusCode: status });
};
const OFF = new Set(["OFF_DAY", "ROTATION_OFF"]);
const hhmm = (d) => d.toISOString().slice(11, 16);

// One employee's day as a swappable window: a shift, a plain day off, or "unavailable" (refused).
export function windowOf(info, who, date) {
  const day = dateKey(date);
  if (info?.working === null || info?.working === undefined)
    fail(`${who}'s roster for ${day} is not ready (${info?.reason ?? "no roster"}). Fix the roster first.`);
  if (info.working === false) {
    if (OFF.has(info.reason)) return { off: true };
    fail(`${who} cannot swap on ${day}: it is a ${String(info.reason).toLowerCase().replace(/_/g, " ")}.`);
  }
  if (!info.shift?.start || !info.shift?.end) fail(`${who} has no single shift on ${day} to swap.`);
  const w = info.pattern?.shift ?? {};
  return {
    off: false,
    fromTime: hhmm(info.shift.start),
    toTime: hhmm(info.shift.end),
    templateId: w.templateId ?? null,
    checkoutCutoffTime: w.checkoutCutoffTime ?? null,
    checkoutCutoffDayOffset: w.checkoutCutoffDayOffset ?? 0,
  };
}

const take = (employeeId, date, w) =>
  w.off
    ? { employeeId, date: dateKey(date), status: "off", fromTime: null, toTime: null, templateId: null,
        checkoutCutoffTime: null, checkoutCutoffDayOffset: 0 }
    : { employeeId, date: dateKey(date), status: "on_shift", fromTime: w.fromTime, toTime: w.toTime,
        templateId: w.templateId, checkoutCutoffTime: w.checkoutCutoffTime,
        checkoutCutoffDayOffset: w.checkoutCutoffDayOffset };

export function planSwap({ resolve, requester, target, fromDate, toDate }) {
  const from = dateKey(fromDate),
    to = dateKey(toDate ?? fromDate);
  const day = (p, d) => windowOf(resolve(p.id, d), p.label, d);
  if (from === to) {
    const a = day(requester, from),
      b = day(target, from);
    if (a.off || b.off) fail(`Both employees must be working on ${from} to swap shifts. Use two dates to swap a working day for a day off.`);
    if (a.fromTime === b.fromTime && a.toTime === b.toTime) fail("Both employees already have the same shift that day.");
    return [take(requester.id, from, b), take(target.id, from, a)];
  }
  const aGives = day(requester, from),
    bTakesDayOff = day(target, from),
    bGives = day(target, to),
    aTakesDayOff = day(requester, to);
  if (aGives.off) fail(`${requester.label} is not working on ${from}, so there is no shift to hand over.`);
  if (!bTakesDayOff.off) fail(`${target.label} is already working on ${from}.`);
  if (bGives.off) fail(`${target.label} is not working on ${to}, so there is no shift to take.`);
  if (!aTakesDayOff.off) fail(`${requester.label} is already working on ${to}.`);
  return [
    take(target.id, from, aGives),
    take(requester.id, from, { off: true }),
    take(requester.id, to, bGives),
    take(target.id, to, { off: true }),
  ];
}
