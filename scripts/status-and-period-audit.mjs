// scripts/status-and-period-audit.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-01 (read-only)
//
// Two things the first apply run exposed:
//
//   1. The migration's backfill INSERT ... SELECT FROM "Employee" inserted zero
//      rows. Employee carries FORCE ROW LEVEL SECURITY, and a migration runs
//      with no app.tenant_id and no app.tenant_bypass GUC, so the SELECT saw
//      nothing and reported success. Silent, because INSERT-SELECT of zero rows
//      is not an error.
//
//   2. `status` is not written consistently. payrollService filters on the
//      lowercase literal 'active', so any other spelling is invisible to
//      payroll — and was invisible before this change too.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

await mcpCtx.run({ system: true }, async () => {
  const rows = await prisma.employee.findMany({
    select: {
      employee_code: true, employee_name: true, status: true,
      employement_status: true, tenant_id: true, hire_date: true,
      joining_date: true,
      _count: { select: { employmentPeriods: true } },
    },
  });

  const tally = new Map();
  for (const r of rows) {
    const key = `status=${JSON.stringify(r.status)} employement_status=${JSON.stringify(r.employement_status)}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log("status spellings across all employees:");
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  const payrollVisible = rows.filter((r) => r.status === "active");
  console.log(
    `\nemployees payroll would select on status alone ('active' exactly): ` +
      `${payrollVisible.length} of ${rows.length}`,
  );

  const noAnchor = rows.filter((r) => !r.hire_date && !r.joining_date);
  const noPeriod = rows.filter((r) => r._count.employmentPeriods === 0);
  console.log(`employees with no hire_date and no joining_date: ${noAnchor.length}`);
  console.log(`employees with no employment period: ${noPeriod.length}`);
  console.log(
    `  of those, backfillable from an anchor: ` +
      `${noPeriod.filter((r) => r.hire_date || r.joining_date).length}`,
  );
});

await prisma.$disconnect().catch(() => {});
