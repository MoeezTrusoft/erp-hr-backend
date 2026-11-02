import { cycleInstantForMonth } from "../../src/services/payrollCycleDates.js";

// The calendar every company holds today: 2026-09-02 23:59 UTC = 3 Sep 04:59 PKT.
const STORED = new Date("2026-09-02T23:59:00.000Z");

describe("cycleInstantForMonth", () => {
  it("puts October's cutoff on 3 Nov 04:59 PKT", () => {
    expect(cycleInstantForMonth(STORED, "2026-10").toISOString()).toBe("2026-11-02T23:59:00.000Z");
  });

  it("keeps September's at 3 Oct 04:59 PKT, and a gate compared with a September 20 clock is still open", () => {
    const sept = cycleInstantForMonth(STORED, "2026-09");
    expect(sept.toISOString()).toBe("2026-10-02T23:59:00.000Z");
    expect(sept.getTime()).toBeGreaterThan(new Date("2026-09-20T00:00:00Z").getTime());
  });

  it("rolls December into January of the next year", () => {
    expect(cycleInstantForMonth(STORED, "2026-12").toISOString()).toBe("2027-01-02T23:59:00.000Z");
  });

  it("clamps a 31st to the last day of a short month", () => {
    const stored = new Date("2026-08-30T19:00:00.000Z"); // 31 Aug 00:00 PKT
    expect(cycleInstantForMonth(stored, "2027-01").toISOString()).toBe("2027-02-27T19:00:00.000Z");
  });

  it("reads the day in Karachi, not UTC (a late-evening UTC instant is already the next PKT day)", () => {
    const stored = new Date("2026-10-02T13:00:00.999Z"); // 2 Oct 18:00 PKT
    expect(cycleInstantForMonth(stored, "2026-10").toISOString()).toBe("2026-11-02T13:00:00.999Z");
  });

  it("returns null when nothing is configured or the input is malformed", () => {
    expect(cycleInstantForMonth(null, "2026-10")).toBeNull();
    expect(cycleInstantForMonth(STORED, "October")).toBeNull();
    expect(cycleInstantForMonth("garbage", "2026-10")).toBeNull();
  });
});
