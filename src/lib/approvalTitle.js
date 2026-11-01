// Plain-language titles for approval requests: what it is, whose day, not the kind enum.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ATTENDANCE_TYPES = {
  LATE_CHECKIN: "Late check-in",
  EARLY_CHECKOUT: "Early check-out",
  MISSING_CHECKIN: "Missing check-in",
  MISSING_CHECKOUT: "Missing check-out",
  ABSENT: "Absent",
};

const date = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};
const day = (value) => {
  const d = date(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : null;
};
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

/** @returns {string|null} a title, or null when the kind has none (screens fall back to the kind's name). */
export function requestTitle(kind, snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  switch (kind) {
    case "ATTENDANCE": {
      const label = ATTENDANCE_TYPES[s.type];
      const when = day(s.date);
      return label ? (when ? `${label}, ${when}` : label) : null;
    }
    case "LEAVE": {
      const from = day(s.startDate);
      if (!from) return null;
      const to = day(s.endDate);
      const days = s.totalDays != null ? ` (${plural(s.totalDays, "day")})` : "";
      return `Leave, ${from}${to && to !== from ? ` to ${to}` : ""}${days}`;
    }
    case "OVERTIME": {
      const when = day(s.date);
      if (!when) return null;
      return s.hours != null ? `Overtime, ${when}, ${plural(s.hours, "hour")}` : `Overtime, ${when}`;
    }
    case "CLAIM":
      return s.title ? `Claim: ${s.title}` : null;
    case "LOAN":
      return s.kind === "ADVANCE" ? "Salary advance" : "Loan";
    case "PAYROLL": {
      const d = date(s.periodStart);
      if (!d) return null;
      const month = `${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      const net =
        s.totalNet != null && s.currencyCode
          ? `, net ${s.currencyCode} ${Number(s.totalNet).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          : "";
      return `Payroll for ${month}${net}`;
    }
    default:
      return null;
  }
}
