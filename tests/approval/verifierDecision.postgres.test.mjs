// Production 2026-11-06: Management returned Moeez Ahmed's (Trusoft EMP-00484) anomaly request to HR, then verified it
// itself, and the request never appeared for approval again. EMP159 (HomeVision) is stranded the same way.
//
// The row is a legacy request (no sealed route) whose HR verification was performed by the Management approver, so the
// "the verifier cannot decide" rule left the request with nobody able to act and hid it from the only approver's queue.
// Attendance already allows self-verification on the routed path (matrix `allowSelf`), so on these route-less rows the
// verifier may decide; every other kind keeps the two-people rule.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { company, people, fixture, submit, act, setup } from "./fixtures.mjs";
const { mcpCtx } = await import("../../src/mcp/context.js");
const { actApproval, listApprovals } = await import(
  "../../src/services/approval/service.js"
);

// One person holding the HR verify grant and the Management approve grant (the production Admin).
const asDual = (fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: company, userId: people.MANAGEMENT.userId },
      permissions: ["self", "verify", "approve", "read"].map(
        (k) => "hr.approvals." + k,
      ),
    },
    fn,
  );
const dualAct = (row, action) =>
  asDual(() =>
    actApproval({
      approvalRef: row.approvalRef,
      expectedVersion: row.version,
      action,
      reason: `Management ${action}: evidence reviewed`,
      requestKey: randomUUID(),
    }),
  ).then((r) => r.record);

test("a request verified by its own deciding approver", { timeout: 120000 }, async (t) => {
  await setup();

  await t.test(
    "route-less attendance: the verifier still sees the decision and can approve it",
    async () => {
      const s = await fixture("ATTENDANCE");
      let row = await submit(s);
      assert.equal(row.stage, "HR", "the manager stage is paused for attendance");
      row = await dualAct(row, "VERIFY");
      assert.equal(row.stage, "MANAGEMENT");
      const queue = await asDual(() =>
        listApprovals({ scope: "QUEUE", kind: "ATTENDANCE" }),
      );
      assert.ok(
        queue.items.some((i) => i.approvalRef === row.approvalRef),
        "the approver who verified sees the request in their queue",
      );
      row = await dualAct(row, "APPROVE");
      assert.equal(row.stage, "APPROVED");
    },
  );

  await t.test("every other kind keeps the two-people rule", async () => {
    const s = await fixture("LEAVE");
    let row = await submit(s);
    row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
    assert.equal(row.stage, "HR");
    row = await dualAct(row, "VERIFY");
    assert.equal(row.stage, "MANAGEMENT");
    await assert.rejects(
      dualAct(row, "APPROVE"),
      (e) => e.status === 403,
      "the verifier of a leave request cannot also decide it",
    );
  });
});
