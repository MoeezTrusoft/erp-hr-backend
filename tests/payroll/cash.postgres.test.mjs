import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupPayroll, prisma, company, people, db, as, submit, act } from "./fixtures.mjs";
import { processPayrollRun, finalizePayrollRun } from "../../src/services/payrollService.js";
import { markPayslipsCashPaid, payrollPaymentStatus } from "../../src/services/payrollPayments.service.js";
import { createClaim, listClaims } from "../../src/services/claims.service.js";
import { getMyPayslip } from "../../src/services/myPayslip.service.js";

const finalized = async () => {
  const { run } = await setupPayroll();
  await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
  let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
  review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
  review = await act("HR", review, "VERIFY");
  review = await act("MANAGEMENT", review, "APPROVE");
  await as("HR", () => finalizePayrollRun(run.id, people.HR.id, company));
  return run;
};
const setCash = (on) =>
  db(async (tx) => {
    await tx.payrollConfigSnapshot.deleteMany({ where: { tenantId: company } });
    await tx.payrollConfigSnapshot.create({
      data: { tenantId: company, version: 1, config: { payRules: { cashDisbursement: on } } },
    });
    await tx.payrollRun.updateMany({ where: { tenantId: company }, data: { calculationConfigVersion: 1 } });
  });

test("cash companies: HR marks whole payslips paid once, with an audit row and the payslip showing the date", { timeout: 180000 }, async () => {
  const run = await finalized();
  const code = people.EMPLOYEE.employee_code;
  const input = {
    tenantId: company,
    runId: run.id,
    employeeCodes: [code],
    actorCode: people.HR.employee_code,
    paidOn: "2026-10-01T10:00:00Z",
    receiptNumber: "R-17",
    requestKey: randomUUID(),
  };
  await setCash(false);
  await assert.rejects(as("HR", () => markPayslipsCashPaid(input)), /pays by bank/);
  await setCash(true);
  await assert.rejects(as("HR", () => markPayslipsCashPaid({ ...input, paidOn: "2999-01-01T00:00:00Z" })), /future/);
  await assert.rejects(as("HR", () => markPayslipsCashPaid({ ...input, employeeCodes: ["NOPE-1"] })), /Not in this payroll/);
  assert.deepEqual(await as("HR", () => markPayslipsCashPaid(input)), { paid: 1, alreadyRecorded: false });
  // The same request again is a no-op; a new request for a paid slip is refused.
  assert.equal((await as("HR", () => markPayslipsCashPaid(input))).alreadyRecorded, true);
  await assert.rejects(as("HR", () => markPayslipsCashPaid({ ...input, requestKey: randomUUID() })), /Already paid/);
  const status = await as("HR", () => payrollPaymentStatus({ tenantId: company, runId: run.id }));
  assert.equal(status.cashDisbursement, true);
  assert.equal(status.items[0].status, "RECONCILED");
  assert.equal(status.items[0].method, "CASH");
  assert.equal(status.items[0].reference, "R-17");
  const slip = await db((tx) => tx.payrollPayslip.findFirst({ where: { tenantId: company, payrollRunId: run.id } }));
  assert.equal(slip.paidAt.toISOString(), "2026-10-01T10:00:00.000Z");
  assert.equal(
    await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, payslipId: slip.id, action: "PAYMENT_CASH_PAID" } })),
    1,
  );
  const mine = await as("EMPLOYEE", () => getMyPayslip({ tenantId: company, employeeId: people.EMPLOYEE.id, payslipId: slip.id }));
  assert.equal(new Date(mine.receivedOn).toISOString(), "2026-10-01T10:00:00.000Z");
  const claim = await as("HR", () =>
    createClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, title: "Taxi to client", amount: 1200 }),
  );
  assert.equal((claim.claim ?? claim).currency, "PKR");
  const emp = await db((tx) => tx.employee.findFirst({ where: { id: people.EMPLOYEE.id } }));
  const found = await as("HR", () => listClaims({ tenantId: company, q: (emp.first_name || emp.employee_code).slice(0, 4) }));
  assert.ok(JSON.stringify(found).includes("Taxi to client"));
});

test.after(() => prisma.$disconnect());
