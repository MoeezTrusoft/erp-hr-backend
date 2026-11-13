import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { applyEvaluatedShifts } from "../../src/services/attendanceWriter.service.js";

// A night shift 20:00-05:00. The setup is effective from 2026-10-01, so the departure punched at
// 05:03 on 1 Oct belongs to the shift of 30 Sep, which this setup does not cover.
const at = (d, t) => new Date(`${d}T${t}:00Z`);
const config = {
  version: 3,
  settings: { timeZone: "Asia/Karachi", defaultCalendarId: 1, profiles: [], assignments: [], staffingTargets: [] },
  policy: { graceMinutes: 5, checkoutLeniencyMin: 540 },
  employees: [{ id: 1, payroll_included: true, hire_date: "2026-01-01" }],
  periods: [],
  schedules: [{ employeeId: 1, effective_start_date: "2026-01-01", schedule_pattern: { shift: { from: "20:00", to: "05:00" }, offDays: [] } }],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
};
const punch = (id, d, t, status) => ({ id, tenantId: TENANT, employeeId: 1, sn: "DEVICE-1", punchedAt: at(d, t), status, directionVerified: true });
const run = (punches, from = "2026-10-01") => {
  const db = captureDb({
    attendanceSetupRelease: [{ id: 3, tenantId: TENANT, version: 3, effectiveFrom: new Date(from), coverageThrough: new Date("2026-12-31"), config }],
    attendanceDevicePunch: punches,
  });
  return applyEvaluatedShifts({ tenantId: TENANT, from: "2026-10-01", to: "2026-10-01", db, dryRun: false, now: new Date("2026-10-05") }).then(() => db.snapshot());
};

describe("the first covered day of a setup", () => {
  it("does not turn the previous night's departure into a punch conflict", async () => {
    const snap = await run([punch(1, "2026-10-01", "05:03", 1), punch(2, "2026-10-01", "20:02", 0), punch(3, "2026-10-02", "05:04", 1)]);
    const rows = snap.attendance.filter((a) => a.date.toISOString().startsWith("2026-10-01"));
    expect(rows.map((r) => r.status)).not.toContain("PUNCH_CONFLICT");
    expect(rows[0].status).toBe("PRESENT");
  });
});
