// Leave against PostgreSQL: balances move only through the ledger (accruals once per period, carry-over, leave taken,
// restore), a request that needs more days than the balance is approved only with a note or as an unpaid type, and
// leave types, balance changes and cancelling approved leave are requests that the attendance route approves.
import test from "node:test";
import assert from "node:assert/strict";
import { f, company, other, people, db, as, act, prisma, ensure, publishRoute, decide, approvalOf } from "./route-fixture.mjs";
const svc = await import("../../src/services/leaveChangeRequest.service.js");
const ledger = await import("../../src/services/leaveLedger.service.js");
const leave = await import("../../src/services/leave.service.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");

const hr = (fn) => as("BOTH", fn);
const asker = () => ({ tenantId: company, requestedById: people.BOTH.id });
const policies = () => db((tx) => tx.leavePolicy.findMany({ where: { tenantId: company }, orderBy: { id: "asc" } }));
const policyNamed = async (name) => (await policies()).find((p) => p.name === name);
const entries = (where = {}) => db((tx) => tx.leaveBalanceLedger.findMany({ where: { tenantId: company, ...where }, orderBy: { id: "asc" } }));
const balanceOf = async (employeeId, leavePolicyId) =>
  (await db((tx) => tx.leaveBalance.findUnique({ where: { employeeId_leavePolicyId: { employeeId, leavePolicyId } } })))?.balance ?? 0;
const setBalance = (employeeId, leavePolicyId, balance) =>
  db((tx) => tx.leaveBalance.upsert({ where: { employeeId_leavePolicyId: { employeeId, leavePolicyId } }, create: { tenantId: company, employeeId, leavePolicyId, balance }, update: { balance } }));
const run = (fn) => hr(() => fn());
const mkPolicy = (data) => db((tx) => tx.leavePolicy.create({ data: { tenantId: company, createdById: people.HR.id, ...data } }));
const noJobs = () => db((tx) => tx.attendanceEvaluationJob.deleteMany({ where: { tenantId: company } }));
const rejectWaiting = async (kind, id) => {
  const ar = await approvalOf(kind, id);
  const rec = { approvalRef: ar.id, version: ar.version };
  await act("MANAGEMENT", rec, "REJECT").catch(() => act("HR", rec, "REJECT"));
};

test("accruals: a dry run writes nothing, a real run credits once per period, however often it is repeated", async () => {
  await ensure();
  const monthly = await mkPolicy({ name: "Monthly", leaveTypeCode: "CASUAL", accrualPeriod: "MONTHLY", accrualRate: 2 });
  const late = await mkPolicy({ name: "Needs service", leaveTypeCode: "OTHER", accrualPeriod: "MONTHLY", accrualRate: 1, minServiceMonths: 600 });
  const ask = { tenantId: company, accrualDate: "2026-11-15", policyIds: [monthly.id, late.id] };

  const dry = await run(() => ledger.runAccruals(ask));
  assert.equal(dry.dryRun, true);
  assert.ok(dry.credited > 0, "the dry run lists who would be credited");
  assert.equal((await entries()).length, 0, "and writes nothing");
  assert.ok(dry.details.every((d) => d.policyId === monthly.id), "a type nobody has served long enough for credits no one");

  const first = await run(() => ledger.runAccruals({ ...ask, dryRun: false }));
  assert.equal(first.credited, dry.credited);
  const written = await entries();
  assert.equal(written.length, first.credited);
  assert.ok(written.every((e) => e.kind === "ACCRUAL" && e.days === 2 && e.idempotencyKey.startsWith(`ACCRUAL:${monthly.id}:`)));
  assert.equal(await balanceOf(people.EMPLOYEE.id, monthly.id), 2);

  const again = await run(() => ledger.runAccruals({ ...ask, dryRun: false }));
  assert.equal(again.credited, 0, "a second run credits nobody");
  assert.equal((await entries()).length, written.length);
  assert.equal(await balanceOf(people.EMPLOYEE.id, monthly.id), 2);

  const nextMonth = await run(() => ledger.runAccruals({ ...ask, accrualDate: "2026-12-01", dryRun: false }));
  assert.equal(nextMonth.credited, first.credited, "the next period credits again");
  assert.equal(await balanceOf(people.EMPLOYEE.id, monthly.id), 4);
});

