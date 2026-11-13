// An approver's note is optional on every decision (operator, 2026-11-02): recommend, verify, approve, reject and return all work
// with an empty note, and the attendance rule cases (which keep a required comment) store a plain sentence instead.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, submit, act, setup } from "./fixtures.mjs";
const { isStagePaused } = await import("../../src/lib/approvalStagePolicy.js");

const quiet = { reason: "" };

test("every decision works without a note", { concurrency: false }, async (t) => {
  await setup();
  for (const kind of ["ATTENDANCE", "LEAVE"]) {
    await t.test(`${kind}: verify then approve with no note`, async () => {
      const s = await fixture(kind);
      let row = await submit(s);
      if (!isStagePaused(kind, "LINE_MANAGER")) row = await act("MANAGER", row, "RECOMMEND_APPROVAL", quiet);
      row = await act("HR", row, "VERIFY", quiet);
      row = await act("MANAGEMENT", row, "APPROVE", quiet);
      assert.equal(row.stage, "APPROVED");
    });
    await t.test(`${kind}: verify then reject with no note`, async () => {
      const s = await fixture(kind);
      let row = await submit(s);
      if (!isStagePaused(kind, "LINE_MANAGER")) row = await act("MANAGER", row, "RECOMMEND_REJECTION", quiet);
      row = await act("HR", row, "VERIFY", quiet);
      row = await act("MANAGEMENT", row, "REJECT", quiet);
      assert.equal(row.stage, "REJECTED");
    });
    await t.test(`${kind}: return with no note`, async () => {
      const s = await fixture(kind);
      let row = await submit(s);
      row = await act(isStagePaused(kind, "LINE_MANAGER") ? "HR" : "MANAGER", row, "REVERT", quiet);
      assert.equal(row.stage, "INITIATOR");
    });
  }
});
