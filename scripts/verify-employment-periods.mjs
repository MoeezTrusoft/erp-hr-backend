// scripts/verify-employment-periods.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-01 (read-only)
//
// What the periods actually say, and what August and September would pay.
//
// Written because the apply run reported `periods=0` for all four staffing
// changes: the migration's backfill only creates a period for employees with a
// hire_date, so anyone missing one starts with no history. For a re-hire that
// matters — a lone "from 2026-09-07" row means August overlaps nothing and pays
// ZERO rather than 19/31.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { computeProrationFactor } from "../src/services/payrollService.js";

const NAMES = ["meesam", "affan", "afzal", "shizza"];
const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "null");
const pctOf = (f) => `${(Number(f) / 10_000).toFixed(1)}%`;

await mcpCtx.run({ system: true }, async () => {
  const total = await prisma.employmentPeriod.count();
  const employees = await prisma.employee.count();
  console.log(`employment_periods rows: ${total}   employees: ${employees}`);
  const noPeriod = await prisma.employee.count({
    where: { employmentPeriods: { none: {} } },
  });
  console.log(`employees with NO period: ${noPeriod}\n`);

  for (const [tenant, tenantId] of Object.entries(TENANTS)) {
    const emps = await prisma.employee.findMany({
      where: { tenant_id: tenantId },
      select: {
        id: true, employee_code: true, employee_name: true, status: true,
        hire_date: true, joining_date: true,
        employmentPeriods: {
          select: { startDate: true, endDate: true, reason: true },
          orderBy: { startDate: "asc" },
        },
      },
    });
    for (const e of emps) {
      if (!NAMES.some((n) => norm(e.employee_name).includes(n))) continue;
      console.log(
        `${tenant} ${e.employee_code} ${e.employee_name}  status=${e.status}  ` +
          `hire_date=${iso(e.hire_date)} joining=${iso(e.joining_date)}`,
      );
      if (!e.employmentPeriods.length) console.log("   (no periods)");
      for (const p of e.employmentPeriods) {
        console.log(`   ${iso(p.startDate)} -> ${iso(p.endDate)}   ${p.reason ?? ""}`);
      }
      const aug = computeProrationFactor("2026-08-01", "2026-08-31", e.employmentPeriods);
      const sep = computeProrationFactor("2026-09-01", "2026-09-30", e.employmentPeriods);
      console.log(`   August pays ${pctOf(aug)}   September pays ${pctOf(sep)}\n`);
    }
  }
});

await prisma.$disconnect().catch(() => {});
