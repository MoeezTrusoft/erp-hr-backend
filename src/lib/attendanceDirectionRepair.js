import { evaluateShift } from "./attendanceEvaluator.js";

// Homenet crews (rotating and day) sometimes press the wrong key: a check-out at
// the start of the shift, a check-in at the end. The device key stays the rule
// (HR-ATT-POLICY-01), so such a day is scored as a Missing Check-in or
// Check-out. This repairs ONLY that case: a day that is incomplete under the
// device key, whose first scan sits nearer the shift start and last scan nearer
// the shift end, and which scores complete when read first = IN, last = OUT.
// A complete day is never touched, and nothing is invented: both times are scans.
const REPAIRABLE = new Set(["MISSING_CHECKIN", "MISSING_CHECKOUT"]);
const COMPLETE_AFTER = new Set(["PRESENT", "LATE", "EARLY_CHECKOUT", "HALF_DAY"]);

// A LONE scan keyed against its position (ATT-LONE-SCAN-01): an OUT at the very start of the shift is
// the arrival (otherwise the day is charged twice, Missing Check-in AND a check-out 8-12 hours early),
// an IN at the very end is the departure (otherwise Late by hours AND Missing Check-out). "Very start"
// and "very end" are the first and last quarter of the rostered shift.
function repairLone({ punches, shift, policy, now, credits, verdict }) {
  const [only] = punches;
  const len = +shift.end - +shift.start;
  const t = +only.timestamp;
  let type = null;
  if (only.type === "OUT" && verdict.status === "MISSING_CHECKIN" && t <= +shift.start + 0.25 * len) type = "IN";
  else if (only.type === "IN" && verdict.status === "MISSING_CHECKOUT" && t >= +shift.end - 0.25 * len) type = "OUT";
  if (!type) return null;
  const retyped = [{ ...only, type, inferred: true }];
  const repaired = evaluateShift({ punches: retyped, shift, policy, now, credits });
  return {
    verdict: { ...repaired, directionRepaired: true },
    punches: retyped,
    corrections: [{
      at: only.timestamp,
      recordedAs: only.type,
      resolvedTo: type,
      reason: type === "IN"
        ? "the only scan of the shift, at its start, recorded as a check-out"
        : "the only scan of the shift, at its end, recorded as a check-in",
    }],
  };
}

export function repairDirection({ punches = [], shift = {}, policy, now, credits, verdict }) {
  if (!REPAIRABLE.has(verdict?.status)) return null;
  if (!shift?.start || !shift?.end) return null;
  const device = punches.filter((p) => !p.manual && !p.directionVerified);
  if (device.length !== punches.length) return null;
  if (punches.length === 1) return repairLone({ punches, shift, policy, now, credits, verdict });
  if (punches.length < 2) return null;
  const ordered = [...punches].sort((a, b) => +a.timestamp - +b.timestamp);
  const first = ordered[0], last = ordered.at(-1);
  if (+last.timestamp - +first.timestamp < 60 * 60 * 1000) return null;
  const near = (t, edge) => Math.abs(+t - +edge);
  if (near(first.timestamp, shift.start) > near(first.timestamp, shift.end)) return null;
  if (near(last.timestamp, shift.end) > near(last.timestamp, shift.start)) return null;
  const retyped = ordered.map((p) => {
    const type = p === first ? "IN" : p === last ? "OUT" : p.type;
    return type === p.type ? p : { ...p, type, inferred: true };
  });
  if (retyped.every((p, i) => p === ordered[i])) return null;
  const repaired = evaluateShift({ punches: retyped, shift, policy, now, credits });
  if (!COMPLETE_AFTER.has(repaired.status) || !repaired.checkIn || !repaired.checkOut) return null;
  const corrections = retyped.filter((p, i) => p !== ordered[i]).map((p) => ({
    at: p.timestamp,
    recordedAs: p.type === "IN" ? "OUT" : "IN",
    resolvedTo: p.type,
    reason: p.type === "IN"
      ? "first scan of the shift, recorded as a check-out; the day is incomplete otherwise"
      : "last scan of the shift, recorded as a check-in; the day is incomplete otherwise",
  }));
  return { verdict: { ...repaired, directionRepaired: true }, punches: retyped, corrections };
}
