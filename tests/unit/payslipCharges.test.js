import { describeAttendanceCharges, payMonthOf } from "../../src/lib/payslipCharges.js";
import { describe, expect, it } from "@jest/globals";

describe("payMonthOf", () => {
  it("names a 1 Sep - 1 Oct cycle September", () => {
    expect(payMonthOf(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))).toBe("2026-09");
  });
  it("falls back to the end date, then null", () => {
    expect(payMonthOf(null, "2026-10-01")).toBe("2026-10");
    expect(payMonthOf(null, null)).toBeNull();
  });
});

describe("describeAttendanceCharges", () => {
  const cases = [
    { id: 1, type: "LATE_CHECKIN", date: "2026-09-12T00:00:00Z", measuredMinutes: 8.4 },
    { id: 2, type: "ABSENT", date: "2026-09-03T00:00:00Z" },
    { id: 3, type: "MISSING_CHECKOUT", date: "2026-09-20T00:00:00Z" },
  ];
  it("lists dated, plain-language items sorted by date", () => {
    const out = describeAttendanceCharges(
      [
        { anomalyIds: [1], days: 0.25, date: "2026-09-12" },
        { anomalyIds: [2], days: 1, date: "2026-09-03" },
      ],
      cases,
    );
    expect(out.map((l) => l.date)).toEqual(["2026-09-03", "2026-09-12"]);
    expect(out[1].items[0]).toEqual({ date: "2026-09-12", type: "LATE_CHECKIN", label: "Late check-in by 8 min" });
    expect(out[0].items[0].label).toBe("Absent");
  });
  it("keeps every case of a pooled line and flags it", () => {
    const [line] = describeAttendanceCharges([{ anomalyIds: [3, 1], days: 1, date: "2026-09-20", pooled: true }], cases);
    expect(line.pooled).toBe(true);
    expect(line.items.map((i) => i.date)).toEqual(["2026-09-12", "2026-09-20"]);
  });
  it("tolerates unknown ids and empty input", () => {
    expect(describeAttendanceCharges()).toEqual([]);
    expect(describeAttendanceCharges([{ anomalyIds: [99], days: 1, date: "2026-09-01" }], cases)[0].items).toEqual([]);
  });
});
