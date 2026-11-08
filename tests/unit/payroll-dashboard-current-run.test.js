// Register row 363: the dashboard's "current" run must never be a cancelled or
// future-dated run (production had CANCELLED 2099 test runs shadowing October).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const findFirst = jest.fn();
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: { payrollRun: { findFirst } },
}));
const { resolveCurrentRun } = await import("../../src/services/payrollDashboard.service.js");

beforeEach(() => findFirst.mockReset());

describe("resolveCurrentRun", () => {
  it("excludes cancelled and future-dated runs from both lookups", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 36 });
    expect(await resolveCurrentRun({ tenantId: "t1" })).toEqual({ id: 36 });
    expect(findFirst).toHaveBeenCalledTimes(2);
    for (const [{ where }] of findFirst.mock.calls) {
      const flat = JSON.stringify(where);
      expect(flat).toContain('"status":{"not":"CANCELLED"}');
      expect(flat).toContain('"periodStart":{"lte"');
    }
  });
  it("treats a month as started from local midnight in UTC+5 (PKT), not 05:00", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-31T20:00:00Z")); // 1 Nov 01:00 PKT
    try {
      findFirst.mockResolvedValueOnce({ id: 40 });
      await resolveCurrentRun({ tenantId: "t1" });
      const lte = JSON.stringify(findFirst.mock.calls[0][0].where).match(/"periodStart":\{"lte":"([^"]+)"/)[1];
      expect(new Date(lte) >= new Date("2026-11-01T00:00:00Z")).toBe(true);
      expect(new Date(lte) < new Date("2026-11-02T00:00:00Z")).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
  it("returns null when every run is cancelled (callers render an empty dashboard)", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await resolveCurrentRun({ tenantId: "t1" })).toBeNull();
  });
  it("still opens an explicitly requested run, cancelled or not", async () => {
    findFirst.mockResolvedValueOnce({ id: 30, status: "CANCELLED" });
    expect(await resolveCurrentRun({ tenantId: "t1", runId: 30 })).toEqual({ id: 30, status: "CANCELLED" });
    expect(JSON.stringify(findFirst.mock.calls[0][0].where)).not.toContain("CANCELLED");
  });
});