test("accruals: only active people, status spelled either way, and nobody from another company", async () => {
  await ensure();
  const policy = await mkPolicy({ name: "Active only", leaveTypeCode: "CASUAL", accrualPeriod: "MONTHLY", accrualRate: 1 });
  await db((tx) => tx.employee.update({ where: { id: people.OTHER.id }, data: { status: "Inactive" } }));
  await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { status: "ACTIVE" } }));
  try {
    const result = await run(() => ledger.runAccruals({ tenantId: company, accrualDate: "2026-11-15", policyIds: [policy.id], dryRun: false }));
    const ids = result.details.map((d) => d.employeeId);
    assert.ok(ids.includes(people.EMPLOYEE.id), "ACTIVE and Active both count");
    assert.ok(!ids.includes(people.OTHER.id), "an inactive person is not credited");
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.OTHER.id }, data: { status: "Active" } }));
    await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { status: "Active" } }));
  }
  const foreign = await mcpCtx.run({ user: { tenantId: other } }, () => ledger.runAccruals({ tenantId: other, accrualDate: "2026-11-15", dryRun: false }));
  assert.equal(foreign.details.length, 0, "another company has no leave types, so nothing is credited");
  assert.equal((await entries({ idempotencyKey: { contains: `:${policy.id}:` } })).filter((e) => e.tenantId !== company).length, 0);
});

test("annual credit lands once, in the month of the hire anniversary", async () => {
  await ensure();
  const policy = await mkPolicy({ name: "Yearly", leaveTypeCode: "ANNUAL", accrualPeriod: "ANNUAL", accrualRate: 14 });
  await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { hire_date: new Date("2025-11-03") } }));
  try {
    const wrongMonth = await run(() => ledger.runAccruals({ tenantId: company, accrualDate: "2026-10-20", policyIds: [policy.id], dryRun: false }));
    assert.ok(!wrongMonth.details.some((d) => d.employeeId === people.EMPLOYEE.id), "not in another month");
    const right = await run(() => ledger.runAccruals({ tenantId: company, accrualDate: "2026-11-20", policyIds: [policy.id], dryRun: false }));
    assert.equal(right.details.find((d) => d.employeeId === people.EMPLOYEE.id)?.days, 14);
    const repeat = await run(() => ledger.runAccruals({ tenantId: company, accrualDate: "2026-11-02", policyIds: [policy.id], dryRun: false }));
    assert.equal(repeat.credited, 0, "the same anniversary year is never credited twice");
    assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 14);
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { hire_date: new Date("2026-01-01") } }));
  }
});

test("carry-over keeps up to the limit and expires the rest, once a year", async () => {
  await ensure();
  const policy = await mkPolicy({ name: "Carry", leaveTypeCode: "ANNUAL", carryForwardAllowed: true, maxCarryForward: 5 });
  await setBalance(people.EMPLOYEE.id, policy.id, 8);
  await setBalance(people.OTHER.id, policy.id, 3);
  const dry = await run(() => ledger.runCarryOver({ tenantId: company, effectiveDate: "2026-12-31", policyIds: [policy.id] }));
  assert.deepEqual(dry.details.map((d) => [d.employeeId, d.carried, d.expired]).sort(), [[people.EMPLOYEE.id, 5, 3], [people.OTHER.id, 3, 0]].sort());
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 8, "a dry run changes nothing");
  await run(() => ledger.runCarryOver({ tenantId: company, effectiveDate: "2026-12-31", policyIds: [policy.id], dryRun: false }));
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 5);
  assert.equal(await balanceOf(people.OTHER.id, policy.id), 3);
  const kept = await db((tx) => tx.leaveBalance.findUnique({ where: { employeeId_leavePolicyId: { employeeId: people.EMPLOYEE.id, leavePolicyId: policy.id } } }));
  assert.equal(kept.carryOverBalance, 5);
  assert.deepEqual((await entries({ leavePolicyId: policy.id, employeeId: people.EMPLOYEE.id })).map((e) => [e.kind, e.days]), [["EXPIRED", -3]]);
  await run(() => ledger.runCarryOver({ tenantId: company, effectiveDate: "2026-12-31", policyIds: [policy.id], dryRun: false }));
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 5, "a repeat does not expire more");
});

