// Attendance rule changes end to end against PostgreSQL: HR files a grace change, a team assignment or a setup
// publication, the attendance route approves, and the rules are written (and past days re-queued) only on the
// final approval.
import test from "node:test";
import assert from "node:assert/strict";
import { company, other, people, db, as, act, prisma, ensure, publishRoute, decide, approvalOf } from "./route-fixture.mjs";
const svc = await import("../../src/services/attendanceRuleChangeRequest.service.js");
const rules = await import("../../src/services/attendanceRules.service.js");
const setup = await import("../../src/services/attendanceSetup.service.js");

const hr = (fn) => as("BOTH", fn);
const grace = (over = {}) => ({
  tenantId: company, requestedById: people.BOTH.id, scope: "COMPANY", scopeKey: "*", effectiveFrom: "2026-10-15",
  checkInMinutes: 20, checkOutMinutes: 10, version: -1, reason: "Gate queues in the morning", ...over,
});
const graceRows = () => db((tx) => tx.attendanceGraceRule.findMany({ where: { tenantId: company, scope: "COMPANY" } }));
const requests = (status) => db((tx) => tx.attendanceRuleChangeRequest.findMany({ where: { tenantId: company, ...(status ? { status } : {}) } }));
const jobs = (from) => db((tx) => tx.attendanceEvaluationJob.count({ where: { tenantId: company, state: "PENDING", date: { gte: new Date(`${from}T00:00:00Z`) } } }));
// Management rejects a request that is stuck at the last level (the status cannot be flipped outside the approval engine).
const rejectWaiting = async (id) => {
  const ar = await approvalOf("ATTENDANCE_RULE_CHANGE", id);
  // The refusal may land at the first or the last level, so whoever holds the request now rejects it.
  const rec = { approvalRef: ar.id, version: ar.version };
  await act("MANAGEMENT", rec, "REJECT").catch(() => act("HR", rec, "REJECT"));
};
const mine = (who) => as(who, () => rules.myAttendanceRules({ user: { tenantId: company, employeeId: people[who].id } }));

test("a grace change needs the route, a reason and valid values; nothing is left behind", async () => {
  await ensure();
  await assert.rejects(hr(() => svc.requestGraceRule(grace())), /Publish the attendance approval route/);
  assert.equal((await requests()).length, 0, "no orphan request after a refused submission");
  await publishRoute();
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ reason: "  " }))), /reason/i);
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ checkInMinutes: -1 }))), /whole minutes/);
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ checkOutMinutes: 1.5 }))), /whole minutes/);
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ scope: "TEAM", scopeKey: " " }))), /Scope and key/);
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ scope: "EMPLOYEE", scopeKey: "999999" }))), /Employee not found/);
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ version: 4 }))), /changed; refresh/, "a stale version is refused up front");
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ requestedById: null }))), /employee/i);
  assert.equal((await requests()).length, 0);
  assert.equal((await graceRows()).length, 0);
});

test("a grace change applies only on the final approval, then re-queues the past days", async () => {
  await ensure();
  const before = await jobs("2026-10-15");
  const result = await hr(() => svc.requestGraceRule(grace()));
  assert.equal(result.pendingApproval, true);
  assert.equal((await graceRows()).length, 0, "the rule is not written while the request waits");
  assert.equal(await jobs("2026-10-15"), before, "nothing is re-queued while the request waits");
  await assert.rejects(hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-11-01" }))), /already has a change waiting/);

  const waiting = await hr(() => svc.listPendingRuleChanges({ tenantId: company }));
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].requestedByName, "the filer's name is there for the screen");
  const waitingMine = await mine("EMPLOYEE");
  assert.deepEqual([waitingMine.mine.checkInMinutes, waitingMine.mine.checkOutMinutes], [0, 0], "the employee still sees the old limits while it waits");

  assert.equal((await decide("ATTENDANCE_RULE_CHANGE", result.requestId)).stage, "APPROVED");
  const rows = await graceRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].checkInMinutes, rows[0].checkOutMinutes, rows[0].effectiveFrom.toISOString().slice(0, 10)], [20, 10, "2026-10-15"]);
  assert.ok((await jobs("2026-10-15")) > before, "the days from the effective date are queued for re-evaluation");
  assert.equal((await requests("APPROVED")).length, 1);
  assert.equal(await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, action: "ATTENDANCE_RULE_CHANGE_APPLIED" } })), 1);
  assert.equal((await hr(() => svc.listPendingRuleChanges({ tenantId: company }))).length, 0);

  const m = await mine("EMPLOYEE");
  assert.deepEqual([m.mine.checkInMinutes, m.mine.checkOutMinutes], [20, 10], "the employee sees their own limits");
  assert.deepEqual(m.team, [], "an employee with no reports sees no team");
});

