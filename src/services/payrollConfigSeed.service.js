// src/services/payrollConfigSeed.service.js
//
// T-2.8 / B2 (plan 25) — Decision 5: future companies seed from a COPY of the
// Trusoft ruleset, which HR then adjusts BEFORE first publish (doc 22 stays the
// single publish gate). Without this template the next tenant repeats the
// company-6 zero-rulebook story (Role rows existed but no rule config, no rules,
// no type catalog — see the segregation bootstrap, 2026-09-10).
//
// Copies from sourceTenantId → targetTenantId:
//   - the ONE PayrollRuleConfig row (policy toggles, basis, cap, EOBI, flag)
//   - every AttendanceDeductionRule (ruleKey, enabled, N/X, scope, group, cap)
//   - the PayrollEarningType + PayrollDeductionType catalogs
// NEVER copies: calendars, snapshots, payslip-bearing data (guarded below).
//
// Cross-tenant by definition: runs on the raw connection (NOT tenantTransaction)
// and must therefore stay a deliberate, admin-gated maintenance action.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}
function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

// The rule-config column set we copy. Anything not listed materializes from
// defaultRules() on the target — deliberate (defaults are August-identical).
const RULE_CONFIG_KEYS = [
  "midMonthJoinerProration",
  "midMonthExitSettlement",
  "lwpRecovery",
  "complianceHold",
  "garnishmentRecovery",
  "garnishmentCapPct",
  "offCycleRelease",
  "deductionBasis",
  "eobiEnabled",
  "eobiEmployeeRatePct",
  "eobiWageCeilingMinor",
  "absenceRecoveryEnabled",
];

export async function seedConfigFromTenant({
  actorTenantId,
  actorIsAdmin = false,
  sourceTenantId,
  targetTenantId,
}) {
  if (!actorIsAdmin) throw forbidden("only an admin may seed a tenant's payroll config");
  if (!sourceTenantId || !targetTenantId) throw conflict("sourceTenantId and targetTenantId are required");
  if (sourceTenantId === targetTenantId) throw conflict("source and target tenants must differ");

  // HARD GUARD — never seed a tenant that already has payslip-bearing data.
  // Seeding is onboarding-only; a running tenant must be adjusted via the
  // rules/publish flow so its snapshot history stays meaningful.
  const [payslips, runs] = await Promise.all([
    prisma.payrollPayslip.count({ where: { tenantId: targetTenantId } }),
    prisma.payrollRun.count({ where: { tenantId: targetTenantId } }),
  ]);
  if (payslips > 0 || runs > 0) {
    throw conflict(
      `target tenant already has payroll history (${payslips} payslips, ${runs} runs) — adjust it via hr_payroll_rules_update instead`,
    );
  }

  const summary = { sourceTenantId, targetTenantId, ruleConfig: false, deductionRules: 0, earningTypes: 0, deductionTypes: 0 };

  // 1) Rule config row (one per tenant, @@unique([tenantId])).
  const srcConfig = await prisma.payrollRuleConfig.findUnique({ where: { tenantId: sourceTenantId } });
  if (srcConfig) {
    const data = {};
    for (const k of RULE_CONFIG_KEYS) if (srcConfig[k] !== undefined && srcConfig[k] !== null) data[k] = srcConfig[k];
    data.status = "DRAFT"; // seeded config is always DRAFT — publish is the gate
    data.version = 1;
    await prisma.payrollRuleConfig.upsert({
      where: { tenantId: targetTenantId },
      update: data,
      create: { ...data, tenantId: targetTenantId },
    });
    summary.ruleConfig = true;
  }

  // 2) Attendance deduction rules (@@unique([tenantId, ruleKey])).
  const srcRules = await prisma.attendanceDeductionRule.findMany({ where: { tenantId: sourceTenantId } });
  for (const r of srcRules) {
    const data = {
      ruleKey: r.ruleKey,
      enabled: r.enabled,
      triggerCount: r.triggerCount,
      deductionDays: r.deductionDays,
      periodScope: r.periodScope,
      counterGroup: r.counterGroup,
      maxDeductionDaysPerPeriod: r.maxDeductionDaysPerPeriod,
      status: "DRAFT",
      version: 1,
    };
    await prisma.attendanceDeductionRule.upsert({
      where: { tenantId_ruleKey: { tenantId: targetTenantId, ruleKey: r.ruleKey } },
      update: data,
      create: { ...data, tenantId: targetTenantId },
    });
    summary.deductionRules += 1;
  }

  // 3) Type catalogs (@@unique([tenantId, code]); skipDuplicates keeps re-runs
  //    idempotent if a prior seed partially landed).
  const srcEarnings = await prisma.payrollEarningType.findMany({ where: { tenantId: sourceTenantId } });
  if (srcEarnings.length > 0) {
    const res = await prisma.payrollEarningType.createMany({
      data: srcEarnings.map((t) => ({
        tenantId: targetTenantId,
        code: t.code,
        name: t.name,
        description: t.description,
        type: t.type,
        isTaxable: t.isTaxable,
      })),
      skipDuplicates: true,
    });
    summary.earningTypes = res.count;
  }

  const srcDeductions = await prisma.payrollDeductionType.findMany({ where: { tenantId: sourceTenantId } });
  if (srcDeductions.length > 0) {
    const res = await prisma.payrollDeductionType.createMany({
      data: srcDeductions.map((t) => ({
        tenantId: targetTenantId,
        code: t.code,
        name: t.name,
        description: t.description,
        type: t.type,
        rate: t.rate,
        preTax: t.preTax,
      })),
      skipDuplicates: true,
    });
    summary.deductionTypes = res.count;
  }

  logger.info({ actorTenantId, sourceTenantId, targetTenantId, ...summary }, "payroll config seeded from tenant");
  return summary;
}
