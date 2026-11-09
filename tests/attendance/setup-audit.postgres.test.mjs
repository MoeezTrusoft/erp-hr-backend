// T1 against Postgres: deduction rules and approval levels are audited like the policy, unchanged saves are
// no-ops, invalid saves leave nothing, deletes are recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, people, db, as } from "../approval/fixtures.mjs";
import { upsertApprovalLevel, deleteApprovalLevel } from "../../src/services/attendanceApprovalLevel.service.js";
import { upsertDeductionRule, DEDUCTION_RULE_KEYS } from "../../src/services/attendanceDeductionRule.service.js";
import { auditSetupChange, changedKeys, sameValue } from "../../src/lib/setupAudit.js";

let ready; // the fixtures create fixed employee codes: set up once per process
const ensure = () => (ready ||= setup());
const audits = (action) => db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action }, orderBy: { id: "asc" } }));
const level = (input) => as("HR", () => upsertApprovalLevel({ tenantId: company, level: 1, ...input }));
const rule = (input) => as("HR", () => upsertDeductionRule({ tenantId: company, ruleKey: DEDUCTION_RULE_KEYS[0], ...input }));

test("approval levels: create, change, unchanged, invalid, delete", { timeout: 120000 }, async () => {
  await ensure();
  const A = "ATTENDANCE_APPROVAL_LEVEL_UPDATED", D = "ATTENDANCE_APPROVAL_LEVEL_DELETED";

  const created = await level({ role: "HR", approverId: people.HR.id });
  assert.equal(created.version, 1);
  let rows = await audits(A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oldValues, null, "first save has no previous");
  assert.equal(rows[0].newValues.approverId, people.HR.id);
  assert.equal(rows[0].newValues.level, 1);

  // Unchanged: no version bump, no audit, a published row stays published.
  await db((tx) => tx.attendanceApprovalLevel.updateMany({ where: { tenantId: company, level: 1 }, data: { status: "PUBLISHED" } }));
  const same = await level({ role: "HR", approverId: people.HR.id });
  assert.equal(same.version, 1);
  assert.equal(same.status, "PUBLISHED");
  assert.equal((await audits(A)).length, 1);

  const changed = await level({ role: "Finance", autoEscalateAfterHours: 48 });
  assert.equal(changed.version, 2);
  rows = await audits(A);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].oldValues.role, "HR");
  assert.equal(rows[1].newValues.role, "Finance");
  assert.equal(rows[1].oldValues.autoEscalateAfterHours, null);
  assert.equal(rows[1].newValues.autoEscalateAfterHours, 48);
  assert.equal(rows[1].oldValues.version, 1);

  // Invalid: no approver and no manager routing; bad level; unknown employee. Nothing is written.
  await assert.rejects(() => level({ approverId: null, useEmployeeManager: false }), /approverId or useEmployeeManager/);
  await assert.rejects(() => as("HR", () => upsertApprovalLevel({ tenantId: company, level: 0, role: "x", approverId: people.HR.id })), /level must be/);
  await assert.rejects(() => level({ approverId: 99999999 }), /not found/);
  assert.equal((await audits(A)).length, 2);

  // Delete is recorded with what was removed; deleting a missing level is a 404 with no audit row.
  await as("HR", () => deleteApprovalLevel({ tenantId: company, level: 1 }));
  const del = await audits(D);
  assert.equal(del.length, 1);
  assert.equal(del[0].oldValues.role, "Finance");
  assert.equal(del[0].newValues, null);
  await assert.rejects(() => as("HR", () => deleteApprovalLevel({ tenantId: company, level: 1 })), /not found/);
  assert.equal((await audits(D)).length, 1);
});

test("deduction rules: audited, unchanged is a no-op, invalid leaves nothing", { timeout: 120000 }, async () => {
  await ensure();
  const R = "ATTENDANCE_DEDUCTION_RULE_UPDATED";
  const key = DEDUCTION_RULE_KEYS[0];

  const first = await rule({ deductionDays: 1 });
  assert.equal(first.version, 1);
  let rows = await audits(R);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].newValues.ruleKey, key);
  assert.equal(Number(rows[0].newValues.deductionDays), 1);

  const same = await rule({ deductionDays: 1 });
  assert.equal(same.version, 1);
  assert.equal((await audits(R)).length, 1);

  const next = await rule({ deductionDays: 0.5, enabled: true });
  assert.equal(next.version, 2);
  rows = await audits(R);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[1].oldValues.deductionDays), 1);
  assert.equal(Number(rows[1].newValues.deductionDays), 0.5);
  assert.equal(rows[1].newValues.enabled, true);

  await assert.rejects(() => rule({ deductionDays: 40 }), /between 0 and 31/);
  await assert.rejects(() => rule({ deductionDays: -1 }), /between 0 and 31/);
  await assert.rejects(() => as("HR", () => upsertDeductionRule({ tenantId: company, ruleKey: "NOT_A_RULE", enabled: true })), /ruleKey must be one of/);
  assert.equal((await audits(R)).length, 2);
});

test("setupAudit helpers: value comparison and row shape", () => {
  assert.equal(sameValue(1, 1), true);
  assert.equal(sameValue({ toNumber: () => 2 }, 2), true, "decimal-like values compare by number");
  assert.equal(sameValue(null, undefined), true);
  assert.equal(sameValue(null, 0), false);
  assert.equal(sameValue("09:00", "09:30"), false);
  assert.equal(sameValue(true, false), false);
  assert.deepEqual(changedKeys({ a: 1, b: null }, { a: 1, b: 5 }), ["b"]);
  const made = [];
  const tx = { payrollAuditLog: { create: async ({ data }) => made.push(data) } };
  return auditSetupChange(tx, { tenantId: "t", action: "X", label: "L", before: null, defaults: null, after: { a: 1 }, keys: ["a"] }).then(() => {
    assert.equal(made[0].oldValues, null);
    assert.deepEqual(made[0].newValues, { a: 1 });
    assert.match(made[0].details, /^L: a$/);
  });
});