test("the ledger cannot be edited or deleted, and a repeated key is applied once even in parallel", async () => {
  await ensure();
  const policy = await mkPolicy({ name: "Ledger rules", leaveTypeCode: "CASUAL" });
  const post = () => db((tx) => ledger.postLedger(tx, { tenantId: company, employeeId: people.EMPLOYEE.id, leavePolicyId: policy.id, kind: "ADJUSTMENT", days: 1, key: "PARALLEL:1", reason: "race" }));
  const results = await Promise.all([post(), post(), post()]);
  assert.equal(results.filter((r) => r.applied).length, 1);
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 1);
  await assert.rejects(db((tx) => tx.leaveBalanceLedger.updateMany({ where: { tenantId: company }, data: { days: 99 } })), /cannot be edited/);
  await assert.rejects(db((tx) => tx.leaveBalanceLedger.deleteMany({ where: { tenantId: company } })), /cannot be edited/);
});

test("leave that needs more days than the balance: a note approves it as an overdraft, an unpaid type needs none", async () => {
  await ensure();
  const paid = await policyNamed("Annual");
  const approveFully = async (source, extra) => {
    let row = await f.submit(source);
    row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
    row = await act("HR", row, "VERIFY");
    return act("MANAGEMENT", row, "APPROVE", extra);
  };
  // Enough balance: taken from the balance.
  await setBalance(people.EMPLOYEE.id, paid.id, 10);
  const enough = await f.fixture("LEAVE");
  assert.equal((await approveFully(enough)).stage, "APPROVED");
  assert.equal(await balanceOf(people.EMPLOYEE.id, paid.id), 9);
  assert.deepEqual((await entries({ idempotencyKey: `LEAVE:${enough.row.id}` })).map((e) => [e.kind, e.days, e.balanceAfter]), [["LEAVE_TAKEN", -1, 9]]);

  // Not enough: refused without a note, nothing written.
  await setBalance(people.EMPLOYEE.id, paid.id, 0);
  const short = await f.fixture("LEAVE");
  let row = await f.submit(short);
  row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
  row = await act("HR", row, "VERIFY");
  await assert.rejects(act("MANAGEMENT", row, "APPROVE", { reason: "" }), /balance is 0 days and this leave needs 1/i);
  assert.equal(await balanceOf(people.EMPLOYEE.id, paid.id), 0);
  assert.equal((await entries({ idempotencyKey: `LEAVE:${short.row.id}` })).length, 0);
  // With a note: approved, recorded as an overdraft.
  assert.equal((await act("MANAGEMENT", row, "APPROVE", { reason: "Family emergency, advance against next year" })).stage, "APPROVED");
  assert.equal(await balanceOf(people.EMPLOYEE.id, paid.id), -1);
  const overdraft = (await entries({ idempotencyKey: `LEAVE:${short.row.id}` }))[0];
  assert.equal(overdraft.kind, "OVERDRAFT");
  assert.match(overdraft.reason, /Family emergency/);

  // An unpaid type never touches a balance.
  const unpaid = await mkPolicy({ name: "Unpaid leave", leaveTypeCode: "UNPAID" });
  const free = await f.fixture("LEAVE");
  await db((tx) => tx.leaveRequest.update({ where: { id: free.row.id }, data: { leavePolicyId: unpaid.id } }));
  assert.equal((await approveFully(free, { reason: "" })).stage, "APPROVED");
  assert.equal(await balanceOf(people.EMPLOYEE.id, unpaid.id), 0);
  assert.equal((await entries({ idempotencyKey: `LEAVE:${free.row.id}` })).length, 0);
});

