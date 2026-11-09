// X1: publishing/retiring an approval route leaves a structured, append-only audit row in the same
// transaction; concurrent publishes resolve to one winner; broken routes show up in the ops health report.
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
const { prisma, company, other, people, db, setup } = await import("./fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const matrix = await import("../../src/services/approvalMatrix.service.js");
const { opsHealth } = await import("../../src/services/opsHealth.service.js");

let ready; // the fixtures create fixed employee codes: set up once per process
const ensure = () => (ready ||= setup());
const tenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, fn);
const call = (fn, args, tenantId = company) => tenant(tenantId, () => fn({ tenantId, actorId: "u-77", ...args }));
const level = (name, action, who, extra = {}) => ({ name, action, approverMode: "NAMED", approverIds: [people[who].id], ...extra });
const route = (verifier = "HR", approver = "MANAGEMENT") => [level("HR verification", "VERIFY", verifier), level("Management approval", "APPROVE", approver)];
const audits = (action) =>
  db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action }, orderBy: { id: "asc" } }));
const publish = async (kind, levels, reason) => {
  await call(matrix.saveApprovalMatrixDraft, { kind, levels });
  return call(matrix.publishApprovalMatrix, { kind, reason });
};

test("publish and retire write audit rows with old and new routes; failures write none", { timeout: 120000 }, async () => {
  await ensure();

  await publish("PAYROLL", route(), "first route");
  let rows = await audits("APPROVAL_ROUTE_PUBLISHED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oldValues, null, "first publish has no previous route");
  assert.equal(rows[0].newValues.version, 1);
  assert.deepEqual(rows[0].newValues.levels.map((l) => l.action), ["VERIFY", "APPROVE"]);
  assert.deepEqual(rows[0].newValues.levels[1].approverIds, [people.MANAGEMENT.id]);
  assert.match(rows[0].details, /PAYROLL approval route v1 published by u-77: first route/);

  await publish("PAYROLL", route("HR", "BOTH"), "second route");
  rows = await audits("APPROVAL_ROUTE_PUBLISHED");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].oldValues.version, 1, "previous published route recorded");
  assert.deepEqual(rows[1].oldValues.levels[1].approverIds, [people.MANAGEMENT.id]);
  assert.deepEqual(rows[1].newValues.levels[1].approverIds, [people.BOTH.id], "new approver recorded");

  // An invalid publish (approver left the company) rolls back: no audit row, old route still published.
  await call(matrix.saveApprovalMatrixDraft, { kind: "PAYROLL", levels: route() });
  await db((tx) => tx.employee.update({ where: { id: people.MANAGEMENT.id }, data: { status: "Terminated", employement_status: "Terminated" } }));
  await assert.rejects(() => call(matrix.publishApprovalMatrix, { kind: "PAYROLL", reason: "bad" }), /not active/);
  assert.equal((await audits("APPROVAL_ROUTE_PUBLISHED")).length, 2, "failed publish leaves no audit row");
  await db((tx) => tx.employee.update({ where: { id: people.MANAGEMENT.id }, data: { status: "Active", employement_status: "Active" } }));
  await call(matrix.discardApprovalMatrixDraft, { kind: "PAYROLL" });

  // Retire records who/why and the route that was withdrawn.
  await call(matrix.retireApprovalMatrix, { kind: "PAYROLL", reason: "misconfigured, back to fixed stages" });
  const retired = await audits("APPROVAL_ROUTE_RETIRED");
  assert.equal(retired.length, 1);
  assert.equal(retired[0].oldValues.version, 2);
  assert.equal(retired[0].newValues, null);
  assert.match(retired[0].details, /retired by u-77: misconfigured/);

  // Retiring again is a clean 409 and writes nothing.
  await assert.rejects(() => call(matrix.retireApprovalMatrix, { kind: "PAYROLL", reason: "again" }), (e) => e.status === 409);
  assert.equal((await audits("APPROVAL_ROUTE_RETIRED")).length, 1);

  // Audit rows are append-only (X4) and invisible to another tenant.
  await assert.rejects(() => db((tx) => tx.payrollAuditLog.delete({ where: { id: retired[0].id } })), /append-only|HR-4203/);
  const seen = await tenant(other, () => tenantTransaction(prisma, (tx) => tx.payrollAuditLog.count({ where: { action: { startsWith: "APPROVAL_ROUTE_" } } }), { tenantId: other }));
  assert.equal(seen, 0);
});

