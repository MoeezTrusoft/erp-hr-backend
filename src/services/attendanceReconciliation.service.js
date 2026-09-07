// src/services/attendanceReconciliation.service.js
//
// Month-end reconciliation, as a feature (HR-RECON-01).
//
// Every number quoted while fixing August came from a comparison script in a
// scratchpad: dump the rows, match names against HR's workbook, count. It found
// real defects, but it is not something HR can run, and it dies with the
// session it was written in. Closing a month should not require an engineer.
//
// This report became possible only once off-days were asserted
// (HR-ATT-STATUS-01). Before that, "expected working days" had to be guessed —
// timesheetReport.getAttendanceSummaryWeekly still assumes Mon-Sat for
// everyone, which the roster work disproved: real rosters here are Tue+Fri,
// Mon+Wed, Tue+Wed+Thu, Fri+Sat, and 3-day rotations that walk through the
// week. With WEEKLY_OFF / HOLIDAY / ON_LEAVE on the row, the denominator is
// DERIVED rather than assumed.
//
// AUTHORITY: the STORED Attendance.status, like every other read path. Status
// was decided when the day was evaluated, under that day's roster; re-deriving
// it here would produce a second opinion and two reports that disagree.
//
// Read-only.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";

// Incomplete days: payroll HOLDS these rather than paying or docking, so they
// are what actually blocks a month from closing.
const BLOCKING = new Set(["MISSING_CHECKIN", "MISSING_CHECKOUT"]);

const EMPTY = () => ({
  present: 0, late: 0, halfDay: 0, absent: 0,
  missingCheckin: 0, missingCheckout: 0,
  weeklyOff: 0, holiday: 0, onLeave: 0,
  corrected: 0, needsReview: 0,
});

/**
 * Per-employee attendance for a period, with the totals HR argues about.
 *
 * @param {{tenantId: string|null, from: string, to: string}} args
 * @returns {Promise<{period: object, employees: object[], totals: object}>}
 */
export async function buildMonthlyReconciliation({ tenantId, from, to }) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);

  const [roster, rows] = await Promise.all([
    prisma.employee.findMany({
      // Anyone excluded from payroll is not being evaluated (HR-PAY-ELIG-01),
      // so listing them would invite a reconciliation of nothing.
      where: scopedEmployeeWhere(tenantId, { NOT: { payroll_included: false } }),
      select: { id: true, employee_code: true, employee_name: true },
    }),
    prisma.attendance.findMany({
      where: scopedWhere(tenantId, { date: { gte: start, lte: end } }),
      select: {
        employeeId: true, date: true, status: true,
        manually_corrected: true, requires_regularization: true,
      },
    }),
  ]);

  const byEmployee = new Map();
  for (const e of roster) byEmployee.set(e.id, EMPTY());

  for (const r of rows) {
    // A row for somebody outside the roster — excluded from payroll, or another
    // tenant's employee — is not this report's business.
    const acc = byEmployee.get(r.employeeId);
    if (!acc) continue;

    if (r.status === "PRESENT") acc.present += 1;
    else if (r.status === "LATE") acc.late += 1;
    else if (r.status === "HALF_DAY") acc.halfDay += 1;
    else if (r.status === "ABSENT") acc.absent += 1;
    else if (r.status === "MISSING_CHECKIN") acc.missingCheckin += 1;
    else if (r.status === "MISSING_CHECKOUT") acc.missingCheckout += 1;
    else if (r.status === "WEEKLY_OFF") acc.weeklyOff += 1;
    else if (r.status === "HOLIDAY") acc.holiday += 1;
    else if (r.status === "ON_LEAVE") acc.onLeave += 1;

    if (r.manually_corrected) acc.corrected += 1;
    if (r.requires_regularization || BLOCKING.has(r.status)) acc.needsReview += 1;
  }

  const employees = roster.map((e) => {
    const a = byEmployee.get(e.id);
    const attended = a.present + a.late + a.halfDay;
    // Expected = the days they were rostered in. WEEKLY_OFF, HOLIDAY and
    // ON_LEAVE are excluded by construction rather than by a weekday guess.
    const expectedDays = attended + a.absent + a.missingCheckin + a.missingCheckout;
    const rowsForEmployee = expectedDays + a.weeklyOff + a.holiday + a.onLeave;
    return {
      employeeId: e.id,
      employeeCode: e.employee_code,
      employeeName: e.employee_name,
      ...a,
      expectedDays,
      attendedDays: attended,
      attendancePct: expectedDays ? Math.round((attended / expectedDays) * 100) : 0,
      // A blank month is the most important line in a reconciliation: it is how
      // somebody goes unpaid quietly. Flagged, never omitted.
      noData: rowsForEmployee === 0,
    };
  });

  const totals = employees.reduce(
    (t, e) => {
      for (const k of Object.keys(EMPTY())) t[k] += e[k];
      t.expectedDays += e.expectedDays;
      t.attendedDays += e.attendedDays;
      if (e.noData) t.noData += 1;
      return t;
    },
    { ...EMPTY(), expectedDays: 0, attendedDays: 0, noData: 0, employees: employees.length },
  );
  totals.attendancePct = totals.expectedDays
    ? Math.round((totals.attendedDays / totals.expectedDays) * 100)
    : 0;

  logger.info(
    { tenantId, from, to, employees: totals.employees, needsReview: totals.needsReview },
    "attendance reconciliation built",
  );

  return { period: { from, to }, employees, totals };
}
