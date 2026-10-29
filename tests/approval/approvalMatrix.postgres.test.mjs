// Configurable approval matrices (ATTENDANCE and PAYROLL kept separate), end to end against
// PostgreSQL: draft -> publish -> a submission seals the route -> levels, assigned approvers, returns,
// thresholds, in-flight routes, and the fixed stages for everything without a published matrix.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const { prisma, company, other, people, db, as, fixture, submit, act, setup } = await import("./fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { submitApproval, listApprovals } = await import("../../src/services/approval/service.js");
const matrix = await import("../../src/services/approvalMatrix.service.js");

const tenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, fn);
const call = (fn, args, tenantId = company) => tenant(tenantId, () => fn({ tenantId, actorId: "test", ...args }));
const level = (name, action, who, extra = {}) => ({
  name, action, approverMode: "NAMED", approverIds: [people[who].id], ...extra,
});
const publish = async (kind, levels, reason = "test route") => {
  await call(matrix.saveApprovalMatrixDraft, { kind, levels });
  return call(matrix.publishApprovalMatrix, { kind, reason });
};
const retire = (kind) => call(matrix.retireApprovalMatrix, { kind, reason: "back to fixed stages" });
let months = 0;
const payrollRun = (processedBy, totalNet = 100) => {
  const n = ++months;
  const start = new Date(Date.UTC(2031 + Math.floor(n / 12), n % 12, 1));
  return db((tx) =>
    tx.payrollRun.create({
      data: {
        tenantId: company, processedBy, periodStart: start, periodEnd: new Date(+start + 3600000),
        countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: totalNet, totalNet,
      },
    }),
  );
};
const submitPayroll = (who, run) =>
  as(who, () =>
    submitApproval({
      kind: "PAYROLL", sourceRef: String(run.id), employeeCode: people[who].employee_code,
      expectedVersion: 0, reason: `${who} submits the calculated payroll`, requestKey: randomUUID(),
    }),
  ).then((r) => r.record);
const queue = (who) =>
  as(who, () => listApprovals({ scope: "QUEUE", kind: "PAYROLL", limit: 50 })).then((r) => r.items);

await setup();
// Extra people for routes that need distinct approvers.
for (const role of ["HR2", "MANAGEMENT2"])
  people[role] = await db((tx) =>
    tx.employee.create({
      data: {
        tenant_id: company, employee_code: "EMP-" + role, employeeCategory: "EMPLOYEE",
        userId: 100000 + Math.floor(Math.random() * 1e8), first_name: "Fictional", status: "Active",
        employement_status: "Active", hire_date: new Date("2026-01-01"),
      },
    }),
  );

