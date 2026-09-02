// src/services/absenceMarking.service.js
//
// Marks a scheduled working day with no attendance as ABSENT.
//
// Nothing did this before: if somebody simply did not turn up, no row was
// created at all, so the day was invisible rather than unpaid.
//
// Three guards decide who is eligible, and each exists because of a real
// property of this roster:
//
//   1. ONLY ENROLLED EMPLOYEES. 8 of 75 have no biometric_id and generate no
//      punches whatever they do — BOC has 1 of 3 enrolled, JOC 1 of 5. Marking
//      them absent would dock people daily for not being on the device.
//   2. ONLY SCHEDULED WORKING DAYS. Off-days, holidays and approved leave are
//      skipped via the working-day resolver.
//   3. NEVER OVERWRITE. A day that already has attendance, or that HR corrected
//      by hand, is left alone.
//
// An absence is raised as requires_regularization, so the employee can file an
// anomaly request and have it approved rather than the day being final.
//
// HR-ATT-ABSENCE-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolveWorkingDays } from "./workingDay.service.js";
import logger from "../lib/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };
const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/**
 * @param {boolean} [dryRun] report what would be marked without writing. The
 *   default is TRUE: this creates unpaid days, so it must be asked for.
 */
export async function markAbsences({ tenantId, from, to, dryRun = true }) {
  const first = startOfDay(from);
  const last = startOfDay(to);
  if (last < first) throw Object.assign(new Error("`to` is before `from`"), { status: 400 });

  // Guard 1: enrolled employees only.
  const employees = await prisma.employee.findMany({
    where: { biometric_id: { not: null } },
    select: { id: true, employee_code: true, biometric_id: true },
  });

  const summary = {
    tenantId, from: dayKey(first), to: dayKey(last), dryRun,
    employeesConsidered: employees.length,
    skippedNotEnrolled: await prisma.employee.count({ where: { biometric_id: null } }),
    marked: 0, alreadyPresent: 0, notWorking: 0, manuallyCorrected: 0,
    details: [],
  };

  for (const emp of employees) {
    const [working, existing] = await Promise.all([
      resolveWorkingDays({ employeeId: emp.id, from: first, to: last }),
      prisma.attendance.findMany({
        where: { employeeId: emp.id, date: { gte: first, lte: last } },
        select: { id: true, date: true, manually_corrected: true },
      }),
    ]);
    const byDay = new Map(existing.map((a) => [dayKey(a.date), a]));

    for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) {
      const day = new Date(t);
      const key = dayKey(day);

      // Guard 2: only days the employee was scheduled to work.
      if (!working.get(key)?.working) { summary.notWorking += 1; continue; }

      // Guard 3: never overwrite an existing or hand-corrected day.
      const row = byDay.get(key);
      if (row?.manually_corrected) { summary.manuallyCorrected += 1; continue; }
      if (row) { summary.alreadyPresent += 1; continue; }

      summary.marked += 1;
      summary.details.push({ employeeId: emp.id, employee_code: emp.employee_code, date: key });

      if (!dryRun) {
        await tenantTransaction(prisma, async (tx) =>
          tx.attendance.create({
            data: {
              tenantId, employeeId: emp.id, date: day,
              status: "ABSENT", day_credit: 0,
              // Raised for regularization, not treated as settled: the employee
              // can file an anomaly request and have the day put right.
              requires_regularization: true,
              remarks: "No attendance recorded on a scheduled working day",
            },
          }),
        );
      }
    }
  }

  logger[dryRun ? "info" : "warn"](
    { tenantId, marked: summary.marked, dryRun },
    dryRun ? "absence marking (dry run)" : "absences marked",
  );
  return summary;
}
