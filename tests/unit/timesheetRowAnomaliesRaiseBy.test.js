// Issue 10: an unraised case carries the moment its raise window closes, so the Timesheet can say "Raise by ...".
import { describe, it, expect } from "@jest/globals";
import { rowAnomalies } from "../../src/lib/timesheetRowAnomalies.js";

const lateCheckin = { id: 7, type: "LATE_CHECKIN", rulesVersion: 2, evidenceState: "ACTIVE", status: "PENDING", sourceKind: "RULES_V2" };

describe("rowAnomalies raise-by", () => {
  it("carries the deadline on an unraised case", () => {
    const rows = rowAnomalies([lateCheckin], { raiseByByAnomaly: new Map([[7, "2026-11-03T18:59:59.000Z"]]) });
    expect(rows[0].request).toMatchObject({ status: "UNSUBMITTED", anomalyId: 7, raiseBy: "2026-11-03T18:59:59.000Z" });
  });
  it("is null when no deadline was computed (older than a week, or the lookup failed)", () => {
    expect(rowAnomalies([lateCheckin], {})[0].request.raiseBy).toBeNull();
  });
});

// Pervaiz, HomeVision 9 Oct 2026: case 2931 and its request are APPROVED, yet the
// row read "Awaiting Management approval" because the label came from the last
// level alone. A decided request must not describe itself as waiting.
describe("rowAnomalies stage label", () => {
  const route = { levels: [{ name: "Line manager" }, { name: "HR verification" }, { name: "Management approval" }] };
  // rowAnomalies keys approvals by String(anomaly id).
  const approval = (stage, level) => new Map([["7", { id: "req-1", stage, level, route }]]);

  it("says nothing about waiting once the request is approved", () => {
    const rows = rowAnomalies([{ ...lateCheckin, status: "APPROVED" }], { approvalByAnomaly: approval("APPROVED", 2) });
    expect(rows[0].request).toMatchObject({ status: "APPROVED", stage: "APPROVED", stageLabel: null });
  });
  it("still names the level a request is waiting at", () => {
    const rows = rowAnomalies([lateCheckin], { approvalByAnomaly: approval("LEVEL", 1) });
    expect(rows[0].request.stageLabel).toBe("Awaiting HR verification");
  });
});
