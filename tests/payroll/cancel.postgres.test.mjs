import test from "node:test";
import pg from "pg";
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
  createPayrollRun,
  processPayrollRun,
  cancelPayrollRun,
  finalizePayrollRun,
} from "../../src/services/payrollService.js";
import { assertAttendancePeriodOpen } from "../../src/services/attendancePeriod.service.js";

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

// The fixture seeds one company; the first test takes its run, later tests
// open a new run for the same period (the previous one is cancelled by then).
let seeded;
const nextRun = async () => {
  if (!seeded) return { run: (seeded = await setupPayroll()).run };
  const run = await as("EMPLOYEE", () =>
    createPayrollRun(
      { periodStart: "2026-09-01", periodEnd: "2026-09-30", countryCode: "PK", currencyCode: "PKR" },
      people.EMPLOYEE.id,
      company,
    ),
  );
  return { run };
};
const runOf = (id) => db((tx) => tx.payrollRun.findFirst({ where: { id, tenantId: company } }));
const recall = (run, reason) =>
  as("EMPLOYEE", () => cancelPayrollRun(run.id, people.EMPLOYEE.id, company, reason));

test(
  "a calculated run with no review is recalled with a reason",
  { timeout: 180000 },
  async () => {
    const { run } = await nextRun();
    await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    const out = await recall(run, "Leave approved late for Oct");
    assert.equal(out.status, "CANCELLED");
    assert.equal((await runOf(run.id)).status, "CANCELLED");
    const last = await db((tx) =>
      tx.payrollAuditLog.findFirst({ where: { tenantId: company, payrollRunId: run.id }, orderBy: { id: "desc" } }),
    );
    assert.equal(last.action, "PAYROLL_RECALLED");
    assert.match(last.details, /Recalled: Leave approved late for Oct/);
    const run2 = await runOf(run.id);
    await db((tx) => assertAttendancePeriodOpen(tx, company, run2.periodStart, run2.periodEnd));
  },
);

test(
  "an approved, unfinalized run is recalled and its approval withdrawn",
  { timeout: 180000 },
  async () => {
    const { run } = await nextRun();
    await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    review = await act("MANAGEMENT", review, "APPROVE");
    assert.equal(review.stage, "APPROVED");
    // A decided claim normally arrives through the approval engine; the guard is skipped to place one on this run.
    const claim = await db((tx) =>
      tx.reimbursementClaim.create({
        data: { tenantId: company, employeeId: people.EMPLOYEE.id, title: "Taxi", amount: 100, currency: "PKR" },
      }),
    );
    const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
    await admin.connect();
    try {
      await admin.query("SET session_replication_role = replica");
      await admin.query(`UPDATE reimbursement_claims SET status = 'APPROVED', "payrollRunId" = $1 WHERE id = $2`, [run.id, claim.id]);
    } finally {
      await admin.end();
    }
    const out = await recall(run, "Leave approved late for Oct");
    assert.equal(out.status, "CANCELLED");
    const after = await approvalOf(run.id);
    assert.equal(after.stage, "WITHDRAWN");
    const history = await db((tx) =>
      tx.hrApprovalAudit.findMany({ where: { tenantId: company, approvalRef: after.id }, orderBy: { version: "asc" } }),
    );
    assert.deepEqual([history.at(-1).fromStage, history.at(-1).toStage], ["APPROVED", "WITHDRAWN"]);
    assert.equal(
      await db((tx) => tx.loanRepayment.count({ where: { tenantId: company, payrollRunId: run.id, settledAt: null } })),
      0,
    );
    const held = await db((tx) => tx.reimbursementClaim.findFirst({ where: { id: claim.id, tenantId: company } }));
    assert.equal(held.payrollRunId, null);
    assert.equal(held.payslipId, null);
    assert.equal(held.status, "APPROVED");
  },
);

test(
  "recall without a 10-character reason is refused",
  { timeout: 180000 },
  async () => {
    const { run } = await nextRun();
    await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    await assert.rejects(recall(run, "late"), (e) => /reason/i.test(e.message) && e.status === 400);
    assert.equal((await runOf(run.id)).status, "COMPLETED");
    await recall(run, "Reason that is long enough"); // frees the period for the next test
  },
);

test(
  "a Management-rejected payroll can be cancelled and its approval request is withdrawn",
  { timeout: 180000 },
  async () => {
    const { run } = await nextRun();
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
  },
);

test(
  "a finalized run cannot be recalled",
  { timeout: 180000 },
  async () => {
    const { run } = await nextRun();
    await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    await act("MANAGEMENT", review, "APPROVE");
    await as("HR", () => finalizePayrollRun(run.id, people.HR.id, company));
    await assert.rejects(recall(run, "Leave approved late for Oct"), /recalled/);
    assert.equal((await runOf(run.id)).status, "FINALIZED");
  },
);

test.after(() => prisma.$disconnect());
