// T1 against Postgres: every real attendance policy change is audited with old and new values;
// a save that changes nothing is a no-op; invalid or stale saves leave no audit row.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, db, as } from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";
import { updateAttendancePolicy, getAttendancePolicy, changedPolicyKeys } from "../../src/services/attendancePolicyConfig.service.js";

const save = (input) => as("HR", () => updateAttendancePolicy({ tenantId: company, ...input }));
const audits = () => db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action: "ATTENDANCE_POLICY_UPDATED" }, orderBy: { id: "asc" } }));

test("policy updates are audited; unchanged saves are no-ops; bad saves leave nothing", { timeout: 120000 }, async () => {
  await setup();

  const first = await save({ graceMinutes: 20 });
  assert.equal(first.version, 1);
  let rows = await audits();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].newValues.graceMinutes, 20);
  assert.ok("graceMinutes" in rows[0].oldValues, "old value (the default) is recorded");
  assert.equal(rows[0].newValues.version, 1);

  const second = await save({ graceMinutes: 30, deductAbsentDays: 2 });
  assert.equal(second.version, 2);
  rows = await audits();
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].oldValues.graceMinutes, rows[1].newValues.graceMinutes], [20, 30]);
  assert.equal(Number(rows[1].newValues.deductAbsentDays), 2);
  assert.match(rows[1].details, /graceMinutes, deductAbsentDays|deductAbsentDays, graceMinutes/);

  // Same values again (even as strings): nothing changes, nothing is audited, version stays.
  await db((tx) => tx.attendancePolicyConfig.update({ where: { tenantId: company }, data: { status: "PUBLISHED" } }));
  const noop = await save({ graceMinutes: "30", deductAbsentDays: 2 });
  assert.equal(noop.version, 2);
  assert.equal(noop.status, "PUBLISHED", "an unchanged save does not flip a published policy back to DRAFT");
  assert.equal((await audits()).length, 2);
  const empty = await save({});
  assert.equal(empty.version, 2);
  assert.equal((await audits()).length, 2);

  // A percent field (stored as a decimal) compares by value.
  await save({ fullDayMinPercent: 80, halfDayMinPercent: 40 });
  const afterPct = (await audits()).length;
  await save({ fullDayMinPercent: 80, halfDayMinPercent: 40 });
  assert.equal((await audits()).length, afterPct, "same percent again is not a change");

  // Invalid values and a stale version are refused with no audit row and no change.
  const before = (await audits()).length;
  const v = (await db((tx) => tx.attendancePolicyConfig.findUnique({ where: { tenantId: company } }))).version;
  await assert.rejects(() => save({ graceMinutes: 5000 }), /1440|0–1440/);
  await assert.rejects(() => save({ halfDayMinPercent: 95, fullDayMinPercent: 50 }), /<=|exceed/);
  await assert.rejects(() => save({ graceMinutes: 31, expectedVersion: v - 1 }), (e) => e.status === 409 || /changed/i.test(e.message));
  assert.equal((await audits()).length, before);
  assert.equal((await db((tx) => tx.attendancePolicyConfig.findUnique({ where: { tenantId: company } }))).version, v);

  // Audit rows are append-only (X4) and invisible to another tenant.
  await assert.rejects(() => db((tx) => tx.payrollAuditLog.delete({ where: { id: rows[0].id } })), /append-only|HR-4203/);
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.payrollAuditLog.count({ where: { action: "ATTENDANCE_POLICY_UPDATED" } }), { tenantId: other }),
  );
  assert.equal(seen, 0);
  assert.ok((await as("HR", () => getAttendancePolicy({ tenantId: company }))).graceMinutes >= 0);
});

test("changedPolicyKeys compares by value", () => {
  assert.deepEqual(changedPolicyKeys({ a: 1, b: "09:00", c: null }, { a: 1, b: "09:00", c: null }), []);
  assert.deepEqual(changedPolicyKeys({ a: 1 }, { a: 2 }), ["a"]);
  assert.deepEqual(changedPolicyKeys({ c: null }, { c: 50 }), ["c"]);
  assert.deepEqual(changedPolicyKeys({ c: 50 }, { c: null }), ["c"]);
  assert.deepEqual(changedPolicyKeys({ t: true }, { t: false }), ["t"]);
  assert.deepEqual(changedPolicyKeys({ t: "09:00" }, { t: "09:30" }), ["t"]);
  assert.deepEqual(changedPolicyKeys(undefined, { a: 1 }), ["a"]);
});
