// TS-REQ-PICK-01 (2026-11-05) — live report: Subhan Ali Qadri (Trusoft 491) had
// late check-ins raised by HR (PENDING at Management) on days that also carried a
// second, unraised case which settled later (a missing check-out resolved that
// evening). The row builder picked the day's request by "newest wins, a form
// outranks a grading row", so the settled case became the pick: the Timesheet
// Request cell read "Not submitted" and the Actions menu offered neither "View
// anomaly request" (row.request.status was UNSUBMITTED) nor "Raise anomaly
// request" (the day had cases, none of them unraised).
import { describe, it, expect } from "@jest/globals";
import { pickDayAnomaly } from "../../src/services/timesheetReport.service.js";
import { rowAnomalies } from "../../src/lib/timesheetRowAnomalies.js";

const anomaly = (over = {}) => ({
  id: 1,
  type: "LATE_CHECKIN",
  status: "PENDING",
  evidenceState: "ACTIVE",
  rulesVersion: 2,
  sourceKind: "RULES_V2",
  factHash: "hash",
  ...over,
});
const approvals = (ids) => new Map(ids.map((id) => [String(id), { id: `appr-${id}`, stage: "LEVEL", level: 2 }]));

describe("pickDayAnomaly — the day's request story", () => {
  it("keeps the raised case over a second case that settled later", () => {
    // The live shape: the late check-in (id 2164) was raised on 16 Oct 10:42;
    // the day's missing check-out (id 2205) resolved later that evening, so it
    // came first in the newest-first list.
    const settledCheckout = anomaly({ id: 2205, type: "MISSING_CHECKOUT", status: "RESOLVED", evidenceState: "RESOLVED" });
    const raisedLate = anomaly({ id: 2164, raisedById: 558 });
    const picked = pickDayAnomaly([settledCheckout, raisedLate], approvals([2164]));
    expect(picked.id).toBe(2164);
    expect(picked.status).toBe("PENDING");
  });

  it("prefers a live case over a settled one when neither is raised", () => {
    const settled = anomaly({ id: 9, type: "MISSING_CHECKOUT", status: "RESOLVED", evidenceState: "RESOLVED" });
    const live = anomaly({ id: 8, type: "LATE_CHECKIN" });
    expect(pickDayAnomaly([settled, live], new Map()).id).toBe(8);
  });

  it("keeps an employee form ahead of a grading row", () => {
    const grading = anomaly({ id: 5, sourceKind: "RULES_V2" });
    const form = anomaly({ id: 4, sourceKind: "REGULARIZATION", rulesVersion: 1, status: "APPROVED" });
    expect(pickDayAnomaly([grading, form], new Map()).id).toBe(4);
  });

  it("lets a raised case outrank a form, because that request is what is open", () => {
    const form = anomaly({ id: 4, sourceKind: "REGULARIZATION", rulesVersion: 1, status: "REJECTED", evidenceState: "RESOLVED" });
    const raised = anomaly({ id: 6 });
    expect(pickDayAnomaly([form, raised], approvals([6])).id).toBe(6);
  });

  it("keeps the newest on a tie (the list is createdAt desc)", () => {
    expect(pickDayAnomaly([anomaly({ id: 30 }), anomaly({ id: 20 })], new Map()).id).toBe(30);
  });

  it("returns null for a day with no anomaly row", () => {
    expect(pickDayAnomaly([], new Map())).toBeNull();
  });
});

describe("rowAnomalies — one line per case type", () => {
  it("drops an unraised duplicate in favour of the raised case of the same type", () => {
    // The raise path used to file a second row: 2754 raised, 1963 left behind.
    const raised = anomaly({ id: 2754, raisedById: 558, createdAt: new Date("2026-10-02T10:00:00Z") });
    const duplicate = anomaly({ id: 1963, createdAt: new Date("2026-10-02T18:00:00Z") });
    const rows = rowAnomalies([duplicate, raised], { approvalByAnomaly: approvals([2754]) });
    expect(rows.map((r) => [r.id, r.request.status])).toEqual([[2754, "PENDING"]]);
  });

  it("keeps different case types of the same day apart", () => {
    const late = anomaly({ id: 1, type: "LATE_CHECKIN" });
    const checkout = anomaly({ id: 2, type: "MISSING_CHECKOUT" });
    const rows = rowAnomalies([checkout, late], { approvalByAnomaly: new Map() });
    expect(rows.map((r) => r.type)).toEqual(["MISSING_CHECKOUT", "LATE_CHECKIN"]);
  });

  it("still hides a resolved case and a legacy form from the case list", () => {
    const settled = anomaly({ id: 1, type: "MISSING_CHECKOUT", status: "RESOLVED", evidenceState: "RESOLVED" });
    const form = anomaly({ id: 2, type: "LATE_CHECKIN", sourceKind: "PAPER_FORM" });
    const live = anomaly({ id: 3, type: "LATE_CHECKIN" });
    expect(rowAnomalies([settled, form, live], { approvalByAnomaly: new Map() }).map((r) => r.id)).toEqual([3]);
  });
});
