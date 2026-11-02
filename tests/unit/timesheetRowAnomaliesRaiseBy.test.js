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
