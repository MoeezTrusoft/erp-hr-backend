// scripts/backfill-employment-periods.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-01
//
// One open-ended employment period per employee, from their hire date.
//
// The migration tried to do this and inserted NOTHING. `Employee` carries FORCE
// ROW LEVEL SECURITY, and `prisma migrate deploy` runs with neither
// app.tenant_id nor app.tenant_bypass set, so its `INSERT ... SELECT FROM
// "Employee"` selected zero rows — and inserting zero rows is not an error, so
// the migration reported success. 71 of 75 employees were left with no history.
//
// Doing it from the application instead, under SYSTEM context, sets the bypass
// GUC and the read works. A migration cannot be trusted to read an RLS table.
//
// This matters beyond tidiness: payrollService selects employees on
// `status: 'active'` OR an overlapping employment period, and 73 of 75 rows
// spell it "Active" with a capital A. Postgres equality is case-sensitive, so
// the status arm currently matches ONE employee. Until that is fixed properly,
// these periods are what puts the other 74 back in the payroll run.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");

await mcpCtx.run({ system: true }, async () => {
  const employees = await prisma.employee.findMany({
    where: { employmentPeriods: { none: {} } },
    select: {
      id: true, employee_code: true, employee_name: true, tenant_id: true,
      hire_date: true, joining_date: true, status: true,
    },
    orderBy: { employee_code: "asc" },
  });

  console.log(`employees with no employment period: ${employees.length}`);

  let created = 0;
  let skipped = 0;
  for (const e of employees) {
    const anchor = e.hire_date || e.joining_date;
    if (!anchor) {
      // Left with no row on purpose: proration treats "no periods" as a full
      // month, which is exactly today's behaviour for them. Inventing a start
      // date would be worse than leaving it absent.
      console.log(
        `  ~ ${String(e.employee_code).padEnd(8)} ` +
          `${String(e.employee_name).slice(0, 22).padEnd(22)} no hire_date or joining_date — skipped`,
      );
      skipped += 1;
      continue;
    }
    if (WRITE) {
      await prisma.employmentPeriod.create({
        data: {
          tenantId: e.tenant_id,
          employeeId: e.id,
          startDate: anchor,
          endDate: null,
          reason: "Backfilled from hire_date (HR-PAYROLL-EMPLOYMENT-PERIOD-01)",
        },
      });
    }
    created += 1;
  }

  console.log(`\n${WRITE ? "created" : "would create"} ${created}   skipped ${skipped}`);

  if (WRITE) {
    const total = await prisma.employmentPeriod.count();
    const remaining = await prisma.employee.count({
      where: { employmentPeriods: { none: {} } },
    });
    console.log(`employment_periods rows now: ${total}   employees still without one: ${remaining}`);
  }
});

if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
