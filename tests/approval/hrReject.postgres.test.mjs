import test from "node:test";
import assert from "node:assert/strict";
import { people, as, fixture, submit, act, setup } from "./fixtures.mjs";
const { listApprovals, readApproval } = await import("../../src/services/approval/service.js");

// Batch 5 (operator, 2026-11-01): HR may reject a request outright, with a reason. Not an attendance case: payroll prices
// only the cases Management disapproves, so HR returns those instead.
await setup();

test("HR is offered Reject on a leave request at HR verification, and rejecting ends it", async () => {
  let row = await submit(await fixture("LEAVE"));
  row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
  assert.equal(row.stage, "HR");
  const read = await as("HR", () => readApproval({ approvalRef: row.approvalRef }));
  assert.ok(read.record.actions.includes("REJECT"), "HR can reject");
  assert.ok(read.record.actions.includes("REVERT"), "HR can still return");
  row = await act("HR", row, "REJECT");
  assert.equal(row.stage, "REJECTED");
});

test("HR is not offered Reject on an attendance case", async () => {
  const s = await fixture("ATTENDANCE");
  const row = await submit(s);
  assert.equal(row.stage, "HR");
  const read = await as("HR", () => readApproval({ approvalRef: row.approvalRef }));
  assert.ok(!read.record.actions.includes("REJECT"));
  assert.ok(read.record.actions.includes("VERIFY"));
});

test("lists carry a plain title and counts by kind that ignore the kind filter", async () => {
  await submit(await fixture("OVERTIME"));
  const all = await as("EMPLOYEE", () => listApprovals({ scope: "MINE" }));
  assert.ok(all.items.every((r) => r.title === null || typeof r.title === "string"));
  assert.ok(all.items.some((r) => /Leave|Overtime|Late|Absent|Missing/.test(r.title ?? "")), "at least one titled item");
  const total = all.counts.total;
  const filtered = await as("EMPLOYEE", () => listApprovals({ scope: "MINE", kind: "OVERTIME" }));
  assert.equal(filtered.counts.total, total, "counts ignore the kind filter");
  assert.equal(filtered.counts.byKind.OVERTIME, filtered.items.length);
  assert.ok(Object.values(all.counts.byKind).reduce((a, b) => a + b, 0) === total);
  assert.ok(people.EMPLOYEE);
});
