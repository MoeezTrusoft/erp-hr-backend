// O-05: health check thresholds. Edge cases a payroll/T&A QA would try.
import { describe, it, expect } from "@jest/globals";
import { evaluateHealth } from "../../src/lib/opsHealth.js";

const now = new Date("2026-11-09T12:00:00Z");
const ago = (ms) => new Date(+now - ms);
const MIN = 60000, DAY = 86400000;
const get = (r, code) => r.checks.find((c) => c.code === code);

describe("evaluateHealth", () => {
  it("is OK with nothing to report", () => {
    const r = evaluateHealth({ now });
    expect(r.overall).toBe("OK");
    expect(r.checks.every((c) => c.status === "OK" && c.count === 0)).toBe(true);
  });

  it("flags active devices silent beyond their own window, never inactive ones", () => {
    const r = evaluateHealth({
      now,
      devices: [
        { sn: "A", name: "fresh", active: true, lastSeenAt: ago(29 * MIN), staleAfterMinutes: 30 },
        { sn: "B", name: "stale", active: true, lastSeenAt: ago(31 * MIN), staleAfterMinutes: 30 },
        { sn: "C", name: "never", active: true, lastSeenAt: null, staleAfterMinutes: 30 },
        { sn: "D", name: "off", active: false, lastSeenAt: null },
        { sn: "E", name: "custom window", active: true, lastSeenAt: ago(90 * MIN), staleAfterMinutes: 120 },
        { sn: "F", name: "default window", active: true, lastSeenAt: ago(31 * MIN) },
      ],
    });
    expect(get(r, "DEVICE_STALE").items.map((i) => i.sn)).toEqual(["B", "C", "F"]);
    expect(get(r, "DEVICE_STALE").items[1].lastSeenAt).toBeNull();
    expect(r.overall).toBe("ATTENTION");
  });

  it("flags requests older than 5 days, oldest first, at the exact boundary not before", () => {
    const r = evaluateHealth({
      now,
      anomalies: [
        { id: 3, createdAt: ago(5 * DAY), date: "2026-11-01" }, // exactly 5 days: not yet
        { id: 2, createdAt: ago(5 * DAY + 1), date: "2026-10-30" },
        { id: 1, createdAt: ago(20 * DAY), date: null },
      ],
    });
    expect(get(r, "CASES_AGED").items.map((i) => [i.id, i.ageDays])).toEqual([[1, 20], [2, 5]]);
    expect(get(r, "CASES_AGED").items[0].date).toBeNull();
  });

  it("flags runs left open 7+ days after the period, ignoring finalized and cancelled", () => {
    const run = (id, status, endDaysAgo) => ({ id, status, periodStart: ago((endDaysAgo + 30) * DAY), periodEnd: ago(endDaysAgo * DAY) });
    const r = evaluateHealth({ now, runs: [run(1, "COMPLETED", 8), run(2, "FINALIZED", 40), run(3, "CANCELLED", 40), run(4, "APPROVED", 7.5), run(5, "COMPLETED", 3), run(6, "FAILED", 50)] });
    expect(get(r, "RUNS_NOT_CLOSED").items.map((i) => i.id)).toEqual([6, 1, 4]);
    expect(get(r, "RUNS_NOT_CLOSED").items[0].daysSincePeriodEnd).toBe(50);
  });

  it("reports held payslips as a count", () => {
    expect(get(evaluateHealth({ now, heldPayslips: 2 }), "PAYSLIPS_HELD")).toMatchObject({ status: "ATTENTION", count: 2 });
    expect(get(evaluateHealth({ now, heldPayslips: 0 }), "PAYSLIPS_HELD").status).toBe("OK");
  });

  it("lists at most 10 items but still counts all of them", () => {
    const anomalies = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, createdAt: ago(10 * DAY) }));
    const c = get(evaluateHealth({ now, anomalies }), "CASES_AGED");
    expect(c.count).toBe(25);
    expect(c.items).toHaveLength(10);
  });

  it("thresholds can be overridden", () => {
    const r = evaluateHealth({ now, anomalies: [{ id: 1, createdAt: ago(2 * DAY) }], thresholds: { anomalyDays: 1, runDays: 7 } });
    expect(get(r, "CASES_AGED").count).toBe(1);
  });
});
