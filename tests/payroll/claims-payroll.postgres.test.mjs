// Reimbursement claims against PostgreSQL: an approved claim is paid through payroll as a non-taxable line on the
// employee's next payslip. Calculating reserves it for that run, recalculating does not double it, a cancelled run
// frees it, and finalising the run marks it PAID. Marking a claim paid by hand is closed, and every claim is checked.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { setupPayroll, company, people, db, as, submit, act } from "./fixtures.mjs";
import { processPayrollRun, finalizePayrollRun } from "../../src/services/payrollService.js";
import { createClaim, submitClaim, markPaid, updateClaim, listMyClaims, submitMyClaim } from "../../src/services/claims.service.js";
import { previewClaimsForPayslip, reserveClaimsForPayslip } from "../../src/services/payrollClaims.service.js";

// A decided claim normally arrives through the approval engine; the table's guard is skipped to put one in a state.
const setStatus = async (ids, status) => {
  const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query("SET session_replication_role = replica");
    await admin.query(`UPDATE reimbursement_claims SET status = $1, "payrollRunId" = NULL, "payslipId" = NULL WHERE id = ANY($2)`, [status, ids]);
  } finally {
    await admin.end();
  }
};
const setRunStatus = async (id, status) => {
  const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query("SET session_replication_role = replica");
    await admin.query('UPDATE payroll_runs SET status = $1 WHERE id = $2', [status, id]);
  } finally {
    await admin.end();
  }
};
let ready;
const once = () => (ready ||= setupPayroll());
const claimOf = (id) => db((tx) => tx.reimbursementClaim.findFirst({ where: { id, tenantId: company } }));
const idOf = (made) => (made.claim ?? made).id;
const newClaim = (over = {}) => as("HR", () => createClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, title: "Taxi to client", amount: 1200, ...over })).then(idOf);
const approveClaim = async (id) => {
  await as("HR", () => submitClaim({ tenantId: company, id }));
  const ar = await db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "CLAIM", sourceRef: String(id) } }));
  let rec = { approvalRef: ar.id, version: ar.version, stage: ar.stage };
  if (rec.stage === "LINE_MANAGER") rec = await act("MANAGER", rec, "RECOMMEND_APPROVAL");
  if (rec.stage === "HR") rec = await act("HR", rec, "VERIFY");
  rec = await act("MANAGEMENT", rec, "APPROVE");
  assert.equal(rec.stage, "APPROVED");
};
const slip = (runId) => db((tx) => tx.payrollPayslip.findFirst({ where: { tenantId: company, payrollRunId: runId }, include: { earnings: { include: { earningType: true } }, deductions: true } }));
const calc = (runId) => as("EMPLOYEE", () => processPayrollRun(runId, people.EMPLOYEE.id, company));
const tax = (s) => Number(s.deductions.find((d) => /Income Tax/.test(d.description))?.amount ?? 0);
const lines = (s) => s.earnings.filter((e) => /^Reimbursement/.test(e.description));

test("a run reserves a loan's installment only from the period that reaches its disbursement date", { timeout: 240000 }, async () => {
  const { run } = await once();
  const fresh = await db((tx) => tx.payrollRun.findFirst({ where: { id: run.id } }));
  const after = new Date(+fresh.periodEnd + 40 * 86400000);
  const admin = async (sql, args = []) => {
    const c = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
    await c.connect();
    try {
      await c.query("SET session_replication_role = replica");
      return (await c.query(sql, args)).rows;
    } finally {
      await c.end();
    }
  };
  const [{ id: loanId }] = await admin(`INSERT INTO loans ("tenantId", "employeeId", status, "principalMinor", "outstandingMinor", "monthlyInstallmentMinor", "tenureMonths", "disbursementDate", reason, kind, updated_at) VALUES ($1, $2, 'ACTIVE', 300000, 300000, 100000, 3, $3, 'process test', 'LOAN', now()) RETURNING id`, [company, people.EMPLOYEE.id, after]);
  const reserved = () => db((tx) => tx.loanRepayment.count({ where: { loanId, payrollRunId: run.id } }));
  try {
    await calc(run.id);
    assert.equal(await reserved(), 0, "disbursed after the period: nothing is taken yet");
    await admin('UPDATE loans SET "disbursementDate" = $1 WHERE id = $2', [fresh.periodStart, loanId]);
    await calc(run.id);
    assert.equal(await reserved(), 1, "disbursed within the period: the installment is reserved");
  } finally {
    await admin('DELETE FROM loan_repayments WHERE "loanId" = $1', [loanId]);
    await admin("DELETE FROM loans WHERE id = $1", [loanId]);
    await calc(run.id);
  }
});

