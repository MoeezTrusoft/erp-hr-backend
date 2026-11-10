// Reimbursement claims paid through payroll. An approved claim becomes a non-taxable reimbursement line on the
// employee's next payslip. Calculating the payslip reserves the claim for that run; finalising the run pays it.
// A reservation by a cancelled or failed run no longer holds the claim, so recalculating or cancelling never loses one.
const conflict = (message) => Object.assign(new Error(`HR-4304: ${message}`), { status: 409, code: 'HR-4304' });

/** Runs that can still pay a claim: anything not failed or cancelled. */
async function holdingRunIds(db, tenantId) {
  const runs = await db.payrollRun.findMany({ where: { tenantId, status: { notIn: ['FAILED', 'CANCELLED'] } }, select: { id: true } });
  return runs.map((r) => r.id);
}

/**
 * Reserve the claims this payslip pays: approved, in the run's currency, not paid, and not held by another live run.
 * Claims this run held for the employee before are released first, so recalculating gives the same answer.
 * Returns the reimbursement lines for the payslip.
 */
export async function reserveClaimsForPayslip(db, { tenantId, runId, payslipId, employeeId, currency }) {
  await db.reimbursementClaim.updateMany({
    where: { tenantId, employeeId, payrollRunId: runId, status: 'APPROVED' },
    data: { payrollRunId: null, payslipId: null },
  });
  const live = (await holdingRunIds(db, tenantId)).filter((id) => id !== runId);
  const eligible = await db.reimbursementClaim.findMany({
    where: {
      tenantId, employeeId, status: 'APPROVED', currency,
      OR: [{ payrollRunId: null }, { payrollRunId: { notIn: live } }],
    },
    orderBy: { id: 'asc' },
    select: { id: true, title: true, amount: true },
  });
  if (!eligible.length) return [];
  const taken = await db.reimbursementClaim.updateMany({
    where: { id: { in: eligible.map((c) => c.id) }, tenantId, status: 'APPROVED', OR: [{ payrollRunId: null }, { payrollRunId: { notIn: live } }] },
    data: { payrollRunId: runId, payslipId: payslipId ?? null },
  });
  if (taken.count !== eligible.length) throw conflict('A claim was taken by another payroll run while this one was calculating; calculate again');
  return eligible.map((c) => ({ claimId: c.id, title: c.title, amount: String(c.amount) }));
}

/** The claims a payslip would pay, without reserving anything (a preview). */
export async function previewClaimsForPayslip(db, { tenantId, runId, employeeId, currency }) {
  const live = (await holdingRunIds(db, tenantId)).filter((id) => id !== runId);
  const rows = await db.reimbursementClaim.findMany({
    where: { tenantId, employeeId, status: 'APPROVED', currency, OR: [{ payrollRunId: null }, { payrollRunId: runId }, { payrollRunId: { notIn: live } }] },
    orderBy: { id: 'asc' },
    select: { id: true, title: true, amount: true },
  });
  return rows.map((c) => ({ claimId: c.id, title: c.title, amount: String(c.amount) }));
}

/** Tie the reservation to the payslip once it exists. */
export async function attachClaimsToPayslip(db, { tenantId, runId, employeeId, payslipId }) {
  await db.reimbursementClaim.updateMany({ where: { tenantId, employeeId, payrollRunId: runId, status: 'APPROVED' }, data: { payslipId } });
}

/** Finalising the run pays the claims it reserved. */
export async function settlePayrollClaims(db, { tenantId, runId }) {
  const rows = await db.reimbursementClaim.findMany({ where: { tenantId, payrollRunId: runId, status: 'APPROVED' }, select: { id: true } });
  if (!rows.length) return 0;
  const paid = await db.reimbursementClaim.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, tenantId, status: 'APPROVED', payrollRunId: runId },
    data: { status: 'PAID', paidAt: new Date() },
  });
  if (paid.count !== rows.length) throw conflict('A claim changed while the run was being finalised; review the claims register');
  return paid.count;
}

/** True while a payslip still holds approved claims (it cannot be removed as an empty leftover). */
export const payslipHoldsClaims = (db, tenantId, payslipId) => db.reimbursementClaim.count({ where: { tenantId, payslipId } });
