import { dateOnly, dateKey } from "./attendanceDates.js";
// The established approval chain remains the authority for overtime. Legacy
// approvals without clock bounds carry a daily budget, never invented presence.
export function approvedOvertimeCredits(requests) {
  return requests
    .filter(
      (r) => r.status === "APPROVED" && Number.isFinite(r.hours) && r.hours > 0,
    )
    .map((r) => {
      const day = dateOnly(r.date),
        clock = /^([01]\d|2[0-3]):[0-5]\d$/;
      let start = day,
        end = new Date(+day + 48 * 3600000);
      if (clock.test(r.fromTime) && clock.test(r.toTime)) {
        start = new Date(dateKey(day) + "T" + r.fromTime + ":00Z");
        end = new Date(dateKey(day) + "T" + r.toTime + ":00Z");
        if (end <= start) end = new Date(+end + 86400000);
      }
      return {
        id: "overtime-request:" + r.id,
        employeeId: r.employeeId,
        date: day,
        kind: "OVERTIME",
        start,
        end,
        maxMinutes: r.hours * 60,
        paid: true,
        approvedBy: r.approverId,
        approvalSource: "OVERTIME_WORKFLOW",
      };
    });
}
export function capDailyOvertime(sessions) {
  const spent = new Map();
  for (const s of [...sessions].sort(
    (a, b) => (+a.shift?.start || 0) - (+b.shift?.start || 0),
  )) {
    if (s.setupSnapshot.policy?.overtimeNeedsApproval === false) continue;
    const own = s.credits.filter((c) => c.kind === "OVERTIME");
    const budget = own.reduce((n, c) => n + (c.maxMinutes ?? Infinity), 0);
    const key = s.employeeId + "|" + dateKey(s.day),
      prior = spent.get(key) || 0;
    const before = s.verdict.approvedOvertimeMinutes || 0,
      after = Math.min(before, Math.max(0, budget - prior));
    if (s.verdict.payableMinutes != null)
      s.verdict.payableMinutes -= before - after;
    s.verdict.approvedOvertimeMinutes = after;
    spent.set(key, prior + after);
  }
  return sessions;
}
