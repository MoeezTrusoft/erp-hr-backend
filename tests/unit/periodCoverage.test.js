import { describe, expect, it } from "@jest/globals";
import { periodCoverage } from "../../src/services/attendancePunchImport.service.js";

const d = (s) => new Date(`${s}T00:00:00Z`);
const db = {
  attendanceSetupRelease: {
    findMany: async () => [
      { version: 1, effectiveFrom: d("2026-10-13"), coverageThrough: d("2026-12-31"), reason: "first", publishedAt: d("2026-10-12") },
      { version: 2, effectiveFrom: d("2026-10-20"), coverageThrough: d("2026-12-31"), reason: "second", publishedAt: d("2026-10-19") },
    ],
  },
  employee: {
    findMany: async () => [
      { id: 1, employee_code: "E1", first_name: "Ada", last_name: "K", hire_date: d("2026-09-01") },
      { id: 2, employee_code: "E2", first_name: "Bo", last_name: null, hire_date: d("2026-10-18") },
    ],
  },
  workSchedule: {
    findMany: async () => [
      { employeeId: 1, effective_start_date: d("2026-09-01"), effective_end_date: null },
      { employeeId: 2, effective_start_date: d("2026-10-20"), effective_end_date: null },
    ],
  },
};

describe("periodCoverage", () => {
  it("splits by setup version, reports uncovered days and roster gaps", async () => {
    const r = await periodCoverage({ tenantId: "t", from: "2026-10-10", to: "2026-10-22" }, db);
    expect(r.noSetup).toEqual([{ from: "2026-10-10", to: "2026-10-12" }]);
    expect(r.segments.map((s) => [s.version, s.from, s.to])).toEqual([
      [1, "2026-10-13", "2026-10-19"],
      [2, "2026-10-20", "2026-10-22"],
    ]);
    expect(r.rosterGaps).toHaveLength(1);
    expect(r.rosterGaps[0]).toMatchObject({ employeeId: 2, days: 2, ranges: [{ from: "2026-10-18", to: "2026-10-19" }] });
  });
  it("rejects reversed or huge periods", async () => {
    await expect(periodCoverage({ tenantId: "t", from: "2026-10-22", to: "2026-10-10" }, db)).rejects.toThrow();
    await expect(periodCoverage({ tenantId: "t", from: "2020-01-01", to: "2026-10-10" }, db)).rejects.toThrow(/800/);
  });
});
