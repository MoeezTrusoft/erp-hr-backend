import { describe, expect, it } from "@jest/globals";
import { applyTimesheetColumnFilters, inWindow } from "../../src/lib/timesheetFilters.js";

const at = (hhmm, day = "2026-10-05") => new Date(`${day}T${hhmm}:00Z`);
const row = (over) => ({ plannedShift: null, checkIn: null, checkOut: null, totalHours: null, request: null, ...over });
const day = row({ id: "day", plannedShift: { start: at("09:00"), end: at("18:00") }, checkIn: at("09:05"), checkOut: at("18:02"), totalHours: 9 });
const evening = row({ id: "evening", plannedShift: { start: at("15:00"), end: at("00:00", "2026-10-06") }, checkIn: at("15:20"), checkOut: at("00:05", "2026-10-06"), totalHours: 8.75, request: { status: "PENDING" } });
const night = row({ id: "night", plannedShift: { start: at("22:00"), end: at("07:00", "2026-10-06") }, checkIn: at("21:55"), checkOut: at("07:10", "2026-10-06"), totalHours: 9.25, request: { status: "UNSUBMITTED" } });
const none = row({ id: "none" });
const ids = (rows) => rows.map((r) => r.id);

describe("applyTimesheetColumnFilters", () => {
  it("returns the rows untouched when no filter is set", () => {
    expect(applyTimesheetColumnFilters([day, none], {})).toHaveLength(2);
  });

  it("keeps shifts that start at or after From and end at or before To", () => {
    expect(ids(applyTimesheetColumnFilters([day, evening, night, none], { shiftFrom: "09:00", shiftTo: "18:00" }))).toEqual(["day"]);
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { shiftFrom: "08:00", shiftTo: "19:00" }))).toEqual(["day"]);
    // A window across midnight takes the evening and night shifts but not the day shift.
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { shiftFrom: "14:00", shiftTo: "08:00" }))).toEqual(["evening", "night"]);
    // Only From: every shift starting at 15:00 or later.
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { shiftFrom: "15:00" }))).toEqual(["evening", "night"]);
  });

  it("filters check-in and check-out by time of day, across midnight too", () => {
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { checkInFrom: "09:00", checkInTo: "10:00" }))).toEqual(["day"]);
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { checkOutFrom: "23:00", checkOutTo: "01:00" }))).toEqual(["evening"]);
    expect(ids(applyTimesheetColumnFilters([none], { checkInFrom: "00:00", checkInTo: "23:59" }))).toEqual([]);
  });

  it("filters worked hours and the request state", () => {
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { workedMin: 9 }))).toEqual(["day", "night"]);
    expect(ids(applyTimesheetColumnFilters([day, evening, night], { workedMax: 9 }))).toEqual(["day", "evening"]);
    expect(ids(applyTimesheetColumnFilters([day, evening, night, none], { requestStatus: "pending" }))).toEqual(["evening"]);
    expect(ids(applyTimesheetColumnFilters([day, evening, night, none], { requestStatus: "none" }))).toEqual(["day", "none"]);
  });

  it("inWindow handles open ends and wrapped windows", () => {
    expect(inWindow(600, 540, null)).toBe(true);
    expect(inWindow(30, 1380, 60)).toBe(true);
    expect(inWindow(600, 1380, 60)).toBe(false);
    expect(inWindow(null, 0, 100)).toBe(false);
  });
});
