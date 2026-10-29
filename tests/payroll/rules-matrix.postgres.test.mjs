// Pay Rules matrix: each configurable rule is flipped through the real publish -> calculate path
// (PostgreSQL, FORCE RLS) and the payslip it produces is read back. Fixture: base 100,000, HOUSING 10%,
// flat 10% tax, one loan with 5,000 outstanding, cap 33%.
import test from "node:test";
import assert from "node:assert/strict";
import { setupPayroll, company, people, db, as } from "./fixtures.mjs";
import { publishConfig } from "../../src/services/payrollConfigActions.service.js";
import { previewPayslip } from "../../src/services/payrollPreview.service.js";
import { getBlockingIssues } from "../../src/services/payrollDashboard.service.js";

const setRules = async (data) => {
  await db((tx) => tx.payrollRuleConfig.updateMany({ where: { tenantId: company }, data }));
  await as("EMPLOYEE", () => publishConfig({ tenantId: company, publishedById: String(people.EMPLOYEE.id) }));
};
const slip = async (run) =>
  (await as("EMPLOYEE", () => previewPayslip({ tenantId: company, runId: run.id, employeeCode: people.EMPLOYEE.employee_code }))).payslip;
const nums = (p) => ({ gross: Number(p.grossAmount), net: Number(p.netAmount), deductions: Number(p.totalDeductions) });

test("every supported Pay Rule changes the payslip the engine produces", { timeout: 240000 }, async () => {
  const { run } = await setupPayroll();

  // baseline: 110,000 gross, 11,000 tax, 5,000 loan instalment
  assert.deepEqual(nums(await slip(run)), { gross: 110000, net: 94000, deductions: 16000 });

  // garnishmentRecovery off: the loan is not recovered
  await setRules({ garnishmentRecovery: false });
  assert.equal(nums(await slip(run)).net, 99000, "loan recovery off");
  await setRules({ garnishmentRecovery: true });

  // garnishmentCapPct: the instalment is capped as a share of gross
  await setRules({ garnishmentCapPct: 1 });
  const capped = nums(await slip(run));
  assert.ok(capped.net > 94000 && capped.net < 99000, `cap 1% gives net ${capped.net}`);
  await setRules({ garnishmentCapPct: 33 });
  assert.equal(nums(await slip(run)).net, 94000, "cap restored");

  // eobiEnabled: a statutory contribution appears only when switched on
  await setRules({ eobiEnabled: true, eobiEmployeeRatePct: 1 });
  const eobi = nums(await slip(run));
  assert.ok(eobi.net < 94000, `EOBI lowers net (${eobi.net})`);
  await setRules({ eobiEnabled: false });
  assert.equal(nums(await slip(run)).net, 94000, "EOBI off");

  // midMonthJoinerProration: a joiner on 16 Sep is charged for the days outside employment only when the rule
  // is on (the engine keeps the contracted gross and adds a joining/leaving deduction).
  await db((tx) =>
    tx.employmentPeriod.create({
      data: { tenantId: company, employeeId: people.EMPLOYEE.id, startDate: new Date("2026-09-16T00:00:00Z"), endDate: null, reason: "Joined", note: "matrix" },
    }),
  );
  await setRules({ midMonthJoinerProration: true });
  const prorated = nums(await slip(run));
  assert.ok(prorated.net < 94000 - 1000, `joiner deduction lowers net (${prorated.net})`);
  await setRules({ midMonthJoinerProration: false });
  assert.deepEqual(nums(await slip(run)), { gross: 110000, net: 94000, deductions: 16000 }, "proration off pays the full month");
  await setRules({ midMonthJoinerProration: true });

  // cashDisbursement: no bank account is an issue only for a bank-paying company, and never blocks calculation
  await db((tx) => tx.bankDetail.updateMany({ where: { tenantId: company }, data: { isPrimary: false } }));
  await setRules({ cashDisbursement: false });
  const bankIssues = await as("EMPLOYEE", () => getBlockingIssues({ tenantId: company, runId: run.id }));
  assert.ok(bankIssues.some((i) => i.code === "BANK_REQUIRED" && i.phase === "FINALIZE"));
  await slip(run); // calculation is not blocked
  await setRules({ cashDisbursement: true });
  const cashIssues = await as("EMPLOYEE", () => getBlockingIssues({ tenantId: company, runId: run.id }));
  assert.ok(!cashIssues.some((i) => i.code === "BANK_REQUIRED"), "cash company needs no bank details");
  await slip(run);
});
