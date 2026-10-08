// src/services/absenceMarking.service.js
//
// Marks a scheduled working day with no attendance as ABSENT.
//
// Nothing did this before: if somebody simply did not turn up, no row was
// created at all, so the day was invisible rather than unpaid.
//// Three guards decide who is eligible, and each exists because of a real
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
// HR-ATT-ABSENCE-ELIG-01 (2026-09-14) — three more guards, added after the
// August runs proved each omission expensive:
//   4. TENANT-SCOPED. Guard 1 read employees across the WHOLE DATABASE and
//      ignored the tenant argument entirely — marking absences for Trusoft
//      also wrote ABSENT rows for JOC/BOC/Homenet people. The rows were not
//      just noise: listCheckInOuts renders them in every tenant's table.
//   5. PAYROLL-ELIGIBLE ONLY (HR-PAY-ELIG-01). payroll_included=false means
//      "not on attendance/payroll at all" — their punches are still stored
//      but nothing about them is derived. Terminated people (status=Inactive)
//      are excluded the same way: Obaid was terminated 2026-09-08 and the
//      next day's run charged him absences.
//   6. INSIDE AN ACTIVE EMPLOYMENT PERIOD. Meesam was terminated 2026-08-19
//      and re-hired 2026-09-04; the daily runs charged the gap as ABSENT days
//      on a person who was not employed. An open period or one spanning the
//      day is required; employees with NO period row keep the legacy
//      behaviour (imported rosters do not all carry periods yet).
//
// An absence is raised as requires_regularization, so the employee can file an
// anomaly request and have it approved rather than the day being final.//
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

  // Guard 1: enrolled employees only — and (HR-ATT-ABSENCE-ELIG-01) only the
  // caller's own tenant, only attendance/payroll-eligible people, and never
  // the separated. Before this the query was a whole-DB, status-blind scan and
  // the tenant argument was decoration.
  const employees = await prisma.employee.findMany({
    where: {
      biometric_id: { not: null },
      tenant_id: tenantId ?? undefined,
      payroll_included: true,
      attendanceInputMode: {not:"MANUAL_MONTHLY"},
      status: { not: "Inactive" },
    },
    select: { id: true, employee_code: true, biometric_id: true },
  });

  // Guard 6: employment periods. One query for the whole cohort; an employee
  // with no period row at all is grandfathered (legacy imported rosters).
  const periods = await prisma.employmentPeriod.findMany({
    where: { employeeId: { in: employees.map((e) => e.id) } },
    select: { employeeId: true, startDate: true, endDate: true },
  });
  const periodsByEmployee = new Map();
  for (const p of periods) {
    if (!periodsByEmployee.has(p.employeeId)) periodsByEmployee.set(p.employeeId, []);
    periodsByEmployee.get(p.employeeId).push(p);
  }
  const employedOn = (employeeId, day) => {
    const list = periodsByEmployee.get(employeeId);
    if (!list?.length) return true; // no periods on file → legacy behaviour
    // Open-ended period OR one that spans the day (endDate is inclusive end).
    return list.some(
      (p) =>
        p.startDate?.getTime() <= day.getTime() &&
        (p.endDate == null || day.getTime() <= p.endDate.getTime()),
    );
  };

  const summary = {
    tenantId, from: dayKey(first), to: dayKey(last), dryRun,
    employeesConsidered: employees.length,
    skippedNotEnrolled: await prisma.employee.count({ where: { biometric_id: null } }),
    marked: 0, alreadyPresent: 0, notWorking: 0, manuallyCorrected: 0,
    skippedRotating: 0,
    skippedNotEmployed: 0,
    details: [],
  };

  for (const emp of employees) {
    const [working, existing] = await Promise.all([
      resolveWorkingDays({ tenantId, employeeId: emp.id, from: first, to: last }),
      prisma.attendance.findMany({
        where: { tenantId, employeeId: emp.id, date: { gte: first, lte: last } },
        select: { id: true, date: true, status: true, manually_corrected: true },
      }),
    ]);
    const byDay = new Map(existing.map((a) => [dayKey(a.date), a]));

    for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) {
      const day = new Date(t);
      const key = dayKey(day);

      // Guard 6: not employed on this day (terminated / not yet started /
      // between periods). Charged nothing — the gap is not an absence.
      if (!employedOn(emp.id, day)) { summary.skippedNotEmployed += 1; continue; }

      // Guard 2: only days the employee was scheduled to work.
      const info = working.get(key);
      if (!info?.working) { summary.notWorking += 1; continue; }

      // HR-ATT-PAID-NOPUNCH-01 — a standing paid-without-punches roster
      // (schedule_pattern.paidWithoutPunches, operator request 2026-10-07):
      // scheduled days are paid in full with no punch expected, so the marker
      // writes a credited PRESENT instead of an absence.
      const paidNoPunch = info.reason === "PAID_NO_PUNCH";

      // Guard 4 (HR-ATT-ROTATING-02): a rotating roster rests on the rotation,
      // not on a weekday, so its `offDays` is empty and guard 2 waves every
      // calendar day through. The rotation has no anchor date on file, so a day
      // with no punch cannot be told apart from a rest day — and of the two
      // readings only "absent" takes money off somebody. Their genuine
      // absences still arrive through the leave and anomaly paths.
      if (info.rotating) { summary.skippedRotating += 1; continue; }

      // Guard 3: never overwrite an existing or hand-corrected day.
      const row = byDay.get(key);
      if (row?.manually_corrected) { summary.manuallyCorrected += 1; continue; }
      if (row) {
        // HR-ATT-ONCALL-01 / HR-ATT-ROSTER-CORRECTION-01 — a rostered-off row
        // (WEEKLY_OFF / HOLIDAY) sitting on a day the resolver NOW calls
        // working is not an answer, it is stale: the day became a working day
        // after the row was written (a weekend call-in, or a roster correction
        // that moved the rest day off this date). Restate it to ABSENT so the
        // day is charged. Any other existing row (a punch that already scored,
        // a leave day) still wins — guard 3 stands.
        const staleOffRow = row.status === "WEEKLY_OFF" || row.status === "HOLIDAY";
        // On a paid-without-punches roster an automatic ABSENT from an earlier
        // run of this same marker is not an HR ruling — restate it to a paid
        // PRESENT, exactly as the stale off-row below restates to ABSENT.
        // Manually corrected rows still win (guard 3 stands).
        if (!staleOffRow && !(paidNoPunch && row.status === "ABSENT")) {
          summary.alreadyPresent += 1;
          continue;
        }

        summary.marked += 1;
        summary.details.push({ employeeId: emp.id, employee_code: emp.employee_code, date: key });
        if (!dryRun) {
          await tenantTransaction(prisma, async (tx) =>
            tx.attendance.update({
              where: { id: row.id },
              data: paidNoPunch
                ? {
                    status: "PRESENT",
                    day_credit: 1,
                    check_in: null,
                    check_out: null,
                    requires_regularization: false,
                    remarks: "Full-time on-call (roster flag): paid day, no punch recorded",
                  }
                : {
                    status: "ABSENT",
                    day_credit: 0,
                    check_in: null,
                    check_out: null,
                    requires_regularization: true,
                    remarks: info.reason === "ON_CALL"
                      ? "Called in (on-call) with no attendance recorded"
                      : "No attendance recorded on a scheduled working day",
                  },
            }),
          );
        }
        continue;
      }

      summary.marked += 1;
      summary.details.push({ employeeId: emp.id, employee_code: emp.employee_code, date: key });

      if (!dryRun) {
        await tenantTransaction(prisma, async (tx) =>
          tx.attendance.create({
            data: paidNoPunch
              ? {
                  tenantId, employeeId: emp.id, date: day,
                  status: "PRESENT", day_credit: 1,
                  requires_regularization: false,
                  remarks: "Full-time on-call (roster flag): paid day, no punch recorded",
                }
              : {
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
