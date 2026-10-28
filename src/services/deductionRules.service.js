// The anomaly-deduction rules payroll prices with, and the copy of them kept with
// every payroll run.
//
//   • loadDeductionRules      the tenant's CURRENT rules (policy row, defaults for
//                             anything unset: today's behaviour).
//   • snapshotDeductionRules  written once per processed run, so what priced a
//                             payslip can be audited later.
//   • rulesForRun             the rules a run was PRICED with: its snapshot when it
//                             has one, the live rules for a run that predates the
//                             snapshot. A later change of rules never re-prices a
//                             payslip that was already priced.
import prisma from "../lib/prisma.js";
import { deductionRulesFromPolicy } from "../lib/attendanceAnomalyRules.js";

export const RULES_SNAPSHOT_ACTION = "ATTENDANCE_DEDUCTION_RULES_USED";

export async function loadDeductionRules(tenantId, db = prisma) {
  const row = await db.attendancePolicyConfig.findUnique({ where: { tenantId } });
  return deductionRulesFromPolicy(row ?? {});
}

export async function snapshotDeductionRules(db, { tenantId, runId, rules, actorId = null }) {
  const last = await db.payrollAuditLog.findFirst({
    where: { tenantId, payrollRunId: runId, action: RULES_SNAPSHOT_ACTION },
    orderBy: { id: "desc" },
  });
  // Re-processing with unchanged rules does not stack identical rows.
  if (last && JSON.stringify(last.newValues?.rules) === JSON.stringify(rules)) return last;
  return db.payrollAuditLog.create({
    data: {
      tenantId,
      payrollRunId: runId,
      action: RULES_SNAPSHOT_ACTION,
      details: "Attendance deduction rules this payroll run was priced with",
      newValues: { rules },
      ...(actorId != null ? { employeeId: Number(actorId) || undefined } : {}),
    },
  });
}

export async function rulesForRun(db, { tenantId, runId }) {
  const snap = await db.payrollAuditLog.findFirst({
    where: { tenantId, payrollRunId: runId, action: RULES_SNAPSHOT_ACTION },
    orderBy: { id: "desc" },
  });
  return snap?.newValues?.rules
    ? { ...deductionRulesFromPolicy({}), ...snap.newValues.rules }
    : loadDeductionRules(tenantId, db);
}
