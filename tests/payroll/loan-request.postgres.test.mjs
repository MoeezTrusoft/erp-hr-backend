// Loans and salary advances against PostgreSQL: an employee can ask for one for themselves, HR can raise one on their
// behalf, both go through the approval route, and nothing is lent until the final approval. Basic checks (amounts,
// dates, an active employee of this company, no duplicate waiting request) hold however the request is raised.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, people, db, as, act } from "../approval/fixtures.mjs";
const loans = await import("../../src/services/loan.service.js");

import pg from "pg";
const foreignEmployee = async () => {
  const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query(`INSERT INTO "Employee" (tenant_id, employee_code, employee_name, status, "employeeCategory", updated_at) VALUES ($1, $2, 'Foreign Person', 'Active', 'EMPLOYEE', now()) RETURNING id`, [other, `FOREIGN-${Date.now()}`]);
    return rows[0].id;
  } finally {
    await admin.end();
  }
};
let ready;
const once = () => (ready ||= setup());
const mine = (over = {}) => as("EMPLOYEE", () => loans.requestMyLoan({ tenantId: company, employeeId: people.EMPLOYEE.id, kind: "ADVANCE", principalMinor: 5000000, tenureMonths: 1, reason: "School fees this month", ...over }));
const byHr = (over = {}) => as("HR", () => loans.createLoan({ tenantId: company, employeeId: people.EMPLOYEE.id, kind: "LOAN", principalMinor: 12000000, tenureMonths: 12, reason: "Home repair, agreed with the employee", createdById: people.HR.id, submit: true, ...over }));
const loan = (id) => db((tx) => tx.loan.findFirst({ where: { id, tenantId: company } }));
const approvalOf = (id) => db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "LOAN", sourceRef: String(id) } }));
const clear = () => db((tx) => tx.loan.deleteMany({ where: { tenantId: company, status: "PENDING" } }));
const walk = async (id, last = "APPROVE") => {
  let ar = await approvalOf(id);
  let rec = { approvalRef: ar.id, version: ar.version };
  for (let guard = 0; guard < 4; guard++) {
    const stage = (await approvalOf(id)).stage;
    if (stage === "LINE_MANAGER") rec = await act("MANAGER", rec, "RECOMMEND_APPROVAL");
    else if (stage === "HR") rec = await act("HR", rec, "VERIFY");
    else return act("MANAGEMENT", rec, last);
  }
  throw new Error("the request did not reach Management");
};

test("an employee asks for a salary advance for themselves; nothing is lent until the final approval", async () => {
  await once();
  await clear();
  const asked = await mine();
  assert.equal(asked.requested, true);
  const row = await loan(asked.loanId);
  assert.equal(row.status, "PENDING");
  assert.equal(row.kind, "ADVANCE");
  assert.equal(row.employeeId, people.EMPLOYEE.id);
  assert.equal(row.createdById, people.EMPLOYEE.id);
  assert.equal(row.interestRatePct, 0, "an employee's request is interest-free");
  assert.equal(row.monthlyInstallmentMinor, 5000000);
  const ar = await approvalOf(asked.loanId);
  assert.ok(ar, "it reached the Approval Centre");
  assert.equal(ar.employeeCode, people.EMPLOYEE.employee_code, "as the employee's own request");
  assert.equal((await walk(asked.loanId)).stage, "APPROVED");
  const after = await loan(asked.loanId);
  assert.equal(after.status, "ACTIVE");
  assert.ok(after.approvedById, "the approver is on record");
  const own = await as("EMPLOYEE", () => loans.listMyLoans({ tenantId: company, employeeId: people.EMPLOYEE.id }));
  assert.ok(own.items.some((l) => l.id === asked.loanId));
  assert.ok(own.items.every((l) => l.employeeId === people.EMPLOYEE.id), "only their own");
  const others = await as("OTHER", () => loans.listMyLoans({ tenantId: company, employeeId: people.OTHER.id }));
  assert.ok(others.items.every((l) => l.employeeId === people.OTHER.id), "nobody else's");
});

test("a rejected request lends nothing", async () => {
  await once();
  await db((tx) => tx.loan.updateMany({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, status: "ACTIVE" }, data: { status: "PAID_OFF" } }).catch(() => {}));
  const asked = await mine();
  const done = await walk(asked.loanId, "REJECT");
  assert.equal(done.stage, "REJECTED");
  assert.equal((await loan(asked.loanId)).status, "REJECTED");
});

test("HR raises a loan for an employee: interest allowed, filed on their behalf, still needs the final approval", async () => {
  await once();
  await clear();
  const made = await byHr({ interestRatePct: 10, tenureMonths: 10, principalMinor: 10000000 });
  assert.equal(made.status, "PENDING");
  assert.equal(made.monthlyInstallmentMinor, Math.ceil((10000000 + Math.round(10000000 * 0.1 * (10 / 12))) / 10));
  const ar = await approvalOf(made.id);
  assert.ok(ar);
  assert.ok(["LINE_MANAGER", "MANAGEMENT"].includes(ar.stage), "filed on the employee's behalf, it starts at their manager, or past HR when they have none");
  assert.equal((await loan(made.id)).status, "PENDING");
  assert.equal((await walk(made.id)).stage, "APPROVED");
  assert.equal((await loan(made.id)).status, "ACTIVE");
});

