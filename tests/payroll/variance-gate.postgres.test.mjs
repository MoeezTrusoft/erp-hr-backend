// F-01 end to end: a payslip that swings >10% from last month blocks submission
// for approval until a written explanation is recorded; the explanation is
// audited and bound to the gross it explained.
import test from "node:test";
import assert from "node:assert/strict";
import { setupPayroll, company, people, db, as, submit } from "./fixtures.mjs";
import { processPayrollRun } from "../../src/services/payrollService.js";
import { acknowledgePayslipVariance, listPayslipVariances } from "../../src/services/payslipVariance.service.js";

test(
  "variance gate: blocks approval until explained, then allows it; edge cases refuse",
  { timeout: 180000 },
  async () => {
    const { run } = await setupPayroll();
    const calculate = () => as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    const calculated = await calculate();
    const gross = Number(calculated.totalGross);
    assert.ok(gross > 0);

    // Edge: no earlier payslip (first month) -> nothing to explain.
    assert.deepEqual((await as("HR", () => listPayslipVariances({ tenantId: company, runId: run.id }))).unexplained, []);
    await assert.rejects(
      as("HR", () => acknowledgePayslipVariance({ tenantId: company, runId: run.id, employeeId: people.EMPLOYEE.id, reason: "Approved raise effective September" })),
      /no month-on-month change/,
    );

    // Last month paid half as much (CANCELLED runs must be ignored, so add one that would hide it).
    const mk = (status, start, end, gross) =>
      db(async (tx) => {
        const r = await tx.payrollRun.create({
          data: { tenantId: company, periodStart: new Date(start), periodEnd: new Date(end), countryCode: "PK", currencyCode: "PKR", status },
        });
        await tx.payrollPayslip.create({
          data: { tenantId: company, payrollRunId: r.id, employeeId: people.EMPLOYEE.id, grossAmount: String(gross), totalDeductions: "0", netAmount: String(gross) },
        });
        return r;
      });
    await mk("COMPLETED", "2026-08-01", "2026-08-31", gross / 2);
    await mk("CANCELLED", "2026-08-15", "2026-08-31", gross); // would match this month if cancelled runs counted

    const listed = await as("HR", () => listPayslipVariances({ tenantId: company, runId: run.id }));
    assert.equal(listed.unexplained.length, 1);
    assert.equal(listed.unexplained[0].employeeId, people.EMPLOYEE.id);
    assert.equal(listed.unexplained[0].previous, gross / 2);

    // Submission for approval is refused while unexplained.
    await assert.rejects(submit({ kind: "PAYROLL", ref: String(run.id) }), /moved more than 10%/);

    // Edge: bad explanations are refused and nothing is recorded.
    for (const reason of ["", "short", "   ", "x".repeat(501)])
      await assert.rejects(
        as("HR", () => acknowledgePayslipVariance({ tenantId: company, runId: run.id, employeeId: people.EMPLOYEE.id, reason })),
        /characters/,
      );
    // Edge: unknown run / other company's id / non-numeric ids.
    await assert.rejects(as("HR", () => acknowledgePayslipVariance({ tenantId: company, runId: 999999, employeeId: people.EMPLOYEE.id, reason: "Approved raise effective September" })), /not found/);
    await assert.rejects(as("HR", () => acknowledgePayslipVariance({ tenantId: company, runId: "abc", employeeId: people.EMPLOYEE.id, reason: "Approved raise effective September" })), /numeric/);
    assert.equal(await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, action: "PAYSLIP_VARIANCE_ACKNOWLEDGED" } })), 0);

    const ack = await as("HR", () =>
      acknowledgePayslipVariance({ tenantId: company, runId: run.id, employeeId: people.EMPLOYEE.id, reason: "Approved raise effective September", actorEmployeeId: people.HR.id }),
    );
    assert.equal(ack.acknowledged, true);
    const rows = await db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action: "PAYSLIP_VARIANCE_ACKNOWLEDGED" } }));
    assert.equal(rows.length, 1);
    assert.match(rows[0].details, /Approved raise effective September/);
    assert.equal(rows[0].employeeId, people.EMPLOYEE.id);

    // Explained: the gate lets the run through to approval.
    assert.deepEqual((await as("HR", () => listPayslipVariances({ tenantId: company, runId: run.id }))).unexplained, []);
    const review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    assert.ok(review.approvalRef);
  },
);