test("matrices: draft, publish, supersede, retire; ATTENDANCE and PAYROLL are independent", async (t) => {
  assert.equal((await call(matrix.getApprovalMatrix, { kind: "PAYROLL" })).usingFixedStages, true);
  await t.test("rules are enforced when saving", async () => {
    const bad = (levels, re, kind = "PAYROLL") =>
      assert.rejects(call(matrix.saveApprovalMatrixDraft, { kind, levels }), re);
    await bad([level("Verify", "VERIFY", "HR")], /last level must approve/);
    await bad([level("Approve", "APPROVE", "MANAGEMENT"), level("Approve 2", "APPROVE", "MANAGEMENT2")], /only the last level can approve/);
    await bad([{ name: "HR", action: "VERIFY", approverMode: "NAMED", approverIds: [] }, level("M", "APPROVE", "MANAGEMENT")], /assign at least one approver/);
    await bad([level("M", "APPROVE", "MANAGEMENT", { satisfiedByInitiator: true })], /cannot be satisfied by the initiator/);
    await bad([level("M", "APPROVE", "MANAGEMENT", { thresholdAmount: 5 })], /always required|required level cannot/);
    await bad([level("HR", "VERIFY", "HR", { required: false, thresholdAmount: 5 }), level("M", "APPROVE", "MANAGEMENT")], /payroll only/, "ATTENDANCE");
    await bad([{ name: "M", action: "APPROVE", approverMode: "NAMED", approverIds: [999999] }], /not in this company/);
    await bad([level("M", "APPROVE", "MANAGEMENT")], /No approval matrix for LEAVE/, "LEAVE");
    await db((tx) => tx.employee.update({ where: { id: people.HR2.id }, data: { status: "Inactive", employement_status: "Terminated" } }));
    await bad([level("HR", "VERIFY", "HR2"), level("M", "APPROVE", "MANAGEMENT")], /is not active/);
    await db((tx) => tx.employee.update({ where: { id: people.HR2.id }, data: { status: "Active", employement_status: "Active" } }));
  });
  await t.test("publishing one kind leaves the other on the fixed stages", async () => {
    const v1 = await publish("PAYROLL", [level("Management", "APPROVE", "MANAGEMENT")]);
    assert.equal(v1.published.version, 1);
    assert.equal(v1.usingFixedStages, false);
    assert.equal((await call(matrix.getApprovalMatrix, { kind: "ATTENDANCE" })).usingFixedStages, true);
    const v2 = await publish("PAYROLL", [level("HR", "VERIFY", "HR", { satisfiedByInitiator: true }), level("Management", "APPROVE", "MANAGEMENT")]);
    assert.equal(v2.published.version, 2);
    assert.deepEqual(v2.history.map((h) => h.version), [1]);
  });
  await t.test("a published route is immutable and nothing is shared across companies", async () => {
    await assert.rejects(
      db((tx) => tx.approvalMatrix.updateMany({ where: { tenantId: company, kind: "PAYROLL", status: "PUBLISHED" }, data: { levels: [] } })),
      /immutable|check/i,
    );
    await assert.rejects(db((tx) => tx.approvalMatrix.deleteMany({ where: { tenantId: company, status: "PUBLISHED" } })), /cannot be deleted/i);
    assert.equal((await call(matrix.getApprovalMatrix, { kind: "PAYROLL" }, other)).usingFixedStages, true);
  });
  await t.test("publishing needs a draft and a reason; retiring returns to the fixed stages", async () => {
    await assert.rejects(call(matrix.publishApprovalMatrix, { kind: "PAYROLL", reason: "x" }), /Save a draft/);
    await call(matrix.saveApprovalMatrixDraft, { kind: "PAYROLL", levels: [level("M", "APPROVE", "MANAGEMENT")] });
    await assert.rejects(call(matrix.publishApprovalMatrix, { kind: "PAYROLL", reason: " " }), /reason/);
    await call(matrix.discardApprovalMatrixDraft, { kind: "PAYROLL" });
    assert.equal((await retire("PAYROLL")).usingFixedStages, true);
    await assert.rejects(retire("PAYROLL"), /No approval matrix is published/);
  });
});

test("PAYROLL: HR initiates, Management decides (the HR step is satisfied by the initiator)", async (t) => {
  await publish("PAYROLL", [level("HR check", "VERIFY", "HR", { satisfiedByInitiator: true }), level("Management", "APPROVE", "MANAGEMENT")]);
  const run = await payrollRun(people.HR.id);
  let row = await submitPayroll("HR", run);
  assert.equal(row.stage, "LEVEL");
  assert.equal(row.level, 1);
  assert.deepEqual(row.pendingCodes, [people.MANAGEMENT.employee_code]);
  assert.deepEqual(row.route.levels.map((l) => [l.name, l.auto]), [["HR check", true], ["Management", false]]);
  assert.deepEqual(row.history.map((h) => h.action), ["SUBMIT", "VERIFY"]);
  assert.equal(row.history[0].toStage, "LEVEL 1: HR check");
  assert.equal(row.history[1].toStage, "LEVEL 2: Management");
  await t.test("only the assigned approver can act, and not the initiator", async () => {
    assert.deepEqual((await as("HR", () => listApprovals({ scope: "QUEUE", kind: "PAYROLL", limit: 50 })).then((r) => r.items)).filter((i) => i.sourceRef === String(run.id)), []);
    assert.ok((await queue("MANAGEMENT")).some((i) => i.sourceRef === String(run.id)));
    await assert.rejects(act("HR", row, "APPROVE"), /cannot perform this action/);
    await assert.rejects(act("EMPLOYEE", row, "APPROVE"), /cannot perform this action|not found/i);
    const seen = await as("MANAGEMENT", () => listApprovals({ scope: "QUEUE", kind: "PAYROLL", limit: 50 })).then((r) => r.items.find((i) => i.sourceRef === String(run.id)));
    assert.deepEqual(seen.actions, []); // summaries carry no actions; the read below does
  });
  await t.test("Management approves", async () => {
    const approved = await act("MANAGEMENT", row, "APPROVE");
    assert.equal(approved.stage, "APPROVED");
    assert.equal(approved.history.at(-1).fromStage, "LEVEL 2: Management");
    assert.equal(approved.route.current, null);
  });
  await t.test("Management can reject, and the source records the decision", async () => {
    const second = await submitPayroll("HR", await payrollRun(people.HR.id));
    const rejected = await act("MANAGEMENT", second, "REJECT");
    assert.equal(rejected.stage, "REJECTED");
  });
  await t.test("returning from the deciding level goes back to the initiator (the HR step was automatic)", async () => {
    const third = await submitPayroll("HR", await payrollRun(people.HR.id));
    const returned = await act("MANAGEMENT", third, "REVERT");
    assert.equal(returned.stage, "INITIATOR");
    assert.equal(returned.level, null);
    const again = await as("HR", () =>
      submitApproval({ kind: "PAYROLL", sourceRef: third.sourceRef, employeeCode: people.HR.employee_code, expectedVersion: returned.version, reason: "Corrected", requestKey: randomUUID() }),
    ).then((r) => r.record);
    assert.equal(again.stage, "LEVEL");
    assert.equal(again.round, 2);
  });
});