test("the basic checks hold however it is raised", async () => {
  await once();
  await clear();
  const refused = (over, message, how = mine) => assert.rejects(how(over), message);
  await refused({ principalMinor: 0 }, /positive whole number/);
  await refused({ principalMinor: -5 }, /positive whole number/);
  await refused({ principalMinor: 12.5 }, /positive whole number/);
  await refused({ principalMinor: 1e12 }, /too large/);
  await refused({ kind: "LOAN", tenureMonths: 0 }, /Repayment months/);
  await refused({ kind: "LOAN", tenureMonths: 121 }, /Repayment months/);
  await refused({ reason: "  " }, /reason/i);
  await refused({ disbursementDate: "not a date" }, /valid disbursement date/);
  await refused({ disbursementDate: "2090-01-01" }, /more than a year ahead/);
  await refused({ disbursementDate: "1970-01-01" }, /valid disbursement date/);
  await refused({ employeeId: 999999 }, /Employee not found/);
  await refused({ interestRatePct: 5, kind: "ADVANCE" }, /advance cannot carry interest|interest/, byHr);
  await refused({ kind: "ADVANCE", tenureMonths: 3 }, /advance is repaid in one month/, byHr);
  await refused({ interestRatePct: 150 }, /Interest must be between/, byHr);
  await assert.rejects(as("EMPLOYEE", () => loans.requestMyLoan({ tenantId: company, employeeId: null, principalMinor: 1, reason: "x y z" })), /employee account/);
  assert.equal(await db((tx) => tx.loan.count({ where: { tenantId: company, status: "PENDING" } })), 0, "a refused request leaves nothing behind");
});

test("an employee of another company or one who has left cannot be lent to; a second waiting request is refused", async () => {
  await once();
  await clear();
  const foreign = await foreignEmployee();
  await assert.rejects(byHr({ employeeId: foreign }), /Employee not found/);
  await db((tx) => tx.employee.update({ where: { id: people.OTHER.id }, data: { status: "Terminated" } }));
  try {
    await assert.rejects(byHr({ employeeId: people.OTHER.id }), /active employee/);
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.OTHER.id }, data: { status: "Active" } }));
  }
  const first = await mine();
  await assert.rejects(mine(), /already has a salary advance request waiting/);
  await assert.rejects(byHr({ kind: "ADVANCE", tenureMonths: 1, principalMinor: 100 }), /already has a salary advance request waiting/);
  assert.ok(await byHr().catch(() => null), "a loan is a different kind, so it is not a duplicate of the advance");
  await clear();
  assert.ok(first.loanId);
});


test("if the request cannot be opened (someone without the HR grant raising it for another), no pending loan is left behind", async () => {
  await once();
  await clear();
  await assert.rejects(as("OTHER", () => loans.createLoan({ tenantId: company, employeeId: people.EMPLOYEE.id, kind: "LOAN", principalMinor: 100000, tenureMonths: 5, reason: "Raised without the HR grant", createdById: people.OTHER.id, submit: true })));
  assert.equal(await db((tx) => tx.loan.count({ where: { tenantId: company, status: "PENDING" } })), 0);
});

test("HR asking for her own advance: her filing is the HR check and Management alone decides; others still go to HR", async () => {
  await once();
  await clear();
  const own = await as("HR", () => loans.requestMyLoan({ tenantId: company, employeeId: people.HR.id, kind: "ADVANCE", principalMinor: 2000000, tenureMonths: 1, reason: "Own advance, HR manager" }));
  const ar = await approvalOf(own.loanId);
  assert.equal(ar.stage, "MANAGEMENT", "no second HR is needed");
  assert.equal(ar.hrActorCode, people.HR.employee_code, "the trail records her as the HR check");
  await assert.rejects(act("HR", { approvalRef: ar.id, version: ar.version }, "APPROVE"), /./, "she cannot approve her own request");
  assert.equal((await act("MANAGEMENT", { approvalRef: ar.id, version: ar.version }, "APPROVE")).stage, "APPROVED");
  assert.equal((await loan(own.loanId)).status, "ACTIVE");
  await clear();
  const emp = await mine();
  assert.notEqual((await approvalOf(emp.loanId)).stage, "MANAGEMENT", "an ordinary employee's request still goes through the earlier stages");
  await clear();
});

test("Management asking for her own advance is approved at once, with the reason on the trail", async () => {
  await once();
  await clear();
  const own = await as("MANAGEMENT", () => loans.requestMyLoan({ tenantId: company, employeeId: people.MANAGEMENT.id, kind: "ADVANCE", principalMinor: 1500000, tenureMonths: 1, reason: "Own advance, Management" }));
  const ar = await approvalOf(own.loanId);
  assert.equal(ar.stage, "APPROVED");
  assert.equal((await loan(own.loanId)).status, "ACTIVE");
  const trail = await db((tx) => tx.hrApprovalAudit.findMany({ where: { approvalRef: ar.id } }));
  assert.ok(trail.some((t) => /no further approval needed/.test(t.reason)), "the trail says why");
});
