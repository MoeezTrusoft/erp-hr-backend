// scripts/seed-payroll-calendar.mjs — HR-PAYROLL-CALENDAR-01
//
// Operator spec, 2026-09-03:
//   period      1st -> last day of the month
//   pay date    10th of the FOLLOWING month; if the 10th is a weekend or
//               holiday, pay on the last WORKING DAY BEFORE it (backwards, not
//               forwards). August 2026 -> 10 Sep 2026, a Thursday, so it stands.
//   week        Mon-Fri everywhere. Sat/Sun are never pay days, even for
//               employees who hold shifts on those days.
//   attendance  locks at the end of the last day's shift, then two working days
//               to resolve anomalies (August -> end of 2 Sep).
//   approvals   one further day (August -> end of 3 Sep).
//
// WHAT THIS SEED CAN AND CANNOT DO
//
// PayrollCalendar stores DATES, and CalendarAnchor offers only FIXED_DATE,
// FIRST_OF_MONTH and LAST_OF_MONTH. There is no "Nth of the following month"
// anchor, so the pay date is written as an explicit FIXED_DATE for THIS cycle
// and must be re-set each month until the model gains one.
//
// payDateWeekendShift is a bare boolean with no direction, so it cannot express
// "shift backwards". The backward shift is applied here, in this script, when
// computing the date. Nothing enforces it at runtime.
//
// Two rules have no field at all and are NOT represented:
//   * Sat/Sun never being pay days (implied by the computed date, not stored)
//   * per-employee deferral when someone is on leave/absent on pay day — the
//     model holds ONE payDate per tenant, not one per employee.
//
// And the largest caveat: processPayrollRun never reads this table. It takes
// periodStart/periodEnd from its caller. This calendar is configuration that
// Payroll Setup displays; it does not yet drive a run.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

/** 10th of the month AFTER `period`, walked BACK off Sat/Sun. */
function payDateFor(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex + 1, 10, 0, 0, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** End of the N-th WORKING day after the last day of the month. */
function workingDaysAfterMonthEnd(year, monthIndex, n) {
  const d = new Date(Date.UTC(year, monthIndex + 1, 1, 23, 59, 0));
  let counted = 0;
  for (;;) {
    const weekday = d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
    if (weekday) counted += 1;
    if (weekday && counted === n) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// The cycle being configured: August 2026.
const YEAR = 2026;
const MONTH = 7; // 0-based August

const payDate = payDateFor(YEAR, MONTH);
const attendanceCutoff = workingDaysAfterMonthEnd(YEAR, MONTH, 2); // anomalies resolved by here
const approvalsClose = workingDaysAfterMonthEnd(YEAR, MONTH, 3);

const dow = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];

async function main() {
  console.log(`Payroll calendar for ${YEAR}-${String(MONTH + 1).padStart(2, "0")}${WRITE ? "" : "   (DRY RUN)"}`);
  console.log(`  period            1st -> last of month`);
  console.log(`  attendance cutoff ${attendanceCutoff.toISOString().slice(0, 16)}  ${dow(attendanceCutoff)}`);
  console.log(`  approvals close   ${approvalsClose.toISOString().slice(0, 16)}  ${dow(approvalsClose)}`);
  console.log(`  pay date          ${payDate.toISOString().slice(0, 10)}        ${dow(payDate)}\n`);

  for (const [name, tenantId] of Object.entries(TENANTS)) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const data = {
        payFrequency: "MONTHLY",
        periodStartAnchor: "FIRST_OF_MONTH",
        periodEndAnchor: "LAST_OF_MONTH",
        attendanceCutoff,
        approvalsClose,
        payDateAnchor: "FIXED_DATE",
        payDate,
        // Direction is not expressible; the backward shift was applied above.
        payDateWeekendShift: true,
      };
      const existing = await prisma.payrollCalendar.findUnique({ where: { tenantId } });
      if (WRITE) {
        await prisma.payrollCalendar.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
      }
      console.log(`  ${name.padEnd(8)} ${WRITE ? "written" : existing ? "would update" : "would create"}`);
    });
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
}

try {
  await main();
} finally {
  await prisma.$disconnect().catch(() => {});
}
process.exit(0);
