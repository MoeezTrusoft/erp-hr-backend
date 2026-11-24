// HR-LEAVE-DAYS-01 — the one place that answers "which dates is this employee on APPROVED leave?".
// A request with per-day rows counts only its APPROVED days; a legacy request (no rows) counts every
// calendar date in its range (what approvedLeaveCoverage expands), weighted totalDays/span so the sum over the
// clipped dates equals payroll's lwpDays formula totalDays*overlap/span, exactly as before per-day decisions existed. Dates are civil YYYY-MM-DD (UTC).
const key = (value) => new Date(value).toISOString().slice(0, 10);
const UNPAID_CODES = new Set(['UNPAID', 'LWP']);

/**
 * includeLegacyLeave also reads the legacy Leave table (attendance excusal only): a Leave row with the same employee,
 * start and end as an approved request is that request's mirror (upsertLegacyLeaveMirror) and is dropped, so a
 * rejected day is not excused through it; any other Leave row (e.g. imported) yields every clipped date with
 * leaveRequestId null and leaveTypeCode null, so it is never counted as LWP.
 * @param {object} db prisma client or transaction
 * @returns {Promise<Array<{employeeId:number,date:string,leaveRequestId:number|null,leaveTypeCode:string|null,weight:number}>>}
 */
export async function approvedLeaveDays(db, { tenantId, employeeIds, from, to, includeLegacyLeave = false }) {
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
  if (includeLegacyLeave) {
    const legacy = await db.leave.findMany({
      where: {
        tenantId,
        status: 'APPROVED',
        start_date: { lte: to },
        end_date: { gte: from },
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      },
      select: { id: true, employeeId: true, start_date: true, end_date: true },
    });
    const mirrors = new Set(requests.map((r) => `${r.employeeId}|${key(r.startDate)}|${key(r.endDate)}`));
    for (const l of legacy) {
      const first = key(l.start_date);
      const last = key(l.end_date);
      if (mirrors.has(`${l.employeeId}|${first}|${last}`)) continue;
      for (let t = Date.parse(first > lo ? first : lo); t <= Date.parse(last < hi ? last : hi); t += 86400000)
        out.push({ employeeId: l.employeeId, date: new Date(t).toISOString().slice(0, 10), leaveRequestId: null, leaveTypeCode: null, weight: 1 });
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
