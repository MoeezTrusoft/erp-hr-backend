// HR-ATT-APPEAL-01/02 (2026-11-06) — the Timesheet offers "Appeal" on a case
// Management rejected, and stops offering it once an appeal exists. The read
// model asks this helper instead of re-stating the rules, so the button and
// `hr_attendance_rules_appeal` cannot disagree.
import { describe, it, expect } from "@jest/globals";
import { appealInfo, appealsByOriginal } from "../../src/lib/attendanceCaseAppeal.js";

const rejected = (over = {}) => ({
  id: 2352,
  rulesVersion: 2,
  status: "REJECTED",
  decisionRole: "Management",
  evidenceState: "ACTIVE",
  appealOfAnomalyId: null,
  ...over,
});

describe("appealInfo — what the Timesheet may offer", () => {
  it("offers an appeal on a Management rejection under the current rules", () => {
    expect(appealInfo(rejected(), new Map())).toEqual({
      canAppeal: true,
      appealId: null,
      appealOf: null,
    });
  });

  it("refuses a legacy (rules v1) rejection: only current-rule cases can be appealed", () => {
    expect(appealInfo(rejected({ rulesVersion: 1 }), new Map()).canAppeal).toBe(false);
  });

  it("refuses a case HR rejected: HR's verdict is not Management's", () => {
    expect(appealInfo(rejected({ decisionRole: "HR" }), new Map()).canAppeal).toBe(false);
  });

  it("refuses a pending case (it is still open, so it is not a decision to appeal)", () => {
    expect(appealInfo(rejected({ status: "PENDING" }), new Map()).canAppeal).toBe(false);
  });

  it("refuses a case whose evidence is no longer live", () => {
    expect(appealInfo(rejected({ evidenceState: "RESOLVED" }), new Map()).canAppeal).toBe(false);
  });

  it("stops offering a second appeal once one exists, and names it", () => {
    const appeals = appealsByOriginal([
      { id: 2360, appealOfAnomalyId: 2352, status: "PENDING", evidenceState: "ACTIVE" },
    ]);
    expect(appealInfo(rejected(), appeals)).toMatchObject({ canAppeal: false, appealId: 2360 });
  });

  it("marks the appeal row itself with the case it contests", () => {
    const appeal = rejected({
      id: 2360,
      status: "PENDING",
      appealOfAnomalyId: 2352,
      decisionRole: null,
    });
    const info = appealInfo(appeal, appealsByOriginal([appeal]));
    expect(info).toEqual({ canAppeal: false, appealId: null, appealOf: 2352 });
  });

  it("keeps the newest appeal when a case was appealed more than once", () => {
    const appeals = appealsByOriginal([
      { id: 2361, appealOfAnomalyId: 2352 },
      { id: 2360, appealOfAnomalyId: 2352 },
    ]);
    expect(appeals.get(2352).id).toBe(2361);
  });

  it("answers a day with no case safely", () => {
    expect(appealInfo(null, new Map())).toEqual({ canAppeal: false, appealId: null, appealOf: null });
  });
});
