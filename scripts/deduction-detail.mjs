// scripts/deduction-detail.mjs — WHY each person is being deducted.
//
// The dry run gives totals; this gives the evidence behind them. For every
// employee with an attendance deduction it emits the rule that fired, how many
// occurrences it counted, the exact dates of those occurrences, the days
// charged and the money — plus the days an approved anomaly excused, so it is
// visible that the appeal was honoured.
//
// READ-ONLY. Emits JSON on stdout for downstream formatting.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
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
const DAYS_IN_PERIOD = 31;

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const nameOf = (e) =>
  e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code;

const out = [];

for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
  await mcpCtx.run({ user: { tenantId } }, async () => {
    const rules = await prisma.attendanceDeductionRule.findMany({
      where: { tenantId, enabled: true },
      orderBy: { ruleKey: "asc" },
    });
    if (!rules.length) return;
    const cfg = (await prisma.payrollRuleConfig.findUnique({ where: { tenantId } })) ?? {};
    const basis = cfg.deductionBasis === "BASIC" ? "BASIC" : "GROSS";

    const terms = await prisma.employmentTerms.findMany({ where: { tenantId } });
    for (const term of terms) {
      const emp = await prisma.employee.findUnique({
        where: { id: term.employeeId },
        select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
      });
      if (!emp) continue;

      const attendance = await prisma.attendance.findMany({
        where: { employeeId: emp.id, date: { gte: periodStart, lte: periodEnd } },
        select: { date: true, status: true, manually_corrected: true },
      });
      const anomalies = await prisma.attendanceAnomaly.findMany({
        where: { employeeId: emp.id, date: { gte: periodStart, lte: periodEnd } },
        select: { date: true, status: true, type: true },
      });

      const violations = countViolationDays({ attendance, anomalies });
      const lines = computeAttendanceDeductions({ violations, rules });
      if (!lines.length) continue;

      // Money basis: base salary, plus allowances when the tenant deducts on GROSS.
      const assignments = await prisma.payrollAssignment.findMany({
        where: { employeeId: emp.id, isActive: true, earningTypeId: { not: null } },
        select: { amount: true },
      });
      const base = Number(term.baseSalary || 0);
      const packageTotal =
        basis === "BASIC" ? base : base + assignments.reduce((s, a) => s + Number(a.amount || 0), 0);
      const perDay = packageTotal / DAYS_IN_PERIOD;

      const excused = anomalies.filter((a) => a.status === "APPROVED").map((a) => iso(a.date));
      const corrected = attendance.filter((a) => a.manually_corrected).map((a) => iso(a.date));

      out.push({
        tenant: tenantName,
        code: emp.employee_code,
        name: nameOf(emp),
        packageTotal,
        perDay: Math.round(perDay * 100) / 100,
        totalDays: lines.reduce((s, l) => s + l.days, 0),
        totalAmount: Math.round(lines.reduce((s, l) => s + l.days, 0) * perDay * 100) / 100,
        excusedByAppeal: excused,
        hrCorrected: corrected,
        lines: lines.map((l) => {
          const rule = rules.find((r) => r.ruleKey === l.ruleKey);
          const group = l.counterGroup;
          const dates = violations
            .filter((v) =>
              group
                ? rules.some((r) => r.counterGroup === group && r.ruleKey === v.ruleKey)
                : v.ruleKey === l.ruleKey,
            )
            .map((v) => v.day)
            .sort();
          return {
            rule: group || l.ruleKey,
            occurrences: l.occurrences,
            threshold: `${rule?.triggerCount} occurrence(s) = ${rule?.deductionDays} day(s)`,
            days: l.days,
            amount: Math.round(l.days * perDay * 100) / 100,
            dates,
          };
        }),
      });
    }
  });
}

console.log("JSON_START");
console.log(JSON.stringify(out));
process.exit(0);
