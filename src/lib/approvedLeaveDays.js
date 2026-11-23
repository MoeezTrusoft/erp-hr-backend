// HR-LEAVE-DAYS-01 — the one place that answers "which dates is this employee on APPROVED leave?".
// A request with per-day rows counts only its APPROVED days; a legacy request (no rows) counts every
// working date in its range, exactly as before per-day decisions existed. Dates are civil YYYY-MM-DD (UTC).
import { listWorkingDates } from '../services/leave.service.js';

const key = (value) => new Date(value).toISOString().slice(0, 10);
const UNPAID_CODES = new Set(['UNPAID', 'LWP']);

/**
 * @param {object} db prisma client or transaction
 * @returns {Promise<Array<{employeeId:number,date:string,leaveRequestId:number,leaveTypeCode:string|null}>>}
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
    let dates;
    if (r.days?.length) {
      dates = r.days.filter((d) => d.decision === 'APPROVED').map((d) => key(d.date)).sort();
    } else {
      const start = key(r.startDate) < lo ? from : r.startDate;
      const end = key(r.endDate) > hi ? to : r.endDate;
      dates = await listWorkingDates(r.employeeId, start, end, tenantId);
    }
    for (const date of dates) {
      if (date >= lo && date <= hi) out.push({ employeeId: r.employeeId, date, leaveRequestId: r.id, leaveTypeCode });
    }
  }
  return out;
}

/** Unpaid (UNPAID or LWP) approved leave days per employee. */
export function unpaidLeaveDaysByEmployee(rows) {
  const byEmployee = new Map();
  for (const r of rows) {
    if (UNPAID_CODES.has(r.leaveTypeCode)) byEmployee.set(r.employeeId, (byEmployee.get(r.employeeId) ?? 0) + 1);
  }
  return byEmployee;
}