test("a rejected change writes nothing and frees the scope for a new request", async () => {
  await ensure();
  const result = await hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-12-01", checkInMinutes: 5, version: -1 })));
  assert.equal((await decide("ATTENDANCE_RULE_CHANGE", result.requestId, "REJECT")).stage, "REJECTED");
  assert.equal((await graceRows()).length, 1, "only the earlier approved rule exists");
  assert.equal((await requests("REJECTED")).length, 1);
  const again = await hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-12-01", checkInMinutes: 5, version: -1 })));
  assert.equal(again.status, "PENDING");
  await decide("ATTENDANCE_RULE_CHANGE", again.requestId, "REJECT");
});

test("a grace change that went stale while waiting cannot be approved", async () => {
  await ensure();
  const result = await hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-10-25", checkInMinutes: 30, version: -1 })));
  // Someone writes the same scope and date directly before the approval lands.
  await db((tx) => tx.attendanceGraceRule.create({ data: { tenantId: company, scope: "COMPANY", scopeKey: "*",
    effectiveFrom: new Date("2026-10-25T00:00:00Z"), checkInMinutes: 7, checkOutMinutes: 7, version: 0, actorId: String(people.BOTH.id), reason: "race" } }));
  const ar = await approvalOf("ATTENDANCE_RULE_CHANGE", result.requestId);
  const rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  await assert.rejects(act("MANAGEMENT", rec, "APPROVE"), /changed; refresh/);
  const row = (await graceRows()).find((r) => r.effectiveFrom.toISOString().slice(0, 10) === "2026-10-25");
  assert.equal(row.checkInMinutes, 7, "the direct write is untouched");
  assert.equal((await requests("PENDING")).length, 1, "a refused approval leaves the request undecided");
  await rejectWaiting(result.requestId);
});

test("the status of a request cannot be changed outside the approval engine", async () => {
  await ensure();
  const result = await hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-11-15", checkInMinutes: 3, version: -1 })));
  await assert.rejects(db((tx) => tx.attendanceRuleChangeRequest.updateMany({ where: { id: result.requestId }, data: { status: "APPROVED" } })), /staged approval/);
  await decide("ATTENDANCE_RULE_CHANGE", result.requestId, "REJECT");
  const approved = (await requests("APPROVED"))[0];
  await assert.rejects(db((tx) => tx.attendanceRuleChangeRequest.updateMany({ where: { id: approved.id }, data: { payload: {} } })), /immutable/);
});

test("a change that reaches into a closed payroll period is refused at approval", async () => {
  await ensure();
  const result = await hr(() => svc.requestGraceRule(grace({ effectiveFrom: "2026-10-05", checkInMinutes: 12, version: -1 })));
  const run = await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id,
    periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"), countryCode: "PK",
    currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  try {
    await assert.rejects(hr(() => svc.requestGraceRule(grace({ scope: "TEAM", scopeKey: "Night", effectiveFrom: "2026-10-06", checkInMinutes: 13 }))), /payroll run/i, "refused up front too");
    await assert.rejects(decide("ATTENDANCE_RULE_CHANGE", result.requestId), /payroll run/i);
    assert.equal((await graceRows()).filter((r) => r.checkInMinutes === 12).length, 0);
  } finally {
    await db((tx) => tx.payrollRun.delete({ where: { id: run.id } }));
    await rejectWaiting(result.requestId);
  }
});

