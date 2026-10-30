import test from "node:test";
import assert from "node:assert/strict";
import { people, db, as, fixture, submit, act, setup } from "./fixtures.mjs";
const { listApprovals } = await import("../../src/services/approval/service.js");

// Found 2026-10-31 (dev audit): an employee with no line manager could not submit leave ("HR-4200: Configure an active
// independent line manager before submission"). Leave, overtime, claims and loans now enter HR verification instead; kinds that
// need an independent reviewer (performance, goals) still refuse.
await setup();
const setManager = (managerId) =>
  db((tx) => tx.employee.update({ where: { id: people.EMPLOYEE.id }, data: { managerId } }));

test("LEAVE, OVERTIME, CLAIM and LOAN without a line manager go to HR and finish the normal way", { timeout: 180000 }, async (t) => {
  for (const kind of ["LEAVE", "OVERTIME", "CLAIM", "LOAN"])
    await t.test(`${kind}: no manager`, async () => {
      const s = await fixture(kind);
      await setManager(null);
      try {
        let row = await submit(s);
        assert.equal(row.stage, "HR");
        assert.equal(row.managerCode ?? null, null);
        assert.equal(row.history[0].fromStage, "INITIATOR");
        assert.equal(row.history[0].toStage, "HR");
        assert.match(row.history[0].reason, /No active line manager/);
        row = await act("HR", row, "VERIFY");
        assert.equal(row.stage, "MANAGEMENT");
        // Issue 137: with no manager step managerActorCode is NULL and the Management queue used to hide the request.
        const queue = await as("MANAGEMENT", () => listApprovals({ scope: "QUEUE", kind }));
        assert.ok(queue.items.some((r) => r.approvalRef === row.approvalRef), "Management sees the request waiting for them");
        row = await act("MANAGEMENT", row, "APPROVE");
        assert.equal(row.stage, "APPROVED");
      } finally {
        await setManager(people.MANAGER.id);
      }
    });
});

test("the submitter as their own manager is treated like no manager for leave", async () => {
  const s = await fixture("LEAVE");
  await setManager(people.EMPLOYEE.id);
  try {
    const row = await submit(s);
    assert.equal(row.stage, "HR");
  } finally {
    await setManager(people.MANAGER.id);
  }
});

test("with an active manager leave still goes to the manager first", async () => {
  const row = await submit(await fixture("LEAVE"));
  assert.equal(row.stage, "LINE_MANAGER");
});
