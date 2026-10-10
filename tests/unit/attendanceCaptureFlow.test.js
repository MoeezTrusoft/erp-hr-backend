import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { receiveCapture } from "../../src/services/attendanceCapture.service.js";
import { drainCapture } from "../../src/services/attendanceCaptureWorker.service.js";
const config = {
  version: 3,
  settings: {
    timeZone: "Asia/Karachi",
    defaultCalendarId: 1,
    profiles: [],
    assignments: [],
    staffingTargets: [],
  },
  policy: { graceMinutes: 5 },
  employees: [{ id: 1, payroll_included: true, hire_date: "2026-01-01" }],
  periods: [],
  schedules: [
    {
      employeeId: 1,
      effective_start_date: "2026-01-01",
      schedule_pattern: { shift: { from: "22:00", to: "06:00" }, offDays: [] },
    },
  ],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
};
const database = () =>
  captureDb({
    attendanceSetupRelease: [
      {
        id: 3,
        tenantId: TENANT,
        version: 3,
        effectiveFrom: new Date("2026-01-01"),
        coverageThrough: new Date("2026-12-31"),
        config,
      },
    ],
  });
const now = new Date("2027-01-01T00:00:00Z");
describe("capture through the real published evaluator and writer", () => {
  it("an out-of-order overnight pair produces one shift using its published configuration", async () => {
    const db = database();
    await receiveCapture(
      { sn: "DEVICE-1", rows: ["101\t2026-10-02 06:00:00\t1"] },
      db,
    );
    await receiveCapture(
      { sn: "DEVICE-1", rows: ["101\t2026-10-01 22:00:00\t0"] },
      db,
    );
    const outcome = await drainCapture({ now }, db);
    expect(outcome.failed).toBe(0);
    const rows = db
      .snapshot()
      .attendance.filter((r) => r.check_in || r.check_out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "PRESENT",
      setupVersion: 3,
      total_hours: 8,
    });
    expect(rows[0].check_in.toISOString()).toBe("2026-10-01T22:00:00.000Z");
    expect(rows[0].check_out.toISOString()).toBe("2026-10-02T06:00:00.000Z");
  });
  it("a manual correction survives capture while original punch evidence remains available", async () => {
    const db = database();
    const protectedDay = await db.attendance.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        date: new Date("2026-10-01"),
        status: "PRESENT",
        check_in: new Date("2026-10-01T21:55:00Z"),
        check_out: new Date("2026-10-02T06:01:00Z"),
        manually_corrected: true,
        correction_reason: "HR reviewed",
      },
    });
    await receiveCapture(
      {
        sn: "DEVICE-1",
        rows: ["101\t2026-10-01 23:00:00\t0", "101\t2026-10-02 06:00:00\t1"],
      },
      db,
    );
    expect((await drainCapture({ now }, db)).failed).toBe(0);
    expect(
      db.snapshot().attendance.find((r) => r.id === protectedDay.id),
    ).toEqual(protectedDay);
    expect(db.snapshot().attendanceDevicePunch).toHaveLength(2);
  });
  it("holds missing published setup for review without inventing absence", async () => {
    const db = captureDb();
    await receiveCapture(
      { sn: "DEVICE-1", rows: ["101\t2026-10-01 09:00:00\t0"] },
      db,
    );
    expect((await drainCapture({ now }, db)).failed).toBe(0);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: "SETUP_REQUIRED",
    });
    expect(db.snapshot().attendance.every((r) => r.status !== "ABSENT")).toBe(
      true,
    );
  });
});

describe('capture at a protected month boundary',()=>{
  it('does not block a new shift just because the prior month is protected',async()=>{
    const db=database();
    await db.payrollRun.create({data:{tenantId:TENANT,periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30T23:59:59Z'),status:'PENDING'}});
    await receiveCapture({sn:'DEVICE-1',rows:['101\t2026-10-01 22:00:00\t0','101\t2026-10-02 06:00:00\t1']},db);
    expect((await drainCapture({now},db)).failed).toBe(0);
    expect(db.snapshot().attendance.find(r=>r.date.toISOString().startsWith('2026-10-01'))).toMatchObject({status:'PRESENT'});
  });
  it('keeps a late checkout for a protected overnight shift in review',async()=>{
    const db=database();
    await db.attendanceDevicePunch.create({data:{tenantId:TENANT,employeeId:1,sn:'DEVICE-1',status:0,punchedAt:new Date('2026-09-30T22:00:00Z')}});
    await db.payrollRun.create({data:{tenantId:TENANT,periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30T23:59:59Z'),status:'PENDING'}});
    await receiveCapture({sn:'DEVICE-1',rows:['101\t2026-10-01 06:00:00\t1']},db);
    expect((await drainCapture({now},db)).failed).toBe(1);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({state:'NEEDS_REVIEW',reason:expect.stringContaining('PERIOD_PROTECTED')});
  });
});
