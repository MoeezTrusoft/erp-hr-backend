// scripts/payroll-dryrun.mjs — a full payroll, computed and thrown away.
//
// Assembles exactly what processPayrollRun assembles and runs the SAME engine,
// but persists nothing. The point is to see the money before committing to it:
// real gross, real FBR tax, real attendance deductions from the rules that are
// live right now.
//
// READ-ONLY. It creates no payroll run, no payslip, no deduction type.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { buildPayslipFromInputs } from "../src/services/payrollService.js";
import { countViolationDays, computeAttendanceDeductions } from "../src/lib/attendanceDeduction.js";

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-08-31T23:59:59.999Z");
const VERBOSE = process.argv.includes("--verbose");

const n = (v) => Number(v || 0);
const fmt = (v) => n(v).toLocaleString("en-PK", { maximumFractionDigits: 0 }).padStart(11);
const name = (e) => e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code;

const grand = { people: 0, gross: 0, tax: 0, attendance: 0, lwp: 0, net: 0, penalised: 0 };

async function main() {
  console.log(`AUGUST 2026 PAYROLL — DRY RUN (nothing written)\n`);

  for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const rules = await prisma.attendanceDeductionRule.findMany({
        where: { tenantId, enabled: true },
        orderBy: { ruleKey: "asc" },
      });
      const ruleConfig = (await prisma.payrollRuleConfig.findUnique({ where: { tenantId } })) ?? {};
      const taxRateRows = await prisma.taxRate.findMany({ where: { tenantId, countryCode: "PK" } });

      const terms = await prisma.employmentTerms.findMany({ where: { tenantId } });
      const tot = { people: 0, gross: 0, tax: 0, attendance: 0, lwp: 0, net: 0, penalised: 0 };

      const lines = [];
      for (const term of terms) {
        const emp = await prisma.employee.findUnique({
          where: { id: term.employeeId },
          select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
        });
        if (!emp) continue;

        const assignments = await prisma.payrollAssignment.findMany({
          where: {
            employeeId: emp.id,
            isActive: true,
            effectiveFrom: { lte: periodEnd },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }],
          },
          include: { earningType: true, deductionType: true },
        });

        const attendance = await prisma.attendance.findMany({
          where: { employeeId: emp.id, date: { gte: periodStart, lte: periodEnd } },
          select: { date: true, status: true, manually_corrected: true },
        });
        const anomalies = await prisma.attendanceAnomaly.findMany({
          where: { employeeId: emp.id, date: { gte: periodStart, lte: periodEnd } },
          select: { date: true, status: true, type: true },
        });

        const attendanceDeductionLines = rules.length
          ? computeAttendanceDeductions({
              violations: countViolationDays({ attendance, anomalies }),
              rules,
            })
          : [];

        const slip = buildPayslipFromInputs({
          employee: emp,
          employmentTerm: term,
          assignments,
          payrollRun: { periodStart, periodEnd, countryCode: "PK", currencyCode: "PKR" },
          taxRateRows,
          asOf: periodEnd,
          bridges: { attendanceDeductionLines },
          ruleConfig,
        });

        const find = (pred) => slip.deductions.filter(pred).reduce((s, d) => s + n(d.amount), 0);
        const tax = find((d) => d.description === "Income Tax");
        const att = find((d) => String(d.description).startsWith("Attendance:"));
        const lwp = find((d) => String(d.description).startsWith("LWP"));
        const days = attendanceDeductionLines.reduce((s, l) => s + l.days, 0);

        tot.people++;
        tot.gross += n(slip.grossAmount);
        tot.tax += tax;
        tot.attendance += att;
        tot.lwp += lwp;
        tot.net += n(slip.netAmount);
        if (att > 0) tot.penalised++;

        lines.push(
          `  ${emp.employee_code.padEnd(7)} ${name(emp).slice(0, 24).padEnd(24)}` +
            `${fmt(slip.grossAmount)}${fmt(tax)}${fmt(att)}${days ? ` (${days}d)` : "     "}${fmt(slip.netAmount)}`,
        );
      }

      console.log(`=== ${tenantName} ${"=".repeat(58 - tenantName.length)}`);
      console.log(
        `  ${"code".padEnd(7)} ${"employee".padEnd(24)}${"gross".padStart(11)}${"tax".padStart(11)}${"attend".padStart(11)}     ${"net".padStart(11)}`,
      );
      if (VERBOSE) lines.forEach((l) => console.log(l));
      console.log(
        `  ${String(tot.people).padStart(3)} people${" ".repeat(22)}${fmt(tot.gross)}${fmt(tot.tax)}${fmt(tot.attendance)}     ${fmt(tot.net)}`,
      );
      console.log(`  ${tot.penalised} with an attendance deduction\n`);

      for (const k of Object.keys(grand)) grand[k] += tot[k];
    });
  }

  console.log(`${"=".repeat(64)}`);
  console.log(`GRAND TOTAL — ${grand.people} employees`);
  console.log(`  gross                 ${fmt(grand.gross)}`);
  console.log(`  income tax            ${fmt(grand.tax)}`);
  console.log(`  attendance deductions ${fmt(grand.attendance)}   (${grand.penalised} employees affected)`);
  console.log(`  unpaid leave          ${fmt(grand.lwp)}`);
  console.log(`  NET PAYABLE           ${fmt(grand.net)}`);
  console.log(`\nNothing was written.`);
}

try {
  await main();
} finally {
  await prisma.$disconnect().catch(() => {});
}
process.exit(0);
