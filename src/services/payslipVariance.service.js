// F-01 — record the written explanation for a payslip's month-on-month swing.
// The explanation is an audit row bound to the gross it explained (see
// lib/payslipVariance.js); no schema change, no effect on the approval digest.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { VARIANCE_ACK_ACTION, VARIANCE_THRESHOLD_PCT, cleanReason, unexplainedVariances } from "../lib/payslipVariance.js";

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};

export async function listPayslipVariances({ tenantId, runId }) {
  const run = await prisma.payrollRun.findFirst({ where: { id: Number(runId), tenantId } });
  if (!run) fail("Payroll run not found", 404);
  const list = await unexplainedVariances(prisma, { tenantId, run });
  return { runId: run.id, thresholdPct: VARIANCE_THRESHOLD_PCT, unexplained: list };
}

export async function acknowledgePayslipVariance({ tenantId, runId, employeeId, reason, actorEmployeeId = null }) {
  const text = cleanReason(reason);
  const id = Number(runId),
    emp = Number(employeeId);
  if (!Number.isInteger(id) || !Number.isInteger(emp)) fail("A numeric run id and employee id are required", 400);
  return tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id=${id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id, tenantId } });
      if (!run) fail("Payroll run not found", 404);
      if (run.status !== "COMPLETED") fail(`Explanations are recorded while a run awaits approval (status is ${run.status})`);
      const flagged = await unexplainedVariances(tx, { tenantId, run, onlyEmployeeId: emp, includeAcknowledged: true });
      if (!flagged.length) fail("This payslip has no month-on-month change above the threshold to explain");
      const [v] = flagged;
      await tx.payrollAuditLog.create({
        data: {
          tenantId,
          action: VARIANCE_ACK_ACTION,
          details: `${text} (gross ${v.previous} to ${v.current}, ${v.pct}%${actorEmployeeId != null ? `; by employee ${actorEmployeeId}` : ""})`,
          payrollRunId: id,
          payslipId: v.payslipId,
          employeeId: emp,
          oldValues: { grossAmount: v.previous },
          newValues: { grossAmount: v.current, pct: v.pct },
        },
      });
      return { runId: id, employeeId: emp, previous: v.previous, current: v.current, pct: v.pct, acknowledged: true };
    },
    { tenantId },
  );
}
