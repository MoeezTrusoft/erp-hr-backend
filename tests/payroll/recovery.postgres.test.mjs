import test from "node:test";
import assert from "node:assert/strict";
import {
  setupPayroll,
  prisma,
  company,
  people,
  db,
  as,
} from "./fixtures.mjs";
import {
  processPayrollRun,
  cancelPayrollRun,
} from "../../src/services/payrollService.js";
test(
  "a run left in PROCESSING can be recalculated once stale, never while fresh",
  { timeout: 180000 },
  async () => {
    const { run } = await setupPayroll();
    const calculate = () =>
      as("EMPLOYEE", () =>
        processPayrollRun(run.id, people.EMPLOYEE.id, company),
      );
    await calculate();
    const strand = (minutesAgo) =>
      db((tx) =>
        tx.$executeRaw`UPDATE payroll_runs SET status='PROCESSING', updated_at=now() - make_interval(mins => ${minutesAgo}) WHERE id=${run.id}`,
      );
    await strand(1);
    await assert.rejects(calculate(), /processing/i);
    await strand(45);
    const recalculated = await calculate();
    assert.equal(recalculated.status, "COMPLETED");
    const interrupted = await db((tx) =>
      tx.payrollAuditLog.count({
        where: {
          tenantId: company,
          payrollRunId: run.id,
          action: "PAYROLL_PROCESSING_INTERRUPTED",
        },
      }),
    );
    assert.equal(interrupted, 1);
    await strand(45);
    const cancelled = await as("EMPLOYEE", () =>
      cancelPayrollRun(run.id, people.EMPLOYEE.id, company),
    );
    assert.equal(cancelled.status, "CANCELLED");
    await prisma.$disconnect();
  },
);
