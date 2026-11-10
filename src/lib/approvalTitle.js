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
  // new Date(null) is 1 Jan 1970: a missing date must give no day at all, not "1 Jan".
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};
const day = (value) => {
  const d = date(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : null;
};
const amount = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
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
    case "CLAIM": {
      if (!s.title) return null;
      const sum = s.amount != null && Number(s.amount) > 0 ? `, ${s.currency ? `${s.currency} ` : ""}${amount(s.amount)}` : "";
      return `Claim: ${s.title}${sum}`;
    }
    case "LOAN": {
      // Loans carry no currency of their own (the company pays in one), so the figure stands without it.
      const sum = Number(s.principalMinor) > 0 ? `, ${amount(Number(s.principalMinor) / 100)}` : "";
      if (s.kind === "ADVANCE") return `Salary advance${sum}`;
      const months = Number(s.tenureMonths) > 1 ? ` over ${plural(s.tenureMonths, "month")}` : "";
      return `Loan${sum}${months}`;
    }
    case "SHIFT_SWAP": {
      const when = day(s.fromDate);
      if (!when) return null;
      const other = day(s.toDate);
      return `Shift swap, ${when}${other && other !== when ? ` for ${other}` : ""}`;
    }
    case "ATTENDANCE_RULE_CHANGE": {
      if (s.action === "PUBLISH_SETUP") {
        const from = day(s.payload?.from);
        return from ? `Attendance rules published from ${from}` : "Attendance rules published";
      }
      const from = day(s.payload?.effectiveFrom);
      const what = s.action === "GRACE_MEMBERSHIP" ? "Team or department assignment" : "Grace period change";
      return from ? `${what} from ${from}` : what;
    }
    case "LEAVE_CHANGE": {
      const p = s.payload ?? {};
      if (s.action === "POLICY_CREATE") return p.policy?.name ? `Leave type added: ${p.policy.name}` : "Leave type added";
      if (s.action === "POLICY_UPDATE") return p.policyName ? `Leave type changed: ${p.policyName}` : "Leave type changed";
      if (s.action === "POLICY_DELETE") return p.policyName ? `Leave type removed: ${p.policyName}` : "Leave type removed";
      if (s.action === "BALANCE_SET") return p.employeeName ? `Leave balance change: ${p.employeeName}` : "Leave balance change";
      if (s.action === "CANCEL_LEAVE") {
        const from = day(p.from);
        return p.employeeName ? `Leave cancelled: ${p.employeeName}${from ? `, ${from}` : ""}` : "Leave cancelled";
      }
      return null;
    }
    case "ROSTER_CHANGE": {
      if (s.action === "DELETE") return "Roster removal";
      const from = day(s.payload?.effective_start_date);
      const name = s.payload?.schedule_name ? `: ${s.payload.schedule_name}` : "";
      return from ? `Roster change from ${from}${name}` : "Roster change";
    }
    case "HOLIDAY_CHANGE": {
      if (s.action === "CREATE") {
        const list = Array.isArray(s.payload?.holidays) ? s.payload.holidays : [];
        if (list.length > 1) return `Holidays added: ${plural(list.length, "day")}`;
        const one = list[0];
        return one?.name ? `Holiday added: ${one.name}${day(one.date) ? `, ${day(one.date)}` : ""}` : "Holiday added";
      }
      const verb = s.action === "DELETE" ? "removed" : "changed";
      const when = day(s.payload?.date);
      return s.payload?.name ? `Holiday ${verb}: ${s.payload.name}${when ? `, ${when}` : ""}` : `Holiday ${verb}`;
    }
    case "HOLIDAY_EXEMPTION": {
      const n = Array.isArray(s.employeeIds) ? s.employeeIds.length : 0;
      const holiday = s.summary?.holiday?.name ? `: ${s.summary.holiday.name}` : "";
      return `${s.mode === "RESTORE" ? "Holiday restored" : "Holiday exemption"}${holiday} for ${plural(n, "employee")}`;
    }
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
