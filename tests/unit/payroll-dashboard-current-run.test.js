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
  it("still opens an explicitly requested run, cancelled or not", async () => {
    findFirst.mockResolvedValueOnce({ id: 30, status: "CANCELLED" });
    expect(await resolveCurrentRun({ tenantId: "t1", runId: 30 })).toEqual({ id: 30, status: "CANCELLED" });
    expect(JSON.stringify(findFirst.mock.calls[0][0].where)).not.toContain("CANCELLED");
  });
});