test("PAYROLL: a required level nobody can act on blocks the submission with a clear message", async () => {
  await publish("PAYROLL", [level("HR only", "VERIFY", "HR"), level("Management", "APPROVE", "MANAGEMENT")]);
  // HR is the only approver of a required level and is also the initiator.
  await assert.rejects(submitPayroll("HR", await payrollRun(people.HR.id)), /no active approver other than the initiator/);
});

test("PAYROLL: optional levels follow the amount threshold", async () => {
  await publish("PAYROLL", [
    level("Finance check", "VERIFY", "HR2", { required: false, thresholdAmount: 1000 }),
    level("Management", "APPROVE", "MANAGEMENT"),
  ]);
  const small = await submitPayroll("HR", await payrollRun(people.HR.id, 100));
  assert.equal(small.level, 1);
  assert.equal(small.route.levels[0].skipped, "BELOW_THRESHOLD");
  const big = await submitPayroll("HR", await payrollRun(people.HR.id, 5000));
  assert.equal(big.level, 0);
  assert.deepEqual(big.pendingCodes, [people.HR2.employee_code]);
});

test("a request keeps the route it was submitted under; new submissions follow the new matrix", async () => {
  await publish("PAYROLL", [level("Management", "APPROVE", "MANAGEMENT")]);
  const inFlight = await submitPayroll("HR", await payrollRun(people.HR.id));
  const v1 = inFlight.route.matrixVersion;
  await publish("PAYROLL", [level("Management 2", "APPROVE", "MANAGEMENT2")]);
  const fresh = await submitPayroll("HR", await payrollRun(people.HR.id));
  assert.equal(fresh.route.matrixVersion, v1 + 1);
  assert.deepEqual(fresh.pendingCodes, [people.MANAGEMENT2.employee_code]);
  const still = await as("MANAGEMENT", () => listApprovals({ scope: "QUEUE", kind: "PAYROLL", limit: 50 })).then((r) => r.items.find((i) => i.approvalRef === inFlight.approvalRef));
  assert.deepEqual(still.pendingCodes, [people.MANAGEMENT.employee_code]);
  assert.equal((await act("MANAGEMENT", inFlight, "APPROVE")).stage, "APPROVED");
});

