// scripts/import-employment-terms.mjs — HR-PAYROLL-SALARY-IMPORT-01
//
// Loads each employee's monthly package from the HR workbook. Until this runs
// there is no salary figure anywhere in the system, so every payslip computes a
// gross of zero and every attendance deduction is worth nothing.
//
// Operator's structure, applied to the "Total Monthly Salary" column:
//   basic 45%, house 20%, transport 15%, medical 12.5%, utilities 7.5%
//
// Basic goes to EmploymentTerms.baseSalary; the four allowances become
// PayrollEarningType + a per-employee PayrollAssignment carrying a FLAT amount.
// Flat, not rate: buildPayslipFromInputs applies a `rate` to gross-so-far, so
// 20% would compound off the running total instead of the full package.
//
// MUST run inside the pod: EmploymentTerms.baseSalary is C4-encrypted at rest by
// a Prisma client extension. Writing it as raw SQL would store plaintext where
// every reader expects an AES-256-GCM envelope.
//
// Dry run unless --write. Idempotent: an employee who already has terms is
// skipped rather than duplicated.
import { readFileSync } from "node:fs";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");
const SRC = process.argv.find((a) => a.endsWith(".json")) || "/tmp/salaries.json";

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

// Percentages of the TOTAL monthly package. Must sum to 100.
const BASIC_PCT = 45;
const ALLOWANCES = [
  { code: "HOUSE_ALLOWANCE", name: "House Allowance", pct: 20 },
  { code: "TRANSPORT_ALLOWANCE", name: "Transport Allowance", pct: 15 },
  { code: "MEDICAL_ALLOWANCE", name: "Medical Allowance", pct: 12.5 },
  { code: "UTILITIES_ALLOWANCE", name: "Utilities Allowance", pct: 7.5 },
];

const total = BASIC_PCT + ALLOWANCES.reduce((s, a) => s + a.pct, 0);
if (total !== 100) throw new Error(`split must sum to 100, got ${total}`);

// Names differ between the workbook and the ERP by spacing, middle names and
// spelling (Asghar/Ashghar). Compare on significant words only, and never fuzzy
// match across tenants — this decides someone's pay.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["mohammad", "muhammad", "syed", "mr", "ms"].includes(w));

const displayName = (e) =>
  e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code;

async function main() {
  const rows = JSON.parse(readFileSync(SRC, "utf8"));
  console.log(`${rows.length} salary rows from ${SRC}${WRITE ? "" : "   (DRY RUN)"}\n`);

  const summary = { matched: 0, unmatched: [], skipped: 0, written: 0, payroll: 0 };

  for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
    const mine = rows.filter((r) => r.tenant === tenantName);
    if (!mine.length) continue;

    await mcpCtx.run({ user: { tenantId } }, async () => {
      const employees = await prisma.employee.findMany({
        select: {
          id: true,
          employee_code: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          biometric_id: true,
        },
      });
      const byBio = new Map(employees.filter((e) => e.biometric_id).map((e) => [String(e.biometric_id), e]));

      // Earning types are per tenant and reused by every assignment below.
      const typeIds = {};
      for (const a of ALLOWANCES) {
        const existing = await prisma.payrollEarningType.findFirst({ where: { tenantId, code: a.code } });
        if (existing) typeIds[a.code] = existing.id;
        else if (WRITE) {
          const created = await prisma.payrollEarningType.create({
            data: { tenantId, code: a.code, name: a.name, isTaxable: true },
          });
          typeIds[a.code] = created.id;
        }
      }

      console.log(`── ${tenantName} ─────────────────────────────`);
      for (const row of mine) {
        let emp = row.biometricId ? byBio.get(String(row.biometricId)) : null;
        if (!emp) {
          const want = new Set(norm(row.name));
          const scored = employees
            .map((e) => ({ e, hits: norm(displayName(e)).filter((w) => want.has(w)).length }))
            .filter((x) => x.hits > 0)
            .sort((a, b) => b.hits - a.hits);
          // Require a clear winner; a tie means we cannot tell two people apart.
          if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) emp = scored[0].e;
        }

        if (!emp) {
          summary.unmatched.push(`${tenantName}: ${row.name} (PKR ${row.total.toLocaleString()})`);
          continue;
        }
        summary.matched++;

        const already = await prisma.employmentTerms.findFirst({ where: { tenantId, employeeId: emp.id } });
        if (already) {
          summary.skipped++;
          console.log(`  = ${emp.employee_code.padEnd(8)} ${displayName(emp).padEnd(26)} already has terms`);
          continue;
        }

        const basic = Math.round((row.total * BASIC_PCT) / 100);
        summary.payroll += row.total;
        console.log(
          `  + ${emp.employee_code.padEnd(8)} ${displayName(emp).padEnd(26)} ` +
            `total ${String(row.total).padStart(8)}  basic ${String(basic).padStart(7)}` +
            `${row.biometricId ? "" : "   [name-matched]"}`,
        );

        if (!WRITE) continue;

        await prisma.employmentTerms.create({
          data: {
            tenantId,
            employeeId: emp.id,
            baseSalary: String(basic),
            currency: "PKR",
            payFrequency: "MONTHLY",
            effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
          },
        });
        for (const a of ALLOWANCES) {
          await prisma.payrollAssignment.create({
            data: {
              tenantId,
              employeeId: emp.id,
              earningTypeId: typeIds[a.code],
              amount: Math.round((row.total * a.pct) / 100),
              effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
              isActive: true,
            },
          });
        }
        summary.written++;
      }
    });
  }

  console.log(`\nmatched ${summary.matched}   skipped(existing) ${summary.skipped}   written ${summary.written}`);
  console.log(`monthly payroll covered: PKR ${summary.payroll.toLocaleString()}`);
  if (summary.unmatched.length) {
    console.log(`\nUNMATCHED — these people get NO salary and must be resolved by hand:`);
    summary.unmatched.forEach((u) => console.log(`  ! ${u}`));
  }
  if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
}

try {
  await main();
} finally {
  await prisma.$disconnect().catch(() => {});
}
process.exit(0);
