import { describe, expect, it } from "@jest/globals";
import { todayInPakistan, visibleTimesheetRows } from "../../src/lib/timesheetVisibility.js";

const d = (s) => new Date(`${s}T00:00:00Z`);
const row = (employeeId, date, status) => ({ employeeId, date: d(date), status });
const today = d("2026-10-30");

describe("visibleTimesheetRows", () => {
  it("drops days still to come and weekly offs, unless weekly off was asked for", () => {
    const rows = [row(1, "2026-10-29", "PRESENT"), row(1, "2026-10-31", "WEEKLY_OFF"), row(1, "2026-10-28", "WEEKLY_OFF"), row(1, "2026-11-02", "PRESENT")];
    expect(visibleTimesheetRows(rows, { today }).map((r) => r.status)).toEqual(["PRESENT"]);
    expect(visibleTimesheetRows(rows, { today, showWeeklyOff: true })).toHaveLength(2);
  });

  it("drops days before the employee joined", () => {
    const rows = [row(7, "2026-10-20", "ABSENT"), row(7, "2026-10-27", "PRESENT")];
    const joining = new Map([[7, d("2026-10-26")]]);
    expect(visibleTimesheetRows(rows, { today, joining }).map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-10-27"]);
  });

  it("drops setup-required days before the employee was enrolled, keeping them once enrolled", () => {
    const rows = [row(8, "2026-10-26", "SETUP_REQUIRED"), row(8, "2026-10-29", "SETUP_REQUIRED"), row(9, "2026-10-29", "SETUP_REQUIRED"), row(8, "2026-10-29", "PRESENT")];
    const enrolledFrom = new Map([[8, d("2026-10-28")]]);
    const kept = visibleTimesheetRows(rows, { today, enrolledFrom });
    // 8 on the 26th (before enrolment) and 9 (never enrolled) are hidden; 8 on the 29th stays, and other statuses are untouched.
    expect(kept.map((r) => `${r.employeeId}:${r.date.toISOString().slice(0, 10)}:${r.status}`)).toEqual(["8:2026-10-29:SETUP_REQUIRED", "8:2026-10-29:PRESENT"]);
  });

  it("reads today in Pakistan time", () => {
    expect(todayInPakistan(new Date("2026-10-30T20:30:00Z")).toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(todayInPakistan(new Date("2026-10-30T18:30:00Z")).toISOString().slice(0, 10)).toBe("2026-10-30");
  });
});
