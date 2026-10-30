import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { applyEvaluatedShifts } from "../../src/services/attendanceWriter.service.js";

// Mon-Fri 18:00-05:00 night shift, Saturday and Sunday off. 2026-10-03 is a Saturday.
const at = (d, t) => new Date(`${d}T${t}:00Z`);
const config = (holidays = []) => ({
  version: 3,
  settings: { timeZone: "Asia/Karachi", defaultCalendarId: 1, profiles: [], assignments: [], staffingTargets: [] },
  policy: { graceMinutes: 5, checkoutLeniencyMin: 540 },
  employees: [{ id: 1, payroll_included: true, hire_date: "2026-01-01" }],
  periods: [],
  schedules: [{ employeeId: 1, effective_start_date: "2026-01-01", schedule_pattern: { shift: { from: "18:00", to: "05:00" }, offDays: [6, 7] } }],
  calendars: [{ id: 1, year: 2026 }],
  holidays,
  calendarAssignments: holidays.length ? [{ employeeId: 1, holidayCalendarId: 1, effectiveFrom: "2026-01-01" }] : [],
});
const punch = (id, d, t, status) => ({ id, tenantId: TENANT, employeeId: 1, sn: "D1", punchedAt: at(d, t), status, directionVerified: true });
const evaluate = async (punches, day, holidays) => {
  const db = captureDb({
    attendanceSetupRelease: [{ id: 3, tenantId: TENANT, version: 3, effectiveFrom: new Date("2026-01-01"), coverageThrough: new Date("2026-12-31"), config: config(holidays) }],
    attendanceDevicePunch: punches,
  });
  await applyEvaluatedShifts({ tenantId: TENANT, from: day, to: day, db, dryRun: false, now: new Date("2026-10-12") });
  return db.snapshot();
};
const row = (snap, day) => snap.attendance.find((a) => a.date.toISOString().startsWith(day));

describe("work on a weekly off", () => {
  it("is never late: arriving 31 minutes after the rostered start is just extra work", async () => {
    const snap = await evaluate([punch(1, "2026-10-03", "18:31", 0), punch(2, "2026-10-04", "06:00", 1)], "2026-10-03");
    expect(row(snap, "2026-10-03")).toMatchObject({ status: "PRESENT", day_credit: 1 });
    expect(snap.attendanceAnomaly.filter((a) => a.date.toISOString().startsWith("2026-10-03"))).toHaveLength(0);
  });
  it("is never an early check-out or a short day", async () => {
    const snap = await evaluate([punch(1, "2026-10-03", "18:00", 0), punch(2, "2026-10-03", "19:00", 1)], "2026-10-03");
    expect(row(snap, "2026-10-03")).toMatchObject({ status: "PRESENT", day_credit: 1 });
    expect(snap.attendanceAnomaly).toHaveLength(0);
  });
  it("is the same on a holiday", async () => {
    const snap = await evaluate([punch(1, "2026-10-02", "19:00", 0), punch(2, "2026-10-02", "21:00", 1)], "2026-10-02", [{ holidayCalendarId: 1, date: "2026-10-02", fullDay: true }]);
    expect(row(snap, "2026-10-02")).toMatchObject({ status: "PRESENT", day_credit: 1 });
    expect(snap.attendanceAnomaly).toHaveLength(0);
  });
  it("leaves a rostered day alone: late is still late", async () => {
    const snap = await evaluate([punch(1, "2026-10-02", "18:31", 0), punch(2, "2026-10-03", "05:00", 1)], "2026-10-02");
    expect(row(snap, "2026-10-02").status).toBe("LATE");
    expect(snap.attendanceAnomaly.some((a) => a.type === "LATE_CHECKIN")).toBe(true);
  });
  it("a single punch on a weekly off stays a plain weekly off", async () => {
    const snap = await evaluate([punch(1, "2026-10-03", "18:31", 0)], "2026-10-03");
    expect(row(snap, "2026-10-03")).toMatchObject({ status: "WEEKLY_OFF", day_credit: 0 });
  });
});