test("two simultaneous publishes of the same draft: one wins, the other gets a clean 409, one audit row", { timeout: 120000 }, async () => {
  await ensure();
  await call(matrix.saveApprovalMatrixDraft, { kind: "ATTENDANCE", levels: route() });
  // Several racers, not two: the double-publish needs both to read the draft before either commits, which two racers
  // only hit now and then (it passed locally and failed once in CI before the draft was claimed with a guarded update).
  const results = await Promise.allSettled(
    ["A", "B", "C", "D", "E"].map((who) => call(matrix.publishApprovalMatrix, { kind: "ATTENDANCE", reason: `racer ${who}` }))
  );
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.reason?.message ?? "ok")));
  assert.equal(lost.length, 4);
  assert.ok(lost.every((r) => r.reason.status === 409));
  const published = await db((tx) => tx.approvalMatrix.findMany({ where: { tenantId: company, kind: "ATTENDANCE", status: "PUBLISHED" } }));
  assert.equal(published.length, 1);
  assert.equal((await audits("APPROVAL_ROUTE_PUBLISHED")).filter((r) => r.newValues.kind === "ATTENDANCE").length, 1);
});

test("publishing races are forced to overlap: both read the draft before either commits, still one winner", { timeout: 120000 }, async () => {
  await ensure();
  // A published route exists; a held lock on it makes every publisher stop after reading the draft, so the overlap is certain.
  await call(matrix.saveApprovalMatrixDraft, { kind: "ATTENDANCE", levels: route() });
  await call(matrix.publishApprovalMatrix, { kind: "ATTENDANCE", reason: "first" });
  await call(matrix.saveApprovalMatrixDraft, { kind: "ATTENDANCE", levels: route() });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let locked;
  const lockTaken = new Promise((resolve) => { locked = resolve; });
  const holder = db(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_matrices WHERE "tenantId" = ${company} AND kind = 'ATTENDANCE' AND status = 'PUBLISHED' FOR UPDATE`;
    locked();
    await gate;
  });
  await lockTaken;
  const racers = ["A", "B", "C"].map((who) => call(matrix.publishApprovalMatrix, { kind: "ATTENDANCE", reason: `overlap ${who}` }));
  await new Promise((resolve) => setTimeout(resolve, 800)); // every racer has read the draft and is waiting on the lock
  release();
  await holder;
  const results = await Promise.allSettled(racers);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.reason?.message ?? "ok")));
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 409));
  const published = await db((tx) => tx.approvalMatrix.findMany({ where: { tenantId: company, kind: "ATTENDANCE", status: "PUBLISHED" } }));
  assert.equal(published.length, 1);
  assert.equal((await audits("APPROVAL_ROUTE_PUBLISHED")).filter((r) => r.newValues.kind === "ATTENDANCE" && /overlap/.test(r.details)).length, 1);
});

test("ops health flags a published level nobody active can act on; ignores paused and manager-routed levels", { timeout: 120000 }, async () => {
  await ensure();
  const now = new Date();
  const broken = async (tenantId = company) =>
    (await tenant(tenantId, () => opsHealth({ tenantId, now }))).checks.find((c) => c.code === "APPROVAL_ROUTE_BROKEN");

  assert.equal((await broken()).status, "OK", "no route published: nothing to break");
  await publish("PAYROLL", [
    { name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER", approverIds: [], paused: true, required: false },
    ...route(),
  ], "route");
  assert.equal((await broken()).status, "OK", "all approvers active");

  await db((tx) => tx.employee.update({ where: { id: people.HR.id }, data: { status: "Terminated", employement_status: "Terminated" } }));
  const bad = await broken();
  assert.equal(bad.status, "ATTENTION");
  // The earlier test left an ATTENDANCE route with the same HR verifier, so both routes break.
  assert.equal(bad.count, 2, "one broken level per route; the paused manager level is ignored");
  const payroll = bad.items.find((i) => i.kind === "PAYROLL");
  assert.deepEqual([payroll.level, payroll.name], [2, "HR verification"]);
  assert.deepEqual(bad.items.map((i) => i.kind).sort(), ["ATTENDANCE", "PAYROLL"]);
  assert.match(payroll.reason, /inactive/);

  assert.equal((await broken(other)).status, "OK", "another tenant is unaffected");
  await db((tx) => tx.employee.update({ where: { id: people.HR.id }, data: { status: "Active", employement_status: "Active" } }));
  assert.equal((await broken()).status, "OK", "recovers when the approver is active again");
});
