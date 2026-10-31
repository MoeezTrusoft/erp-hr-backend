// Plain-language, dated description of what the attendance rules charged on a payslip.
// Pure: it takes the lines `ruleDeductions` returned and the cases they came from.
const TYPE_LABELS = {
  LATE_CHECKIN: "Late check-in",
  EARLY_CHECKOUT: "Early check-out",
  MISSING_CHECKIN: "Missing check-in",
  MISSING_CHECKOUT: "Missing check-out",
  ABSENT: "Absent",
};

// The month a run pays for: the month its period starts in (the Vault, register and PDF name runs this
// way). A cycle "1 Sep - 1 Oct" is September, not October.
export const payMonthOf = (periodStart, periodEnd) =>
  (periodStart ?? periodEnd) ? new Date(periodStart ?? periodEnd).toISOString().slice(0, 7) : null;

const day = (value) => new Date(value).toISOString().slice(0, 10);

const minutesOf = (a) => {
  const m = Number(a.measuredMinutes);
  return Number.isFinite(m) && m > 0 ? Math.round(m) : null;
};

const describe = (a) => {
  const label = TYPE_LABELS[a.type] || "Attendance case";
  const minutes = minutesOf(a);
  return {
    date: day(a.date),
    type: a.type,
    label: minutes && ["LATE_CHECKIN", "EARLY_CHECKOUT"].includes(a.type) ? `${label} by ${minutes} min` : label,
  };
};

/**
 * @param {Array} lines  `ruleDeductions(...).lines`
 * @param {Array} cases  the attendance cases that were assessed
 * @returns {Array<{date:string,days:number,pooled:boolean,items:Array<{date:string,type:string,label:string}>}>}
 */
export function describeAttendanceCharges(lines = [], cases = []) {
  const byId = new Map(cases.map((a) => [a.id, a]));
  return lines
    .map((line) => ({
      date: line.date,
      days: line.days,
      pooled: Boolean(line.pooled),
      items: (line.anomalyIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(describe)
        .sort((x, y) => x.date.localeCompare(y.date)),
    }))
    .sort((x, y) => x.date.localeCompare(y.date));
}
