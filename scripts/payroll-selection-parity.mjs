// scripts/payroll-selection-parity.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-02 (read-only)
//
// Do the two payroll paths agree on WHO gets paid?
//
// The dry-run drives off employmentTerms; processPayrollRun drives off its own
// employee query (status case-insensitive, OR an employment period overlapping
// the run). The two must select the same people, or the rehearsal is not a
// rehearsal. This matters more than usual right now: until today that query
// matched `status: 'active'` exactly, and 73 of 75 rows spell it "Active", so
// the real run selected ONE employee and nobody noticed.
//
// Runs the selection halves only. Nothing is created.
//
// Read-only.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-08-31T23:59:59.999Z");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

let totalReal = 0;
let totalDry = 0;
const problems = [];

for (const [name, tenantId] of Object.entries(TENANTS)) {
  await mcpCtx.run({ user: { tenantId } }, async () => {
    // EXACTLY the predicate processPayrollRun uses.
    const real = await prisma.employee.findMany({
      where: {
        tenant_id: tenantId,
        OR: [
          { status: { equals: "active", mode: "insensitive" } },
          {
            employmentPeriods: {
              some: {
                startDate: { lte: periodEnd },
                OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
              },
            },
          },
        ],
      },
      select: { id: true, employee_code: true, employee_name: true, status: true },
    });

    // What the dry-run sees: anyone holding employment terms.
    const terms = await prisma.employmentTerms.findMany({
      where: { tenantId },
      select: { employeeId: true },
    });
    const dryIds = new Set(terms.map((t) => t.employeeId));
    const realIds = new Set(real.map((e) => e.id));

    const onlyReal = real.filter((e) => !dryIds.has(e.id));
    const onlyDry = [...dryIds].filter((id) => !realIds.has(id));

    totalReal += realIds.size;
    totalDry += dryIds.size;
    console.log(
      `${name.padEnd(8)} real=${String(realIds.size).padStart(3)} dry=${String(dryIds.size).padStart(3)}` +
        `${onlyReal.length || onlyDry.length ? `   DIFFER real-only=${onlyReal.length} dry-only=${onlyDry.length}` : "   match"}`,
    );
    for (const e of onlyReal) {
      console.log(
        `    only in the REAL run: ${e.employee_code} ${e.employee_name} ` +
          `(status=${e.status}) — no employment terms, so no salary`,
      );
      problems.push(`${name}/${e.employee_code} selected but has no terms`);
    }
    if (onlyDry.length) {
      const rows = await prisma.employee.findMany({
        where: { id: { in: onlyDry } },
        select: { employee_code: true, employee_name: true, status: true },
      });
      for (const e of rows) {
        console.log(
          `    only in the DRY run: ${e.employee_code} ${e.employee_name} ` +
            `(status=${e.status}) — has terms but the real run skips them`,
        );
        problems.push(`${name}/${e.employee_code} has terms but is not selected`);
      }
    }
  });
}

console.log(`\nreal-path total ${totalReal}   dry-run total ${totalDry}`);
console.log(problems.length ? `\n${problems.length} discrepancy(ies):` : "\nthe two paths agree on who gets paid.");
problems.forEach((p) => console.log(`  - ${p}`));

await prisma.$disconnect().catch(() => {});
