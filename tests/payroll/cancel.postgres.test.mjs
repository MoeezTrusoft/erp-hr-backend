import test from "node:test";
import assert from "node:assert/strict";
import {
  setupPayroll,
  prisma,
  company,
  people,
  db,
  as,
  submit,
  act,
} from "./fixtures.mjs";
import {
  processPayrollRun,
  cancelPayrollRun,
} from "../../src/services/payrollService.js";

const approvalOf = (runId) =>
  db((tx) =>
    tx.hrApprovalRequest.findUnique({
      where: {
        tenantId_kind_sourceRef: {
          tenantId: company,
          kind: "PAYROLL",
          sourceRef: String(runId),
        },
      },
    }),
  );

test(
  "a Management-rejected payroll can be cancelled and its approval request is withdrawn",
  { timeout: 180000 },
  async () => {
    const { run } = await setupPayroll();
    await as("EMPLOYEE", () =>
      processPayrollRun(run.id, people.EMPLOYEE.id, company),
    );
    let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    // Mid-review the run is still COMPLETED, so cancellation stays refused.
    await assert.rejects(
      as("EMPLOYEE", () =>
        cancelPayrollRun(run.id, people.EMPLOYEE.id, company),
      ),
      /cancel/i,
    );
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    review = await act("MANAGEMENT", review, "REJECT");
    assert.equal(review.stage, "REJECTED");
    assert.equal(
      await db((tx) =>
        tx.loanRepayment.count({
          where: { tenantId: company, payrollRunId: run.id, settledAt: null },
        }),
      ),
      1,
    );

    const cancelled = await as("EMPLOYEE", () =>
      cancelPayrollRun(run.id, people.EMPLOYEE.id, company),
    );
    assert.equal(cancelled.status, "CANCELLED");
    const after = await approvalOf(run.id);
    assert.equal(after.stage, "WITHDRAWN");
    assert.equal(after.version, review.version + 1);
    const history = await db((tx) =>
      tx.hrApprovalAudit.findMany({
        where: { tenantId: company, approvalRef: after.id },
        orderBy: { version: "asc" },
      }),
    );
    assert.deepEqual(
      [history.at(-1).fromStage, history.at(-1).toStage, history.at(-1).actorCode],
      ["REJECTED", "WITHDRAWN", people.EMPLOYEE.employee_code],
    );
    assert.equal(
      await db((tx) =>
        tx.loanRepayment.count({
          where: { tenantId: company, payrollRunId: run.id },
        }),
      ),
      0,
    );
    // Repeating the cancellation is refused rather than writing more history.
    await assert.rejects(
      as("EMPLOYEE", () =>
        cancelPayrollRun(run.id, people.EMPLOYEE.id, company),
      ),
      /cancel/i,
    );
    await prisma.$disconnect();
  },
);
