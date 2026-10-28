// Plan item 2.5 (D3): a session under the floor is a punch conflict, not an early checkout.
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

describe("minimum session length", () => {
  it("09:00 IN / 09:01 OUT is a punch conflict, not an early checkout", () => {
    const r = run([["09:00", "IN"], ["09:01", "OUT"]]);
    expect(r.status).toBe("PUNCH_CONFLICT");
    expect(r.requiresRegularization).toBe(true);
    expect(r.dayCredit).toBeNull();
    expect(r.issues[0].code).toBe("SESSION_TOO_SHORT");
    expect(r.anomalies.some((a) => a.type === "EARLY_CHECKOUT")).toBe(false);
  });
  it("a 4 minute session is held, a 6 minute one is a real (short) session", () => {
    expect(run([["09:00", "IN"], ["09:04", "OUT"]]).status).toBe("PUNCH_CONFLICT");
    expect(run([["09:00", "IN"], ["09:06", "OUT"]]).status).not.toBe("PUNCH_CONFLICT");
  });
  it("the floor is configurable and 0 turns it off", () => {
    expect(run([["09:00", "IN"], ["09:08", "OUT"]], { minSessionMinutes: 10 }).status).toBe("PUNCH_CONFLICT");
    expect(run([["09:00", "IN"], ["09:01", "OUT"]], { minSessionMinutes: 0 }).status).not.toBe("PUNCH_CONFLICT");
  });
  it("a normal full day is unaffected", () => {
    expect(run([["09:00", "IN"], ["18:00", "OUT"]]).status).toBe("PRESENT");
  });
  it("a normal day with a short break is unaffected", () => {
    expect(run([["09:00", "IN"], ["13:00", "OUT"], ["13:03", "IN"], ["18:00", "OUT"]]).status).not.toBe("PUNCH_CONFLICT");
  });
});