test("an approved claim is paid on the next payslip as a non-taxable line, once, and PAID when the run is finalised", { timeout: 240000 }, async () => {
  const { run } = await once();
  await calc(run.id);
  const base = await slip(run.id);
  assert.equal(lines(base).length, 0, "no claim, no line");

  const id = await newClaim();
  assert.equal((await claimOf(id)).status, "DRAFT");
  await approveClaim(id);
  assert.equal((await claimOf(id)).status, "APPROVED");
  assert.equal((await claimOf(id)).payrollRunId, null, "approval alone reserves nothing");

  await calc(run.id);
  const withClaim = await slip(run.id);
  const line = lines(withClaim);
  assert.equal(line.length, 1);
  assert.equal(Number(line[0].amount), 1200);
  assert.match(line[0].description, /Taxi to client/);
  assert.equal(line[0].earningType.isTaxable, false, "the reimbursement type is non-taxable");
  assert.equal(line[0].earningType.name, "Reimbursement", "the type is not named after a claim");
  assert.equal(tax(withClaim), tax(base), "the reimbursement does not change income tax");
  assert.equal(Number(withClaim.grossAmount) - Number(base.grossAmount), 1200);
  assert.equal(Number(withClaim.netAmount) - Number(base.netAmount), 1200, "it is paid in full, nothing is taken from it");
  const held = await claimOf(id);
  assert.equal(held.status, "APPROVED", "reserved, not yet paid");
  assert.equal(held.payrollRunId, run.id);
  assert.equal(held.payslipId, withClaim.id);

  await calc(run.id);
  assert.equal(lines(await slip(run.id)).length, 1, "recalculating does not double it");
  assert.equal((await claimOf(id)).payrollRunId, run.id);

  let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
  review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
  review = await act("HR", review, "VERIFY");
  await act("MANAGEMENT", review, "APPROVE");
  assert.equal((await claimOf(id)).status, "APPROVED", "approving the run does not pay it; finalising does");
  await as("HR", () => finalizePayrollRun(run.id, people.HR.id, company));
  const paid = await claimOf(id);
  assert.equal(paid.status, "PAID");
  assert.ok(paid.paidAt);

  // Once paid it is never offered again.
  assert.deepEqual(await db((tx) => reserveClaimsForPayslip(tx, { tenantId: company, runId: run.id + 1000, employeeId: people.EMPLOYEE.id, currency: "PKR" })), []);
});

test("a claim reserved by a run that is cancelled or failed is free for the next run; one held by a live run is not", async () => {
  const { run } = await once();
  const id = await newClaim({ title: "Parking", amount: 300 });
  await approveClaim(id);
  const ask = (runId) => db((tx) => previewClaimsForPayslip(tx, { tenantId: company, runId, employeeId: people.EMPLOYEE.id, currency: "PKR" }));
  const reserve = (runId) => db((tx) => reserveClaimsForPayslip(tx, { tenantId: company, runId, employeeId: people.EMPLOYEE.id, currency: "PKR" }));
  const OTHER_RUN = run.id + 5000;
  assert.equal((await reserve(run.id)).length, 1);
  assert.equal((await ask(OTHER_RUN)).length, 0, "held by a live run");
  assert.deepEqual(await reserve(OTHER_RUN), [], "and a second run cannot take it");
  assert.equal((await ask(run.id)).length, 1, "the holder still sees it, so recalculating keeps it");
  const status = (await db((tx) => tx.payrollRun.findFirst({ where: { id: run.id } }))).status;
  for (const gone of ["CANCELLED", "FAILED"]) {
    await setRunStatus(run.id, gone);
    assert.equal((await ask(OTHER_RUN)).length, 1, `${gone} run no longer holds it`);
  }
  await setRunStatus(run.id, status);
  await setStatus([id], "WITHDRAWN");
});

