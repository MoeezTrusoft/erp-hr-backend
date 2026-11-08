// F-05: long ABSENT streaks. Edge cases a payroll QA would try.
import { describe, it, expect } from "@jest/globals";
import { absenceStreak, longAbsences } from "../../src/lib/absenceStreak.js";

const rows = (...pairs) => pairs.map(([d, status]) => ({ date: `2026-10-${String(d).padStart(2, "0")}T00:00:00Z`, status }));

describe("absenceStreak", () => {
  it("counts consecutive ABSENT days back from the latest row", () => {
    expect(absenceStreak(rows([1, "PRESENT"], [2, "ABSENT"], [3, "ABSENT"], [4, "ABSENT"]))).toEqual({ days: 3, from: "2026-10-02", to: "2026-10-04" });
  });
  it("weekly offs and holidays inside the run neither count nor break it", () => {
    const s = absenceStreak(rows([1, "ABSENT"], [2, "WEEKLY_OFF"], [3, "HOLIDAY"], [4, "ABSENT"], [5, "ABSENT"]));
    expect(s).toEqual({ days: 3, from: "2026-10-01", to: "2026-10-05" });
  });
  it("trailing weekly offs after the last absence are skipped", () => {
    expect(absenceStreak(rows([1, "ABSENT"], [2, "ABSENT"], [3, "WEEKLY_OFF"])).days).toBe(2);
  });
  it("any other status ends the run: present, late, leave, half day, missing punch, pending", () => {
    for (const status of ["PRESENT", "LATE", "ON_LEAVE", "HALF_DAY", "MISSING_CHECKIN", "MISSING_CHECKOUT", "PENDING_ATTENDANCE", "PUNCH_CONFLICT", "EARLY_CHECKOUT"])
      expect(absenceStreak(rows([1, "ABSENT"], [2, "ABSENT"], [3, status], [4, "ABSENT"])).days).toBe(1);
  });
  it("an employee who came back (latest row PRESENT) has no streak", () => {
    expect(absenceStreak(rows([1, "ABSENT"], [2, "ABSENT"], [3, "PRESENT"])).days).toBe(0);
  });
  it("handles empty input, unsorted input and only off days", () => {
    expect(absenceStreak([])).toEqual({ days: 0, from: null, to: null });
    expect(absenceStreak(rows([3, "ABSENT"], [1, "PRESENT"], [2, "ABSENT"])).days).toBe(2);
    expect(absenceStreak(rows([1, "WEEKLY_OFF"], [2, "HOLIDAY"])).days).toBe(0);
  });
  it("is stable across a month boundary", () => {
    const r = [{ date: "2026-10-30T00:00:00Z", status: "ABSENT" }, { date: "2026-10-31T00:00:00Z", status: "ABSENT" }, { date: "2026-11-01T00:00:00Z", status: "ABSENT" }];
    expect(absenceStreak(r)).toEqual({ days: 3, from: "2026-10-30", to: "2026-11-01" });
  });
});

describe("longAbsences", () => {
  it("lists only streaks at or above the minimum, longest first, ties by id", () => {
    const m = new Map([
      [3, rows([1, "ABSENT"], [2, "ABSENT"])],
      [1, rows([1, "ABSENT"], [2, "ABSENT"], [3, "ABSENT"])],
      [2, rows([1, "ABSENT"], [2, "ABSENT"], [3, "ABSENT"])],
      [4, rows([1, "ABSENT"])],
    ]);
    expect(longAbsences(m, 2).map((x) => [x.employeeId, x.days])).toEqual([[1, 3], [2, 3], [3, 2]]);
    expect(longAbsences(m, 4)).toEqual([]);
  });
});
