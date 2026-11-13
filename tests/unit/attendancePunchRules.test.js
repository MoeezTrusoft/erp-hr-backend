import { describe, it, expect } from "@jest/globals";
import { evaluateShift } from "../../src/lib/attendanceEvaluator.js";
import { pairAttendance } from "../../src/lib/attendanceIntervals.js";

const date = "2026-10-01",
  at = (t) => new Date(`${date}T${t}:00Z`);
const shift = { start: at("09:00"), end: at("17:00") };
const score = (items, extra = {}) =>
  evaluateShift({
    shift,
    punches: items.map(([t, type]) => ({ timestamp: at(t), type, directionVerified: true })),
    now: new Date("2026-10-03"),
    ...extra,
  });
const codes = (r) => (r.marks || []).map((m) => m.code);

describe("punch marks never hold the day", () => {
  it("takes the first IN as the check-in and only marks a repeated IN", () => {
    const r = score([["09:00", "IN"], ["12:00", "IN"], ["17:00", "OUT"]]);
    expect(r).toMatchObject({ status: "PRESENT", workedMinutes: 480 });
    expect(r.checkIn).toEqual(at("09:00"));
    expect(codes(r)).toEqual(["REPEATED_IN"]);
    expect(r.issues).toEqual([]);
  });

  it("makes an OUT with no IN a Missing Check-in", () => {
    expect(score([["17:00", "OUT"]])).toMatchObject({ status: "MISSING_CHECKIN", dayCredit: null });
  });

  it("marks an OUT that comes before the first IN and still scores the shift", () => {
    const r = score([["08:30", "OUT"], ["09:00", "IN"], ["17:00", "OUT"]]);
    expect(r).toMatchObject({ status: "PRESENT", workedMinutes: 480 });
    expect(codes(r)).toEqual(["UNMATCHED_OUT"]);
  });

  it("lets the real departure extend an earlier short OUT", () => {
    const r = score([["09:00", "IN"], ["09:01", "OUT"], ["17:00", "OUT"]]);
    expect(r).toMatchObject({ status: "PRESENT", workedMinutes: 480 });
    expect(r.checkOut).toEqual(at("17:00"));
    expect(codes(r)).toEqual(["EXTRA_OUT"]);
  });

  it("keeps a genuine second arrival as a missing check-out", () => {
    expect(score([["09:00", "IN"], ["12:00", "OUT"], ["13:00", "IN"]])).toMatchObject({ status: "MISSING_CHECKOUT" });
  });

  it("still holds punches whose direction is unknown", () => {
    const r = score([["09:00", ""], ["10:00", "IN"], ["17:00", "OUT"]]);
    expect(r.status).toBe("PUNCH_CONFLICT");
    expect(r.issues.map((i) => i.code)).toEqual(["UNKNOWN_DIRECTION"]);
  });

  it("pairs without throwing away order", () => {
    const { intervals, marks, issues } = pairAttendance([
      { type: "IN", timestamp: at("09:00") },
      { type: "OUT", timestamp: at("12:00") },
      { type: "IN", timestamp: at("13:00") },
      { type: "OUT", timestamp: at("17:00") },
    ]);
    expect(intervals).toHaveLength(2);
    expect(marks).toEqual([]);
    expect(issues).toEqual([]);
  });
});

describe("short check-outs", () => {
  it("records a lone short session as an early check-out under the rules, not a conflict", () => {
    const r = score([["09:00", "IN"], ["09:03", "OUT"]]);
    expect(r.status).toBe("ABSENT");
    expect(r.anomalies.map((a) => a.type)).toEqual(["ABSENT"]);
    expect(r.issues).toEqual([]);
  });

  it("is ABSENT when the check-out is before half of the shift", () => {
    expect(score([["09:00", "IN"], ["12:30", "OUT"]]).status).toBe("ABSENT");
  });

  it("is an early check-out, not absent, once half of the shift is worked", () => {
    const r = score([["09:00", "IN"], ["14:00", "OUT"]]);
    expect(r.status).toBe("EARLY_CHECKOUT");
    expect(r.anomalies.map((a) => a.type)).toEqual(["EARLY_CHECKOUT"]);
  });

  it("uses the policy half-day setting", () => {
    const r = score([["09:00", "IN"], ["13:00", "OUT"]], { policy: { halfDayMinPercent: 60 } });
    expect(r.status).toBe("ABSENT");
  });

  it("charges an absence once: lateness is replaced when the day is absent", () => {
    const r = score([["11:00", "IN"], ["12:00", "OUT"]]);
    expect(r.anomalies.map((a) => a.type)).toEqual(["ABSENT"]);
  });
});