test("a claim in another currency, a claim not yet approved and a rejected claim are never put on a payslip", async () => {
  const { run } = await once();
  const usd = await newClaim({ title: "Conference ticket", amount: 90, currency: "USD" });
  const draft = await newClaim({ title: "Lunch", amount: 400 });
  await approveClaim(usd);
  await setStatus([usd], "APPROVED");
  const before = await db((tx) => tx.reimbursementClaim.findMany({ where: { tenantId: company, id: { in: [usd, draft] } }, orderBy: { id: "asc" } }));
  const shown = await db((tx) => previewClaimsForPayslip(tx, { tenantId: company, runId: run.id, employeeId: people.EMPLOYEE.id, currency: "PKR" }));
  assert.ok(!shown.some((c) => [usd, draft].includes(c.claimId)));
  assert.equal(before[0].status, "APPROVED");
  await setStatus([usd, draft], "REJECTED");
  const rejected = await db((tx) => previewClaimsForPayslip(tx, { tenantId: company, runId: run.id, employeeId: people.EMPLOYEE.id, currency: "PKR" }));
  assert.ok(!rejected.some((c) => [usd, draft].includes(c.claimId)));
});

test("marking a claim paid by hand is closed", async () => {
  await once();
  await assert.rejects(markPaid({ tenantId: company, id: 1 }), /paid through payroll/);
});

test("every claim is checked: real active employee, title, whole positive amount, lines that add up", async () => {
  await once();
  const refused = (over, message) => assert.rejects(as("HR", () => createClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, title: "Taxi", amount: 100, ...over })), message);
  await refused({ amount: 0 }, /above zero/);
  await refused({ amount: -50 }, /above zero/);
  await refused({ amount: 99.5 }, /whole amount/);
  await refused({ amount: 5e9 }, /too large/);
  await refused({ amount: "abc" }, /above zero/);
  await refused({ title: "x" }, /title/);
  await refused({ currency: "RS" }, /three-letter/);
  await refused({ employeeId: 999999 }, /Employee not found/);
  await refused({ items: [{ name: "Fare", amount: 60 }, { name: "Tip", amount: 30 }] }, /add up to 90, but the claim is 100/);
  await refused({ items: [{ name: "", amount: 100 }] }, /needs a name/);
  await refused({ items: [{ name: "Fare", amount: 0 }] }, /needs a name and an amount/);
  await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { status: "Terminated" } }));
  try {
    await refused({}, /active employee/);
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { status: "Active" } }));
  }
  const ok = await newClaim({ amount: 100, items: [{ name: "Fare", amount: 60 }, { name: "Tip", amount: 40 }] });
  assert.ok(ok);
  // An edit is held to the same checks, against the claim as it will stand.
  await assert.rejects(as("HR", () => updateClaim({ tenantId: company, id: ok, amount: 250 })), /add up to 100, but the claim is 250/);
  await assert.rejects(as("HR", () => updateClaim({ tenantId: company, id: ok, items: [{ name: "Fare", amount: 10.5 }] })), /whole amount/);
  await as("HR", () => updateClaim({ tenantId: company, id: ok, amount: 150, items: [{ name: "Fare", amount: 150 }] }));
  assert.equal(Number((await claimOf(ok)).amount), 150);
  assert.equal((await claimOf(ok)).currency, "PKR", "the currency is the employee's pay currency, not a dollar");
});

