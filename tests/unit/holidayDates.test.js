// T15: "today" for holiday rules in the company's time zone. The cases that fail with server-clock logic.
import { describe, it, expect } from "@jest/globals";
import { todayInZone } from "../../src/lib/holidayDates.js";

const day = (iso, tz) => todayInZone(new Date(iso), tz).toISOString().slice(0, 10);

describe("todayInZone", () => {
  it("Pakistan is five hours ahead of UTC: 19:00 UTC is already tomorrow", () => {
    expect(day("2026-11-09T18:59:59Z")).toBe("2026-11-09"); // 23:59:59 PKT
    expect(day("2026-11-09T19:00:00Z")).toBe("2026-11-10"); // 00:00:00 PKT
    expect(day("2026-11-09T20:30:00Z")).toBe("2026-11-10"); // 01:30 PKT: UTC logic still says Nov 9
  });
  it("returns UTC midnight so it compares with stored holiday dates", () => {
    const d = todayInZone(new Date("2026-11-09T20:30:00Z"));
    expect([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]).toEqual([0, 0, 0, 0]);
  });
  it("month, year and leap-day boundaries", () => {
    expect(day("2026-12-31T19:30:00Z")).toBe("2027-01-01");
    expect(day("2028-02-28T19:00:00Z")).toBe("2028-02-29");
    expect(day("2027-02-28T19:00:00Z")).toBe("2027-03-01");
  });
  it("honours another zone, including daylight saving", () => {
    expect(day("2026-07-01T03:30:00Z", "America/New_York")).toBe("2026-06-30"); // 23:30 EDT
    expect(day("2026-12-01T04:30:00Z", "America/New_York")).toBe("2026-11-30"); // 23:30 EST
  });
  it("an invalid zone or date fails loudly instead of returning a wrong day", () => {
    expect(() => todayInZone(new Date(), "Not/AZone")).toThrow();
    expect(() => todayInZone(new Date("nope"))).toThrow();
  });
});
