// HR-LEAVE-DAYS-01 — the one place that answers "which dates is this employee on APPROVED leave?".
// A request with per-day rows counts only its APPROVED days; a legacy request (no rows) counts every
// calendar date in its range (what approvedLeaveCoverage expands), weighted totalDays/span so the sum over the
// clipped dates equals payroll's lwpDays formula totalDays*overlap/span, exactly as before per-day decisions existed. Dates are civil YYYY-MM-DD (UTC).
const key = (value) => new Date(value).toISOString().slice(0, 10);
const UNPAID_CODES = new Set(['UNPAID', 'LWP']);

/**
 * @param {object} db prisma client or transaction
 * @returns {Promise<Array<{employeeId:number,date:string,leaveRequestId:number,leaveTypeCode:string|null,weight:number}>>}
 */
export async function approvedLeaveDays(db, { tenantId, employeeIds, from, to }) {
  const requests = await db.leaveRequest.findMany({
    where: {
      tenantId,
      status: 'APPROVED',
      startDate: { lte: to },
      endDate: { gte: from },
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
    },
    select: {
      id: true,
      employeeId: true,
      startDate: true,
      endDate: true,
      totalDays: true,
      leavePolicy: { select: { leaveTypeCode: true } },
      days: { select: { date: true, decision: true } },
    },
    orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }, { id: 'asc' }],
  });
  const lo = key(from);
  const hi = key(to);
  const out = [];
  for (const r of requests) {
    const leaveTypeCode = r.leavePolicy?.leaveTypeCode ?? null;
    let rows;
    if (r.days?.length) {
      rows = r.days.filter((d) => d.decision === 'APPROVED').map((d) => ({ date: key(d.date), weight: 1 })).sort((x, y) => (x.date < y.date ? -1 : 1));
    } else {
      const first = key(r.startDate);
      const last = key(r.endDate);
      const span = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;
      const weight = Number(r.totalDays) / span;
      rows = [];
      for (let t = Date.parse(first); t <= Date.parse(last); t += 86400000) rows.push({ date: new Date(t).toISOString().slice(0, 10), weight });
    }
    for (const { date, weight } of rows) {
      if (date >= lo && date <= hi) out.push({ employeeId: r.employeeId, date, leaveRequestId: r.id, leaveTypeCode, weight });
    }
  }
  return out;
}

/** Unpaid (UNPAID or LWP) approved leave days per employee: the sum of row weights (may be fractional). */
export function unpaidLeaveDaysByEmployee(rows) {
  const byEmployee = new Map();
  for (const r of rows) {
    if (UNPAID_CODES.has(r.leaveTypeCode)) byEmployee.set(r.employeeId, (byEmployee.get(r.employeeId) ?? 0) + r.weight);
  }
  return byEmployee;
}