test("an employee makes and submits their own claim; nobody else's claim can be reached", async () => {
  await once();
  const made = await as("EMPLOYEE", () => createClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, title: "Mobile top-up", amount: 500 }));
  const id = idOf(made);
  const theirs = await newClaim({ title: "Someone else's", amount: 100 });
  await db((tx) => tx.reimbursementClaim.update({ where: { id: theirs }, data: { employeeId: people.OTHER.id } }));
  await assert.rejects(as("EMPLOYEE", () => submitMyClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, id: theirs })), /Claim not found/);
  await as("EMPLOYEE", () => submitMyClaim({ tenantId: company, employeeId: people.EMPLOYEE.id, id }));
  const ar = await db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "CLAIM", sourceRef: String(id) } }));
  assert.ok(ar, "it reached the Approval Centre");
  assert.equal(ar.employeeCode, people.EMPLOYEE.employee_code);
  const mine = await as("EMPLOYEE", () => listMyClaims({ tenantId: company, employeeId: people.EMPLOYEE.id }));
  assert.ok(mine.items.some((c) => c.id === id));
  assert.ok(!mine.items.some((c) => c.id === theirs), "only their own");
});

test("HR claiming her own expense: her filing is the HR check and Management alone decides", async () => {
  await once();
  const made = await as("HR", () => createClaim({ tenantId: company, employeeId: people.HR.id, title: "HR conference travel", amount: 900 }));
  const id = idOf(made);
  await as("HR", () => submitMyClaim({ tenantId: company, employeeId: people.HR.id, id }));
  const ar = await db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "CLAIM", sourceRef: String(id) } }));
  assert.equal(ar.stage, "MANAGEMENT", "no second HR is needed");
  assert.equal(ar.hrActorCode, people.HR.employee_code);
  assert.equal((await act("MANAGEMENT", { approvalRef: ar.id, version: ar.version }, "APPROVE")).stage, "APPROVED");
});

test("Management claiming her own expense is approved at once and then paid through payroll like any approved claim", async () => {
  await once();
  const made = await as("MANAGEMENT", () => createClaim({ tenantId: company, employeeId: people.MANAGEMENT.id, title: "Management travel", amount: 700 }));
  const id = idOf(made);
  const sent = await as("MANAGEMENT", () => submitMyClaim({ tenantId: company, employeeId: people.MANAGEMENT.id, id }));
  assert.equal(sent.status, "APPROVED", "the answer says it was approved at once");
  const ar = await db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "CLAIM", sourceRef: String(id) } }));
  assert.equal(ar.stage, "APPROVED");
  assert.equal((await db((tx) => tx.reimbursementClaim.findFirst({ where: { id, tenantId: company } }))).status, "APPROVED");
});

test("a loan is recovered from the first run whose period ends on or after its disbursement date", async () => {
  const { loanBridgeWhere } = await import("../../src/services/payrollService.js");
  await once();
  const periodEnd = new Date("2031-03-31T00:00:00Z");
  const mk = async (disbursementDate) => {
    const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
    await admin.connect();
    try {
      await admin.query("SET session_replication_role = replica");
      const { rows } = await admin.query(`INSERT INTO loans ("tenantId", "employeeId", status, "principalMinor", "outstandingMinor", "monthlyInstallmentMinor", "tenureMonths", "disbursementDate", reason, kind, updated_at) VALUES ($1, $2, 'ACTIVE', 100000, 100000, 100000, 1, $3, 'bridge test', 'ADVANCE', now()) RETURNING id`, [company, people.EMPLOYEE.id, disbursementDate]);
      return rows[0];
    } finally {
      await admin.end();
    }
  };
  const before = await mk("2031-03-10T09:00:00Z");
  const lastDay = await mk("2031-03-31T15:30:00Z");
  const after = await mk("2031-04-01T00:00:00Z");
  try {
    const picked = (await db((tx) => tx.loan.findMany({ where: { tenantId: company, ...loanBridgeWhere(people.EMPLOYEE.id, 1, periodEnd) }, select: { id: true } }))).map((l) => l.id);
    assert.ok(picked.includes(before.id), "disbursed earlier in the month");
    assert.ok(picked.includes(lastDay.id), "disbursed during the last day of the period still counts");
    assert.ok(!picked.includes(after.id), "disbursed after the period waits for the next run");
  } finally {
    await db((tx) => tx.loan.deleteMany({ where: { id: { in: [before.id, lastDay.id, after.id] } } }));
  }
});
