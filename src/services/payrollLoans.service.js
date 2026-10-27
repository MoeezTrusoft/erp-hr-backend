import * as money from "../lib/money.js";
const conflict = (message) =>
  Object.assign(new Error(`HR-4303: ${message}`), {
    status: 409,
    code: "HR-4303",
  });

export async function assertNoPayrollLoanReservation(db, tenantId, loanId) {
  const activeRuns = await db.payrollRun.findMany({
    where: { tenantId, status: { notIn: ["FAILED", "CANCELLED"] } },
    select: { id: true },
  });
  const reserved = await db.loanRepayment.count({
    where: {
      tenantId,
      loanId,
      settledAt: null,
      payrollRunId: { in: activeRuns.map((r) => r.id) },
    },
  });
  if (reserved)
    throw conflict(
      "This loan is reserved by payroll; complete or cancel that payroll before changing its balance",
    );
}

export async function reservePayrollLoans(
  db,
  { tenantId, runId, payslipId, deductions, currency },
) {
  const existing = await db.loanRepayment.findMany({
    where: { tenantId, payrollRunId: runId, payslipId },
  });
  // Preserve repayments posted by older releases; never silently rewrite debt.
  for (const row of existing.filter((r) => r.settledAt)) {
    const line = deductions.find((d) => d.loanId === row.loanId);
    if (
      !line ||
      money.decimalToMinor(line.amount, currency) !== BigInt(row.amountMinor)
    )
      throw conflict(
        "Posted loan repayment changed; reconcile the historical ledger first",
      );
  }
  await db.loanRepayment.deleteMany({
    where: { tenantId, payrollRunId: runId, payslipId, settledAt: null },
  });
  for (const line of deductions.filter((d) => d.loanId)) {
    if (existing.some((r) => r.loanId === line.loanId && r.settledAt)) continue;
    await db.loanRepayment.create({
      data: {
        tenantId,
        loanId: line.loanId,
        payrollRunId: runId,
        payslipId,
        amountMinor: Number(money.decimalToMinor(line.amount, currency)),
        settledAt: null,
        note: "Reserved; posts only on payroll finalization",
      },
    });
  }
}
export async function settlePayrollLoans(db, { tenantId, runId }) {
  const rows = await db.loanRepayment.findMany({
    where: { tenantId, payrollRunId: runId, settledAt: null },
    orderBy: { loanId: "asc" },
  });
  for (const row of rows) {
    const changed = await db.loan.updateMany({
      where: {
        id: row.loanId,
        tenantId,
        status: "ACTIVE",
        outstandingMinor: { gte: row.amountMinor },
      },
      data: { outstandingMinor: { decrement: row.amountMinor } },
    });
    if (changed.count !== 1)
      throw conflict(
        "Loan balance changed; reconcile the loan ledger before finalization",
      );
    await db.loan.updateMany({
      where: { id: row.loanId, tenantId, outstandingMinor: 0 },
      data: { status: "PAID_OFF" },
    });
    await db.loanRepayment.update({
      where: { id: row.id },
      data: { settledAt: new Date(), note: "Posted on payroll finalization" },
    });
  }
}