test("a team assignment is a request too,", async () => {
  await ensure();
  const bad = { tenantId: company, requestedById: people.BOTH.id, employeeId: 999999, effectiveFrom: "2026-10-15", teamKey: "Night", departmentKey: null, version: -1, reason: "Move to night team" };
  await assert.rejects(hr(() => svc.requestGraceMembership(bad)), /Employee not found/);
  const result = await hr(() => svc.requestGraceMembership({ ...bad, employeeId: people.EMPLOYEE.id }));
  assert.equal(await db((tx) => tx.attendanceGraceMembership.count({ where: { tenantId: company } })), 0);
  assert.equal((await decide("ATTENDANCE_RULE_CHANGE", result.requestId)).stage, "APPROVED");
  const rows = await db((tx) => tx.attendanceGraceMembership.findMany({ where: { tenantId: company } }));
  assert.deepEqual(rows.map((r) => [r.employeeId, r.teamKey]), [[people.EMPLOYEE.id, "Night"]]);
});

test("a setup publication is a request: the release appears only on approval", async () => {
  await ensure();
  // A window before anyone was hired leaves only the policy to satisfy, so the fixture can publish.
  const from = "2025-12-01", to = "2025-12-31";
  await db((tx) => tx.attendancePolicyConfig.create({ data: { tenantId: company } }));
  const preview = await hr(() => setup.previewAttendanceSetup({ tenantId: company, from, to }));
  assert.equal(preview.ready, true, JSON.stringify(preview.issues));
  const releases = () => db((tx) => tx.attendanceSetupRelease.count({ where: { tenantId: company } }));
  const before = await releases();
  const file = (over = {}) => hr(() => svc.requestAttendanceSetupPublish({ tenantId: company, requestedById: people.BOTH.id, from, to, reason: "Month rules", previewToken: preview.previewToken, ...over }));

  await assert.rejects(file({ reason: " " }), /reason/i);
  await assert.rejects(file({ previewToken: "stale" }), /changed since preview/);
  assert.equal((await requests("PENDING")).filter((r) => r.action === "PUBLISH_SETUP").length, 0, "refusals leave nothing behind");
  const filed = await file();
  assert.equal(filed.pendingApproval, true);
  assert.equal(await releases(), before, "no release while the request waits");
  await assert.rejects(file({ reason: "again" }), /already waiting/);
  assert.equal((await decide("ATTENDANCE_RULE_CHANGE", filed.requestId)).stage, "APPROVED");
  assert.equal(await releases(), before + 1, "the release is created by the final approval");

  // A draft that moves after filing cannot ride on the old request.
  const next = await hr(() => setup.previewAttendanceSetup({ tenantId: company, from, to }));
  const stale = await file({ previewToken: next.previewToken, reason: "Second try" });
  await db((tx) => tx.attendancePolicyConfig.updateMany({ where: { tenantId: company }, data: { graceMinutes: 9 } }));
  await assert.rejects(decide("ATTENDANCE_RULE_CHANGE", stale.requestId), /rules changed after this request was filed/);
  assert.equal(await releases(), before + 1);
  await rejectWaiting(stale.requestId);
});

test("other companies cannot see or file against this company's requests", async () => {
  await ensure();
  const mineRows = await db((tx) => tx.attendanceRuleChangeRequest.count({ where: { tenantId: company } }));
  assert.ok(mineRows > 0);
  const { mcpCtx } = await import("../../src/mcp/context.js");
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () => svc.listPendingRuleChanges({ tenantId: other }));
  assert.equal(seen.length, 0);
  const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
  const leak = await mcpCtx.run({ user: { tenantId: other } }, () => tenantTransaction(prisma, (tx) => tx.attendanceRuleChangeRequest.count(), { tenantId: other }));
  assert.equal(leak, 0, "row-level security hides this company's requests");
});
