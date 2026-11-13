// F-08: a recalculation keeps the replaced earning/deduction lines in the audit row.
import test from "node:test";
import assert from "node:assert/strict";
import { setupPayroll, company, people, db, as } from "./fixtures.mjs";
import { processPayrollRun } from "../../src/services/payrollService.js";

test("reprocess audit keeps old and new lines, and a changed salary shows in both", { timeout: 180000 }, async () => {
  const { run } = await setupPayroll();
  const calculate = () => as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
  await calculate();
  const rows = () => db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action: "PAYSLIP_REPROCESSED", payrollRunId: run.id }, orderBy: { id: "asc" } }));
  assert.equal((await rows()).length, 0, "first calculation creates, it does not reprocess");

  await calculate();
  const [same] = await rows();
  assert.ok(same.oldValues.earnings.length >= 1 && same.newValues.earnings.length >= 1);
  assert.deepEqual(same.oldValues.earnings, same.newValues.earnings, "unchanged inputs give identical lines");
  assert.ok(same.oldValues.earnings.every((l) => typeof l.amount === "string" && "description" in l));

  // Change the salary, recalculate: the audit shows the before and after base line.
  await db((tx) => tx.employmentTerms.updateMany({ where: { tenantId: company, employeeId: people.EMPLOYEE.id }, data: { baseSalary: "120000" } }));
  await calculate();
  const last = (await rows()).at(-1);
  const baseOf = (lines) => Number(lines.find((l) => /base salary/i.test(l.description ?? ""))?.amount);
  assert.ok(baseOf(last.newValues.earnings) > baseOf(last.oldValues.earnings));
  assert.ok(Number(last.newValues.grossAmount) > Number(last.oldValues.grossAmount));
});
