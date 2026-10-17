import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  setupPayroll,
  prisma,
  company,
  other,
  people,
  db,
  as,
  submit,
  act,
} from "./fixtures.mjs";
import {
  createPayrollRun,
  processPayrollRun,
  finalizePayrollRun,
  cancelPayrollRun,
  distributePayslip,
} from "../../src/services/payrollService.js";
import { previewPayslip } from "../../src/services/payrollPreview.service.js";
import { generateBankDisbursementFile } from "../../src/services/bankFileService.js";
import {
  recordPayrollPayment,
  payrollPaymentStatus,
} from "../../src/services/payrollPayments.service.js";
import { getMyPayslip } from "../../src/services/myPayslip.service.js";
import { recordRepayment } from "../../src/services/loan.service.js";
import { getBlockingIssues } from "../../src/services/payrollDashboard.service.js";
process.env.HR_C4_BLIND_INDEX_KEY = Buffer.alloc(32, 19).toString("base64");

test(
  "real payroll lifecycle: preview, calculation, returns, independent approval, loan settlement, bank reconciliation and payslip",
  { timeout: 180000 },
  async () => {
    const { run, loan } = await setupPayroll();
    const calculate = () =>
      as("EMPLOYEE", () =>
        processPayrollRun(run.id, people.EMPLOYEE.id, company),
      );
    const debt = () =>
      db((tx) =>
        tx.loan.findFirst({ where: { tenantId: company, id: loan.id } }),
      );
    await db((tx) =>
      tx.bankDetail.updateMany({
        where: { tenantId: company },
        data: { isPrimary: false },
      }),
    );
    assert.equal(
      (
        await as("EMPLOYEE", () =>
          getBlockingIssues({ tenantId: company, runId: run.id }),
        )
      )[0].code,
      "BANK_REQUIRED",
    );
    await assert.rejects(
      as("EMPLOYEE", () =>
        previewPayslip({
          tenantId: company,
          runId: run.id,
          employeeCode: people.EMPLOYEE.employee_code,
        }),
      ),
      /Primary bank/,
    );
    await db((tx) =>
      tx.bankDetail.updateMany({
        where: { tenantId: company },
        data: { isPrimary: true },
      }),
    );
    // Editing drafts cannot silently change a previously published calculation.
    await db((tx) =>
      tx.salaryComponent.updateMany({
        where: { tenantId: company, code: "HOUSING" },
        data: { value: 99, status: "DRAFT" },
      }),
    );
    assert.deepEqual(
      await as("EMPLOYEE", () =>
        getBlockingIssues({ tenantId: company, runId: run.id }),
      ),
      [],
    );
    const preview = await as("EMPLOYEE", () =>
      previewPayslip({
        tenantId: company,
        runId: run.id,
        employeeCode: people.EMPLOYEE.employee_code,
      }),
    );
    assert.equal(Number(preview.payslip.grossAmount), 110000);
    assert.equal(Number(preview.payslip.netAmount), 94000);
    assert.equal(
      await db((tx) =>
        tx.payrollPayslip.count({
          where: { tenantId: company, payrollRunId: run.id },
        }),
      ),
      0,
    );
    assert.equal((await debt()).outstandingMinor, 500000);
    let calculated = await calculate();
    assert.equal(
      Number(calculated.totalNet),
      Number(preview.payslip.netAmount),
    );
    await calculate();
    assert.equal((await debt()).outstandingMinor, 500000);
    await assert.rejects(
      as("HR", () =>
        recordRepayment({ tenantId: company, loanId: loan.id, amountMinor: 1 }),
      ),
      /reserved by payroll/,
    );
    assert.equal(
      await db((tx) =>
        tx.loanRepayment.count({
          where: { tenantId: company, payrollRunId: run.id },
        }),
      ),
      1,
    );
    await assert.rejects(
      as("HR", () => finalizePayrollRun(run.id, people.HR.id, company)),
      /approval/,
    );
    let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    await assert.rejects(calculate(), /Return.*initiator/);
    review = await act("MANAGER", review, "REVERT");
    await calculate();
    review = await submit(
      { kind: "PAYROLL", ref: String(run.id) },
      review.version,
    );
    review = await act("MANAGER", review, "RECOMMEND_REJECTION");
    review = await act("HR", review, "VERIFY");
    review = await act("MANAGEMENT", review, "REVERT");
    assert.equal(review.stage, "HR");
    review = await act("HR", review, "REVERT");
    await calculate();
    review = await submit(
      { kind: "PAYROLL", ref: String(run.id) },
      review.version,
    );
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    review = await act("MANAGEMENT", review, "REJECT");
    await calculate();
    review = await db((tx) =>
      tx.hrApprovalRequest.findUnique({
        where: {
          tenantId_kind_sourceRef: {
            tenantId: company,
            kind: "PAYROLL",
            sourceRef: String(run.id),
          },
        },
      }),
    );
    assert.equal(review.stage, "INITIATOR");
    review = await submit(
      { kind: "PAYROLL", ref: String(run.id) },
      review.version,
    );
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    review = await act("MANAGEMENT", review, "APPROVE");
    await assert.rejects(
      as("HR", () => cancelPayrollRun(run.id, people.HR.id, company)),
      /cannot|cancel/i,
    );
    await as("HR", () => finalizePayrollRun(run.id, people.HR.id, company));
    await as("HR", () => finalizePayrollRun(run.id, people.HR.id, company));
    assert.equal((await debt()).outstandingMinor, 0);
    assert.equal((await debt()).status, "PAID_OFF");
    const file = await as("HR", () =>
      generateBankDisbursementFile(run.id, {
        tenantId: company,
        format: "csv",
      }),
    );
    assert.match(file.content, /EMP-EMPLOYEE/);
    assert.doesNotMatch(file.content, /Fictional/);
    await assert.rejects(
      as(
        "HR",
        () => generateBankDisbursementFile(run.id, { tenantId: other }),
        other,
      ),
      /not found/,
    );
    const input = {
      tenantId: company,
      runId: run.id,
      employeeCode: people.EMPLOYEE.employee_code,
      actorCode: people.HR.employee_code,
      reference: "BANK-TEST-001",
      evidenceRef: "Evidence/fictional-statement.pdf",
      amount: "94000",
      currency: "PKR",
      occurredAt: "2026-10-01T10:00:00Z",
    };
    await assert.rejects(
      as("HR", () =>
        recordPayrollPayment({
          ...input,
          stage: "SUBMITTED",
          amount: "99999",
          requestKey: randomUUID(),
        }),
      ),
      /exactly match/,
    );
    await assert.rejects(
      as("HR", () =>
        recordPayrollPayment({
          ...input,
          stage: "RECONCILED",
          requestKey: randomUUID(),
        }),
      ),
      /Cannot record/,
    );
    for (const stage of ["SUBMITTED", "ACKNOWLEDGED", "RECONCILED"]) {
      const event = { ...input, stage, requestKey: randomUUID() };
      await as("HR", () => recordPayrollPayment(event));
      await as("HR", () => recordPayrollPayment(event));
    }
    const payments = await as("HR", () =>
      payrollPaymentStatus({ tenantId: company, runId: run.id }),
    );
    assert.equal(payments.items[0].history.length, 3);
    const slip = await db((tx) =>
      tx.payrollPayslip.findFirst({
        where: { tenantId: company, payrollRunId: run.id },
      }),
    );
    await as("HR", () => distributePayslip(slip.id, people.HR.id, company));
    const mine = await as("EMPLOYEE", () =>
      getMyPayslip({
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        employeeScoped: true,
      }),
    );
    assert.equal(mine.employeeCode, "EMP-EMPLOYEE");
    assert.equal(mine.totalWorkingDays, 30);
    assert.equal(mine.daysPaid.toString(), "30");
    assert.equal(mine.receivedOn.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(mine.ytd.net, 94000);
    const paidFile = await as("HR", () =>
      generateBankDisbursementFile(run.id, {
        tenantId: company,
        format: "csv",
      }),
    );
    assert.equal(paidFile.summary.rowCount, 0);
    assert.ok(slip.paymentEvidence.encrypted);
    assert.ok(!JSON.stringify(slip.paymentEvidence).includes("94000"));
    const [a, b] = await Promise.allSettled(
      [1, 2].map(() =>
        as("EMPLOYEE", () =>
          createPayrollRun(
            {
              periodStart: "2026-10-01",
              periodEnd: "2026-10-31",
              countryCode: "PK",
              currencyCode: "PKR",
            },
            people.EMPLOYEE.id,
            company,
          ),
        ),
      ),
    );
    assert.equal([a, b].filter((r) => r.status === "fulfilled").length, 1);
    const next = [a, b].find((r) => r.status === "fulfilled").value;
    await as("EMPLOYEE", () =>
      cancelPayrollRun(next.id, people.EMPLOYEE.id, company),
    );
    const replacement = await as("EMPLOYEE", () =>
      createPayrollRun(
        {
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          countryCode: "PK",
          currencyCode: "PKR",
        },
        people.EMPLOYEE.id,
        company,
      ),
    );
    assert.notEqual(replacement.id, next.id);
    assert.equal(
      (
        await db((tx) =>
          tx.payrollRun.findFirst({
            where: { id: next.id, tenantId: company },
          }),
        )
      ).status,
      "CANCELLED",
    );
    await prisma.$disconnect();
  },
);