test("leave types: filed with a reason, validated, applied only on approval, whitelisted fields only", async () => {
  await ensure();
  await assert.rejects(run(() => svc.requestPolicyCreate({ ...asker(), name: "Study", accrualPeriod: "NONE", reason: "New type" })), /Publish the attendance approval route/);
  assert.equal(await db((tx) => tx.leaveChangeRequest.count({ where: { tenantId: company } })), 0, "no orphan request");
  await publishRoute();
  const bad = (over, pattern) => assert.rejects(run(() => svc.requestPolicyCreate({ ...asker(), name: "Study", accrualPeriod: "NONE", reason: "New type", ...over })), pattern);
  await bad({ reason: " " }, /reason/i);
  await bad({ name: "  " }, /name/i);
  await bad({ accrualPeriod: "WEEKLY" }, /period/i);
  await bad({ accrualRate: -1 }, /between 0 and 366/);
  await bad({ accrualRate: 1000 }, /between 0 and 366/);
  await bad({ minServiceMonths: 1.5 }, /whole number/);
  await bad({ carryForwardAllowed: true, maxCarryForward: 0 }, /limit above 0/);
  await bad({ carryForwardAllowed: false, maxCarryForward: 3 }, /must be 0/);
  await bad({ name: "annual" }, /already exists/);
  assert.equal(await db((tx) => tx.leaveChangeRequest.count({ where: { tenantId: company } })), 0);

  const filed = await run(() => svc.requestPolicyCreate({ ...asker(), name: "Study leave", leaveTypeCode: "study", accrualPeriod: "ANNUAL", accrualRate: 5, reason: "Exam leave for staff", tenant_id: "x", createdById: 1 }));
  assert.equal(filed.pendingApproval, true);
  assert.equal(await policyNamed("Study leave"), undefined, "not created while the request waits");
  await assert.rejects(run(() => svc.requestPolicyCreate({ ...asker(), name: "STUDY LEAVE", accrualPeriod: "NONE", reason: "again" })), /already has a change waiting/);
  assert.equal((await run(() => svc.listPendingLeaveChanges({ tenantId: company })))[0].requestedByName != null, true);
  assert.equal((await decide("LEAVE_CHANGE", filed.requestId)).stage, "APPROVED");
  const made = await policyNamed("Study leave");
  assert.equal(made.tenantId, company);
  assert.equal(made.leaveTypeCode, "STUDY");
  assert.equal(made.createdById, people.BOTH.id, "the filer, not whatever the payload claimed");
});

test("changing a leave type: stale version refused, applied on approval, version moves, direct writers are closed", async () => {
  await ensure();
  const policy = await policyNamed("Study leave");
  const ask = (over = {}) => run(() => svc.requestPolicyUpdate({ ...asker(), id: policy.id, reason: "Raise the yearly credit", accrualRate: 7, ...over }));
  await assert.rejects(ask({ expectedVersion: 99 }), /changed; refresh/);
  await assert.rejects(ask({ accrualRate: 5 }), /Nothing changed/);
  await assert.rejects(ask({ id: 999999 }), /not found/);
  const filed = await ask({ expectedVersion: policy.version, name: "Study leave (paid)", tenant_id: "forged", version: 40 });
  assert.equal((await policyNamed("Study leave")).accrualRate, 5, "unchanged while waiting");
  // Someone else changes the same type before the approval lands.
  await db((tx) => tx.leavePolicy.update({ where: { id: policy.id }, data: { description: "edited meanwhile", version: { increment: 1 } } }));
  await assert.rejects(decide("LEAVE_CHANGE", filed.requestId), /changed after the request was filed/);
  await rejectWaiting("LEAVE_CHANGE", filed.requestId);
  const fresh = await policyNamed("Study leave");
  const again = await ask({ expectedVersion: fresh.version, accrualRate: 7 });
  assert.equal((await decide("LEAVE_CHANGE", again.requestId)).stage, "APPROVED");
  const after = await policyNamed("Study leave");
  assert.equal(after.accrualRate, 7);
  assert.equal(after.version, fresh.version + 1);
  assert.equal(after.tenantId, company, "a forged tenant in the payload changes nothing");
  assert.equal(after.updatedById, people.BOTH.id);

  for (const [name, fn] of [
    ["createLeavePolicy", () => leave.createLeavePolicy({ name: "x", accrualPeriod: "NONE" }, people.HR.id)],
    ["updateLeavePolicy", () => leave.updateLeavePolicy(policy.id, { accrualRate: 1 }, people.HR.id)],
    ["deleteLeavePolicy", () => leave.deleteLeavePolicy(policy.id, people.HR.id)],
    ["updateLeaveBalance", () => leave.updateLeaveBalance(people.EMPLOYEE.id, { leavePolicyId: policy.id, balance: 99 })],
    ["runLeaveAccruals", () => leave.runLeaveAccruals({})],
    ["processCarryOver", () => leave.processCarryOver({})],
  ]) await assert.rejects(hr(fn), /not directly/, `${name} is closed`);
});