test("ATTENDANCE: a three-level route with the employee's line manager, a return and the HR verification", async (t) => {
  await publish("ATTENDANCE", [
    { name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER" },
    level("HR verification", "VERIFY", "HR"),
    level("Management", "APPROVE", "MANAGEMENT"),
  ]);
  const s = await fixture("ATTENDANCE");
  let row = await submit(s);
  assert.equal(row.stage, "LEVEL");
  assert.equal(row.level, 0);
  assert.deepEqual(row.pendingCodes, [people.MANAGER.employee_code]);
  await t.test("people outside the current level cannot act", async () => {
    await assert.rejects(act("HR", row, "VERIFY"), /cannot perform this action/);
    await assert.rejects(act("MANAGEMENT", row, "APPROVE"), /cannot perform this action/);
  });
  row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
  assert.equal(row.level, 1);
  assert.equal(row.recommendation, "RECOMMEND_APPROVAL");
  await t.test("HR returns it to the manager, who recommends again", async () => {
    row = await act("HR", row, "REVERT");
    assert.equal(row.stage, "LEVEL");
    assert.equal(row.level, 0);
    row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
    assert.equal(row.level, 1);
  });
  row = await act("HR", row, "VERIFY");
  assert.equal(row.level, 2);
  const done = await act("MANAGEMENT", row, "APPROVE");
  assert.equal(done.stage, "APPROVED");
  assert.deepEqual(done.history.map((h) => h.action), ["SUBMIT", "RECOMMEND_APPROVAL", "REVERT", "RECOMMEND_APPROVAL", "VERIFY", "APPROVE"]);
  assert.equal(done.history[0].toStage, "LEVEL 1: Line manager");
});

test("ATTENDANCE: a changed line manager invalidates the recommendation level", async () => {
  await publish("ATTENDANCE", [
    { name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER" },
    level("Management", "APPROVE", "MANAGEMENT"),
  ]);
  const row = await submit(await fixture("ATTENDANCE"));
  await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { managerId: people.HR.id } }));
  try {
    await assert.rejects(act("MANAGER", row, "RECOMMEND_APPROVAL"), /line manager changed/);
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { managerId: people.MANAGER.id } }));
  }
});

test("a paused line-manager level stays in the route but is skipped; un-pausing switches it on", async () => {
  const route = (paused) => [
    { name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER", required: false, paused },
    level("HR verification", "VERIFY", "HR"),
    level("Management", "APPROVE", "MANAGEMENT"),
  ];
  await publish("ATTENDANCE", route(true));
  const paused = await submit(await fixture("ATTENDANCE"));
  assert.equal(paused.stage, "LEVEL");
  assert.equal(paused.level, 1);
  assert.deepEqual(paused.pendingCodes, [people.HR.employee_code]);
  assert.deepEqual(paused.route.levels.map((l) => [l.name, l.engaged, l.skipped]), [
    ["Line manager", false, "PAUSED"], ["HR verification", true, null], ["Management", true, null],
  ]);
  assert.equal(paused.history[0].toStage, "LEVEL 2: HR verification");
  await assert.rejects(act("MANAGER", paused, "RECOMMEND_APPROVAL"), /cannot perform this action/);
  // Un-pause: the employee's own manager (dynamic) is asked first.
  await publish("ATTENDANCE", route(false));
  const live = await submit(await fixture("ATTENDANCE"));
  assert.equal(live.level, 0);
  assert.deepEqual(live.pendingCodes, [people.MANAGER.employee_code]);
  // An employee without a manager skips the optional level instead of blocking.
  await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { managerId: null } }));
  try {
    const noManager = await submit(await fixture("ATTENDANCE"));
    assert.equal(noManager.route.levels[0].skipped, "NO_APPROVER");
    assert.equal(noManager.level, 1);
  } finally {
    await db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { managerId: people.MANAGER.id } }));
  }
  await assert.rejects(call(matrix.saveApprovalMatrixDraft, { kind: "ATTENDANCE", levels: [level("Management", "APPROVE", "MANAGEMENT", { paused: true })] }), /cannot be paused/);
});

test("without a published matrix both kinds keep the four fixed stages (nothing in flight changes)", async () => {
  await retire("ATTENDANCE");
  await retire("PAYROLL");
  const attendance = await submit(await fixture("ATTENDANCE"));
  assert.equal(attendance.stage, "HR"); // the manager stage stays paused for attendance
  assert.equal(attendance.route, null);
  const payroll = await submit(await fixture("PAYROLL"));
  assert.equal(payroll.stage, "LINE_MANAGER");
  assert.equal(payroll.level, null);
  assert.equal((await act("MANAGER", payroll, "RECOMMEND_APPROVAL")).stage, "HR");
});

test.after(async () => {
  await prisma.$disconnect();
});
