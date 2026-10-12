import prisma from '../lib/prisma.js';
import { loadAttendanceRuntime } from './attendanceSetup.service.js';
import { badSetup } from '../lib/attendanceDates.js';

export async function enrichPayrollTiming({
  tenantId,
  payrollRun,
  employees,
  db = prisma,
  runtime,
}) {
  const context =
    runtime ||
    (await loadAttendanceRuntime({
      tenantId,
      from: payrollRun.periodStart,
      to: payrollRun.periodEnd,
      db,
    }));
  for (const employee of employees)
    for (const row of employee.attendance || []) {
      const info = row.setupSnapshot?.shift
        ? row.setupSnapshot
        : context.resolve(employee.id, row.date, row.check_in);
      if (info.working == null)
        throw badSetup(
          `Attendance setup is incomplete for employee ${employee.id}`,
          409,
        );
      const policy = info.policy || {},
        shift = info.shift;
      const minutes = (actual, expected, early = false) => {
        if (!actual || !expected) return null;
        const elapsed =
          Math.floor((new Date(actual) - new Date(expected)) / 60000) *
          (early ? -1 : 1);
        return elapsed >
          (early ? policy.earlyLeaveGraceMin || 0 : policy.graceMinutes || 0)
          ? elapsed
          : 0;
      };
      row.lateMinutes = minutes(row.check_in, shift?.start);
      row.earlyMinutes = minutes(row.check_out, shift?.end, true);
    }
}