test("removing a leave type: refused while it has balances or leave, otherwise applied on approval", async () => {
  await ensure();
  const used = await policyNamed("Annual");
  await assert.rejects(run(() => svc.requestPolicyDelete({ ...asker(), id: used.id, reason: "Cleanup" })), /has leave requests|has balances/);
  const spare = await mkPolicy({ name: "Spare type", leaveTypeCode: "OTHER" });
  const filed = await run(() => svc.requestPolicyDelete({ ...asker(), id: spare.id, reason: "Not used any more" }));
  assert.ok(await policyNamed("Spare type"));
  assert.equal((await decide("LEAVE_CHANGE", filed.requestId)).stage, "APPROVED");
  assert.equal(await policyNamed("Spare type"), undefined);
});

test("a balance change is a request: ledger entry on approval, refused if the balance moved meanwhile", async () => {
  await ensure();
  const policy = await mkPolicy({ name: "Balance type", leaveTypeCode: "CASUAL" });
  const ask = (over = {}) => run(() => svc.requestBalanceSet({ ...asker(), employeeId: people.EMPLOYEE.id, leavePolicyId: policy.id, balance: 12, reason: "Opening balance from the old system", ...over }));
  await assert.rejects(ask({ balance: "abc" }), /number of days/);
  await assert.rejects(ask({ balance: 5000 }), /between -366 and 1000/);
  await assert.rejects(ask({ balance: 0 }), /already this value/);
  await assert.rejects(ask({ employeeId: 999999 }), /Employee not found/);
  await assert.rejects(ask({ leavePolicyId: 999999 }), /Leave type not found/);
  await assert.rejects(ask({ reason: "" }), /reason/i);
  const filed = await ask();
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 0, "nothing changes while it waits");
  await assert.rejects(ask({ balance: 13 }), /already has a change waiting/);
  assert.equal((await decide("LEAVE_CHANGE", filed.requestId)).stage, "APPROVED");
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 12);
  const entry = (await entries({ leavePolicyId: policy.id }))[0];
  assert.deepEqual([entry.kind, entry.days, entry.balanceAfter, entry.sourceRef], ["ADJUSTMENT", 12, 12, filed.requestId]);
  assert.match(entry.reason, /Opening balance/);

  const second = await ask({ balance: 3 });
  await db((tx) => ledger.postLedger(tx, { tenantId: company, employeeId: people.EMPLOYEE.id, leavePolicyId: policy.id, kind: "ACCRUAL", days: 2, key: "MID:1", reason: "accrual landed meanwhile" }));
  await assert.rejects(decide("LEAVE_CHANGE", second.requestId), /balance changed from 12 to 14/);
  assert.equal(await balanceOf(people.EMPLOYEE.id, policy.id), 14, "the stale request changed nothing");
  await rejectWaiting("LEAVE_CHANGE", second.requestId);
  const history = await run(() => ledger.balanceHistory({ tenantId: company, employeeId: people.EMPLOYEE.id, leavePolicyId: policy.id }));
  assert.deepEqual(history.map((h) => h.kind), ["ACCRUAL", "ADJUSTMENT"], "history is newest first");
});

