import {
  countViolationDays,
  computeAttendanceDeductions,
} from "./attendanceDeduction.js";
const day = (value) =>
  value ? new Date(value).toISOString().slice(0, 10) : null;
const nonworking = new Set(["WEEKLY_OFF", "HOLIDAY", "ON_LEAVE"]);
const poolable = new Set([
  "LATE",
  "EARLY_CHECKOUT",
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "MISSING_PUNCH",
]);
export function manualDeductionsByShift(anomalies = []) {
  const grouped = new Map(),
    seen = new Set();
  for (const a of anomalies) {
    if (a.manualDeductionDays == null || !a.date) continue;
    if (![0.5, 1].includes(Number(a.manualDeductionDays)))
      throw new Error("Invalid stored manual deduction");
    if (a.id != null && seen.has(a.id)) continue;
    if (a.id != null) seen.add(a.id);
    const key = day(a.date);
    grouped.set(
      key,
      Math.max(grouped.get(key) || 0, Number(a.manualDeductionDays)),
    );
  }
  return grouped;
}
export function isAttendanceExcused(row, anomalies = []) {
  const types = {
    LATE: "LATE_CHECKIN",
    HALF_DAY: "LATE_CHECKIN",
    MISSING_CHECKIN: "MISSING_CHECKIN",
    MISSING_CHECKOUT: "MISSING_CHECKOUT",
    EARLY_CHECKOUT: "EARLY_CHECKOUT",
    ABSENT: "ABSENT",
  };
  return anomalies.some(
    (a) =>
      a.status === "APPROVED" &&
      day(a.date) === day(row.date) &&
      (!a.type || a.type === types[row.status]),
  );
}
// Match the existing attendance-policy modes. Threshold charges are attributed
// to the shift that completes their counter, in work-date order. This preserves
// the automatic policy for unmarked shifts. Manually marked shifts are excluded
// from automatic credit-loss and occurrence counters.
function automaticTotal(attendance, anomalies, rules, config) {
  const lines = computeAttendanceDeductions({
    violations: countViolationDays({ attendance, anomalies }),
    rules,
  });
  const pooled = config.deductionBasis === "POOLED_FLOOR";
  const direct = config.deductionBasis === "POOLED_FLOOR_DIRECT";
  let rawHundredths = 0,
    fixedHundredths = 0;
  for (const line of lines) {
    if (
      (pooled || (direct && line.ruleKey === "LATE")) &&
      poolable.has(line.ruleKey)
    )
      rawHundredths += Math.round(line.rawDays * 100);
    else fixedHundredths += Math.round(line.days * 100);
  }
  const charged = new Set();
  let absenceHundredths = 0;
  if (config.absenceRecoveryEnabled === true)
    for (const row of attendance) {
      const key = day(row.date);
      if (
        charged.has(key) ||
        row.day_credit == null ||
        nonworking.has(row.status) ||
        isAttendanceExcused(row, anomalies)
      )
        continue;
      const credit = Number(row.day_credit);
      if (!Number.isFinite(credit) || credit < 0 || credit > 1) continue;
      const lost = 100 - Math.round(credit * 100);
      if (lost > 0) {
        absenceHundredths += lost;
        charged.add(key);
      }
    }
  let refusedHundredths = 0;
  if (direct)
    for (const a of anomalies) {
      const key = day(a.date);
      if (
        a.status === "REJECTED" &&
        a.type === "ABSENT" &&
        !charged.has(key) &&
        !isAttendanceExcused({ date: a.date, status: "ABSENT" }, anomalies)
      ) {
        refusedHundredths += 100;
        charged.add(key);
      }
    }
  return (
    (fixedHundredths +
      (pooled
        ? Math.floor((rawHundredths + absenceHundredths) / 100) * 100
        : direct
          ? Math.floor(rawHundredths / 100) * 100 +
            absenceHundredths +
            refusedHundredths
          : absenceHundredths)) /
    100
  );
}
export function combinedAttendanceDeductions({
  attendance = [],
  anomalies = [],
  rules = [],
  config = {},
} = {}) {
  const manual = manualDeductionsByShift(anomalies);
  const dates = [
    ...new Set(
      [...attendance, ...anomalies].map((a) => day(a.date)).filter(Boolean),
    ),
  ].sort();
  let prior = 0;
  return dates
    .map((date) => {
      const automatic = automaticTotal(
        attendance.filter(
          (a) => day(a.date) <= date && !manual.has(day(a.date)),
        ),
        anomalies.filter(
          (a) => a.date && day(a.date) <= date && !manual.has(day(a.date)),
        ),
        rules,
        config,
      );
      const automaticDays = Math.max(
        0,
        Math.round((automatic - prior) * 100) / 100,
      );
      prior = automatic;
      const manualDays = manual.get(date) || 0;
      return {
        date,
        automaticDays,
        manualDays,
        days: manual.has(date) ? manualDays : automaticDays,
      };
    })
    .filter((line) => line.days > 0);
}
