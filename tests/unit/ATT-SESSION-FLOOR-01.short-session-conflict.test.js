// A very short session is no longer a punch conflict (operator, 2026-10-30): the short check-out is
// recorded, and if the real check-out never arrives the day is judged by the early-check-out rule.
import { describe, it, expect } from "@jest/globals";
import { evaluateShift } from "../../src/lib/attendanceEvaluator.js";

const at = (t) => new Date(`2026-10-20T${t}:00Z`);
const shift = { start: at("09:00"), end: at("18:00") };
const now = new Date("2026-10-22T00:00:00Z");
const run = (items, policy = {}) =>
  evaluateShift({
    shift,
    punches: items.map(([t, type]) => ({ timestamp: at(t), type, directionVerified: true })),
    policy: { graceMinutes: 15, halfDayAfterPercentOfShift: 50, ...policy },
    now,
  });

describe("short sessions", () => {
  it("09:00 IN / 09:01 OUT is recorded as the check-out, not a conflict", () => {
    const r = run([["09:00", "IN"], ["09:01", "OUT"]]);
    expect(r.status).toBe("ABSENT");
    expect(r.checkOut).toEqual(at("09:01"));
    expect(r.issues).toEqual([]);
  });
  it("no session length is held as a conflict any more", () => {
    for (const out of ["09:01", "09:04", "09:06", "09:08"])
      expect(run([["09:00", "IN"], [out, "OUT"]]).status).not.toBe("PUNCH_CONFLICT");
    expect(run([["09:00", "IN"], ["09:08", "OUT"]], { minSessionMinutes: 10 }).status).not.toBe("PUNCH_CONFLICT");
  });
  it("the real check-out that arrives later replaces the short one", () => {
    expect(run([["09:00", "IN"], ["09:01", "OUT"], ["18:00", "OUT"]]).status).toBe("PRESENT");
  });
  it("a normal full day is unaffected", () => {
    expect(run([["09:00", "IN"], ["18:00", "OUT"]]).status).toBe("PRESENT");
  });
  it("a normal day with a short break is unaffected", () => {
    expect(run([["09:00", "IN"], ["13:00", "OUT"], ["13:03", "IN"], ["18:00", "OUT"]]).status).toBe("PRESENT");
  });
});