test("cancelling approved leave restores the days, clears the leave marks and re-queues attendance", async () => {
  await ensure();
  const paid = await policyNamed("Annual");
  await setBalance(people.EMPLOYEE.id, paid.id, 10);
  const source = await f.fixture("LEAVE");
  const approve = async (s) => {
    let row = await f.submit(s);
    row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
    row = await act("HR", row, "VERIFY");
    return act("MANAGEMENT", row, "APPROVE");
  };
  await assert.rejects(run(() => svc.requestCancelLeave({ ...asker(), leaveRequestId: source.row.id, reason: "Came back early" })), /Only approved leave/);
  await approve(source);
  assert.equal(await balanceOf(people.EMPLOYEE.id, paid.id), 9);
  const day = source.row.startDate;
  await db((tx) => tx.attendance.upsert({ where: { tenantId_employeeId_date: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day } }, create: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day, status: "ON_LEAVE", day_credit: 1 }, update: { status: "ON_LEAVE", check_in: null, check_out: null } }));
  await db((tx) => tx.leave.create({ data: { tenantId: company, employeeId: people.EMPLOYEE.id, type: "ANNUAL", start_date: source.row.startDate, end_date: source.row.endDate, total_days: 1, status: "APPROVED" } }));
  await noJobs();

  const filed = await run(() => svc.requestCancelLeave({ ...asker(), leaveRequestId: source.row.id, reason: "Came back early" }));
  assert.equal((await db((tx) => tx.leaveRequest.findUnique({ where: { id: source.row.id } }))).status, "APPROVED", "still approved while the request waits");
  await assert.rejects(run(() => svc.requestCancelLeave({ ...asker(), leaveRequestId: source.row.id, reason: "again" })), /already has a change waiting/);

  assert.equal((await decide("LEAVE_CHANGE", filed.requestId)).stage, "APPROVED");
  assert.equal((await db((tx) => tx.leaveRequest.findUnique({ where: { id: source.row.id } }))).status, "CANCELLED");
  assert.equal(await balanceOf(people.EMPLOYEE.id, paid.id), 10, "the day goes back");
  assert.deepEqual((await entries({ idempotencyKey: `LEAVE_RESTORE:${source.row.id}` })).map((e) => [e.kind, e.days]), [["LEAVE_RESTORED", 1]]);
  assert.equal(await db((tx) => tx.attendance.count({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day, status: "ON_LEAVE" } })), 0, "the leave mark is gone");
  assert.equal(await db((tx) => tx.leave.count({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, start_date: source.row.startDate } })), 0, "and so is the payroll mirror");
  assert.ok((await db((tx) => tx.attendanceEvaluationJob.count({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, state: "PENDING" } }))) >= 1, "the day is re-checked");
  await assert.rejects(run(() => svc.requestCancelLeave({ ...asker(), leaveRequestId: source.row.id, reason: "once more" })), /Only approved leave/, "cancelled leave cannot be cancelled twice");
});

test("the database refuses to cancel approved leave any other way", async () => {
  await ensure();
  const source = await f.fixture("LEAVE");
  let row = await f.submit(source);
  row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
  row = await act("HR", row, "VERIFY");
  await act("MANAGEMENT", row, "APPROVE", { reason: "Approved, with a note in case the balance is short" });
  await assert.rejects(db((tx) => tx.leaveRequest.update({ where: { id: source.row.id }, data: { status: "CANCELLED" } })), /approved leave change/i);
  await assert.rejects(db((tx) => tx.$executeRaw`SELECT set_config('app.hr_leave_cancel', ${`LEAVE_CANCEL:${source.row.id}`}, true)`.then(() => tx.leaveRequest.update({ where: { id: source.row.id }, data: { status: "CANCELLED" } }))), /approved leave change/i, "the setting alone is not enough");
});

test("approved leave cannot be cancelled once a payroll run covers it", async () => {
  await ensure();
  const source = await f.fixture("LEAVE");
  let row = await f.submit(source);
  row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
  row = await act("HR", row, "VERIFY");
  await act("MANAGEMENT", row, "APPROVE", { reason: "Approved with a note in case the balance is short" });
  const payrollRun = await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2099-12-31T00:00:00Z"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  try {
    await assert.rejects(run(() => svc.requestCancelLeave({ ...asker(), leaveRequestId: source.row.id, reason: "Too late" })), /payroll run/i);
  } finally {
    await db((tx) => tx.payrollRun.delete({ where: { id: payrollRun.id } }));
  }
});

test("a leave that starts today is not treated as a past date", async () => {
  await ensure();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
  try {
    await as("EMPLOYEE", () => leave.createLeaveRequest({ employeeId: people.EMPLOYEE.id, startDate: today, endDate: today, reason: "Today" }, people.EMPLOYEE.id, company));
  } catch (error) {
    assert.doesNotMatch(error.message, /past dates/, "it may fail for another reason (a day off, an overlap) but never as 'past'");
  }
});

test("the ledger and requests are invisible to other companies", async () => {
  await ensure();
  assert.ok((await entries()).length > 0);
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, async (tx) => [await tx.leaveBalanceLedger.count(), await tx.leaveChangeRequest.count()], { tenantId: other }));
  assert.deepEqual(seen, [0, 0]);
  assert.equal((await mcpCtx.run({ user: { tenantId: other } }, () => svc.listPendingLeaveChanges({ tenantId: other }))).length, 0);
  await assert.rejects(db((tx) => tx.leaveChangeRequest.updateMany({ where: { tenantId: company }, data: { status: "APPROVED" } })), /staged approval/);
});
