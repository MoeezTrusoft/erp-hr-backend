import { describe, it, expect } from "@jest/globals";
import { evaluateShift } from "../../src/lib/attendanceEvaluator.js";
import { deriveAttendanceStatus } from "../../src/lib/attendanceStatus.js";
import { sessioniseByRoster } from "../../src/lib/attendanceReplay.js";
import { resolveEmployeeDay } from "../../src/lib/attendanceSetup.js";
import { validateSchedulePattern } from "../../src/lib/schedulePattern.js";
import { shiftFor, nextShiftStart } from "../../src/lib/attendanceShift.js";
import { validateCheckoutWindow } from "../../src/lib/shiftCheckout.js";
import {
  applyShiftSupervisor,
  validateEmployeeShiftSequence,
  syncCurrentShiftSupervisors,
} from "../../src/services/shiftGovernance.service.js";
import { completeTimesheetRows } from "../../src/lib/timesheetRows.js";
import { listRuleCases } from "../../src/services/attendanceRules.service.js";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
describe('unevaluated calendar projection', () => {
  it('shows planned and setup states without inventing absence, hours or punches', () => {
    const runtime={resolve:(_id,day)=>day.toISOString().startsWith('2026-10-14') ? {working:null,reason:'MISSING_ROSTER'} : {working:true,timeZone:'Asia/Karachi',shift:{start:new Date(day.toISOString().slice(0,10)+'T09:00:00Z')}}};
    // 14 Oct 04:00Z is 09:00 in Karachi: every day of the window has begun.
    const result = completeTimesheetRows({ records:[], employees:[{id:1}], anomalies:[], from:'2026-10-12',to:'2026-10-14',now:new Date('2026-10-14T04:00:00Z'), runtime });
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({status:'PENDING_ATTENDANCE',calendarStatus:'WORKDAY',processingState:'AWAITING_EVALUATION',total_hours:null,check_in:null});
    expect(result[1]).toMatchObject({status:'PENDING_ATTENDANCE',processingState:'AWAITING_EVALUATION'});
    expect(result[2]).toMatchObject({status:'SETUP_REQUIRED',calendarStatus:null,total_hours:null});
    // ATT-DUE-ROWS-01 — on the 12th at 09:00 only the 12th is due.
    const due = completeTimesheetRows({ records:[], employees:[{id:1}], anomalies:[], from:'2026-10-12',to:'2026-10-14',now:new Date('2026-10-12T04:00:00Z'), runtime });
    expect(due.map(r=>r.date.toISOString().slice(0,10))).toEqual(['2026-10-12']);
  });
});
const at = (t) => new Date("2026-10-12T" + t + "Z");
const window = {
  from: "09:00",
  to: "17:00",
  checkoutCutoffTime: "22:00",
  checkoutCutoffDayOffset: 0,
};
const pattern = { shift: window, offDays: [] };
const punch = (time, status) => ({
  punchedAt: new Date(time),
  status,
  sn: "A",
  directionVerified: true,
});

describe("exact grace boundaries", () => {
  it.each([0, 5])(
    "counts the check-in grace in whole minutes (%i): the last second of the grace minute is on time, the next minute is late",
    (grace) => {
      const start = at("09:00:00"),
        end = at("17:00:00");
      const run = (incoming, outgoing) =>
        evaluateShift({
          shift: { start, end },
          now: at("23:00:00"),
          policy: { graceMinutes: grace, earlyLeaveGraceMin: grace },
          punches: [
            { type: "IN", timestamp: incoming },
            { type: "OUT", timestamp: outgoing },
          ],
        });
      const inBoundary = new Date(+start + grace * 60000),
        outBoundary = new Date(+end - grace * 60000);
      expect(run(inBoundary, outBoundary).anomalies).toEqual([]);
      // Inside the grace minute (09:05:59 with 5 minutes) is still on time; 09:06:00 is late.
      expect(run(new Date(+inBoundary + 59000), end).anomalies).toEqual([]);
      expect(
        run(new Date(+inBoundary + 60000), end).anomalies.some(
          (a) => a.type === "LATE_CHECKIN",
        ),
      ).toBe(true);
      expect(
        run(start, new Date(+outBoundary - 1000)).anomalies.some(
          (a) => a.type === "EARLY_CHECKOUT",
        ),
      ).toBe(true);
    },
  );
  it("preserves seconds in the legacy status writer", () => {
    expect(deriveAttendanceStatus(at("09:00:00"), 540)).toBe("PRESENT");
    expect(deriveAttendanceStatus(at("09:00:01"), 540)).toBe("LATE");
  });
});
describe("checkout cutoff and employee schedule", () => {
  it("accepts exactly one hour and rejects a minute less across a rotation", () => {
    const make = (time) => ({
      rotatingShifts: [
        {
          from: "20:00",
          to: "05:00",
          checkoutCutoffTime: time,
          checkoutCutoffDayOffset: 1,
        },
        { from: "09:00", to: "17:00" },
      ],
      cycle: { days: 3, anchor: "2026-10-12", sequence: [0, 1, null] },
    });
    expect(validateSchedulePattern(make("08:00")).valid).toBe(true);
    expect(validateSchedulePattern(make("08:01")).valid).toBe(false);
  });
  it("uses this employee’s next scheduled day and skips weekly off", () => {
    const p = { ...pattern, offDays: [6, 7] };
    expect(
      nextShiftStart(p, shiftFor(p, new Date("2026-10-16"))).toISOString(),
    ).toBe("2026-10-19T09:00:00.000Z");
  });
  it("validates a new earlier shift against the previous version’s cutoff", () => {
    const schedules = [
      {
        effective_start_date: "2026-10-01",
        effective_end_date: "2026-10-12",
        schedule_pattern: {
          shift: {
            ...window,
            checkoutCutoffTime: "08:30",
            checkoutCutoffDayOffset: 1,
          },
        },
      },
      { effective_start_date: "2026-10-13", schedule_pattern: pattern },
    ];
    expect(() => validateEmployeeShiftSequence(schedules)).toThrow(/one hour/);
  });
  it("does not close an earlier shift after cutoff; keeps the late punch flagged", () => {
    const sessions = sessioniseByRoster(
      [punch("2026-10-12T09:00:00Z", 0), punch("2026-10-12T23:00:00Z", 1)],
      pattern,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0].punches).toHaveLength(1);
    expect(sessions[1].unassigned).toBe(true);
    const verdict = evaluateShift({
      shift: shiftFor(pattern, new Date("2026-10-12")),
      now: at("23:30:00"),
      punches: [
        { type: "IN", timestamp: at("09:00:00") },
        { type: "OUT", timestamp: at("23:00:00") },
      ],
    });
    expect(verdict.status).toBe("PUNCH_CONFLICT");
    expect(verdict.checkOut).toBeNull();
    expect(verdict.workedMinutes).toBe(0);
  });
  it("accepts checkout at cutoff and sends a later authenticated IN to the next shift", () => {
    const p = {
      shift: {
        from: "20:00",
        to: "05:00",
        checkoutCutoffTime: "08:00",
        checkoutCutoffDayOffset: 1,
      },
    };
    const sessions = sessioniseByRoster(
      [
        punch("2026-10-12T20:00:00Z", 0),
        punch("2026-10-13T08:00:00Z", 1),
        punch("2026-10-13T20:00:00Z", 0),
      ],
      p,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0].punches).toHaveLength(2);
    expect(sessions[1].day.toISOString().slice(0, 10)).toBe("2026-10-13");
  });
  it("rejects malformed and pre-end cutoffs", () => {
    expect(() =>
      validateCheckoutWindow({ ...window, checkoutCutoffTime: "25:00" }),
    ).toThrow();
    expect(() =>
      validateCheckoutWindow({ ...window, checkoutCutoffTime: "16:00" }),
    ).toThrow();
    expect(validateSchedulePattern({ shift: window, shifts: {} }).valid).toBe(
      false,
    );
  });
  it("inherits roster hours for work-mode-only overrides and validates their next shift", () => {
    const schedules = [
      { effective_start_date: "2026-10-01", schedule_pattern: pattern },
    ];
    expect(() =>
      validateEmployeeShiftSequence(schedules, [
        { date: "2026-10-12", status: "on_shift", workMode: "remote" },
      ]),
    ).not.toThrow();
    expect(() =>
      validateEmployeeShiftSequence(schedules, [
        {
          date: "2026-10-12",
          status: "on_shift",
          fromTime: "20:00",
          toTime: "05:00",
          checkoutCutoffTime: "08:01",
          checkoutCutoffDayOffset: 1,
        },
        { date: "2026-10-13", status: "on_shift", workMode: "remote" },
      ]),
    ).toThrow(/one hour/);
  });
  it("applies a dated shift over a rotation rest day while preserving its calendar label", () => {
    const employee = { id: 1, hire_date: "2020-01-01" };
    const config = {
      settings: { defaultCalendarId: 1 },
      employees: [employee],
      calendars: [{ id: 1 }],
      schedules: [
        {
          employeeId: 1,
          effective_start_date: "2020-01-01",
          schedule_pattern: {
            rotatingShifts: [{ from: "09:00", to: "17:00" }],
            cycle: { days: 2, anchor: "2026-10-11", sequence: [0, null] },
          },
        },
      ],
    };
    const info = resolveEmployeeDay(config, employee, "2026-10-12", {
      assignments: [
        {
          employeeId: 1,
          date: "2026-10-12",
          status: "on_shift",
          fromTime: "20:00",
          toTime: "05:00",
          checkoutCutoffTime: "07:00",
          checkoutCutoffDayOffset: 1,
        },
      ],
    });
    expect(info.working).toBe(true);
    expect(info.calendarStatus).toBe("WEEKLY_OFF");
    expect(info.shift.start.toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(info.shift.checkoutCutoff.toISOString()).toBe(
      "2026-10-13T07:00:00.000Z",
    );
  });
});
describe("department shift reporting", () => {
  const member = {
    id: 1,
    tenant_id: TENANT,
    employee_code: "EMP-001",
    businessUnitId: 3,
    managerId: 2,
    status: "Active",
    version: 1,
  };
  const supervisor = {
    id: 4,
    tenant_id: TENANT,
    employee_code: "EMP-004",
    managerId: null,
    status: "Active",
  };
  const template = {
    id: 10,
    tenantId: TENANT,
    departmentId: 3,
    supervisorId: 4,
    fromTime: "20:00",
    toTime: "05:00",
  };
  const setup = () =>
    captureDb({
      employee: [
        member,
        { id: 2, tenant_id: TENANT, employee_code: "EMP-002" },
        supervisor,
      ],
      shiftTemplate: [template],
    });
  const apply = (db) =>
    applyShiftSupervisor(db, {
      tenantId: TENANT,
      employee: member,
      window: { templateId: 10 },
      effectiveDate: "2026-10-12",
      nowDate: "2026-10-12",
      actorId: "hr-user",
    });
  it("reassigns the direct manager with employee codes in the audit trail", async () => {
    const db = setup();
    await apply(db);
    expect(db.snapshot().employee[0].managerId).toBe(4);
    expect(db.snapshot().attendanceRuleAudit[0].data).toMatchObject({
      employeeCode: "EMP-001",
      previousSupervisorCode: "EMP-002",
      supervisorCode: "EMP-004",
    });
  });
  it("leaves Reports To unchanged without a supervisor", async () => {
    const db = captureDb({
      employee: [member],
      shiftTemplate: [{ ...template, supervisorId: null }],
    });
    expect(await apply(db)).toBe(false);
    expect(db.snapshot().employee[0].managerId).toBe(2);
    expect(db.snapshot().attendanceRuleAudit).toEqual([]);
  });
  it("rejects foreign-company shifts and reporting cycles", async () => {
    await expect(
      apply(
        captureDb({ shiftTemplate: [{ ...template, tenantId: OTHER_TENANT }] }),
      ),
    ).rejects.toThrow(/company/);
    await expect(
      apply(
        captureDb({
          shiftTemplate: [template],
          employee: [member, { ...supervisor, managerId: 1 }],
        }),
      ),
    ).rejects.toThrow(/cycle/);
  });
  it("does not apply future assignments early, then applies them on the scheduled date", async () => {
    const db = setup();
    await db.shiftAssignment.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        date: new Date("2026-10-13"),
        templateId: 10,
      },
    });
    await syncCurrentShiftSupervisors(db, TENANT, "2026-10-12");
    expect(db.snapshot().employee[0].managerId).toBe(2);
    await syncCurrentShiftSupervisors(db, TENANT, "2026-10-13");
    expect(db.snapshot().employee[0].managerId).toBe(4);
    await syncCurrentShiftSupervisors(db, TENANT, "2026-10-13");
    expect(db.snapshot().attendanceRuleAudit).toHaveLength(1);
  });
});
describe("timesheet and anomaly projection", () => {
  it("shows calendar days, keeps observed hours, and attaches missing absence rows", () => {
    const employee = { id: 1, employee_code: "EMP-001" };
    const rows = completeTimesheetRows({
      employees: [employee],
      records: [
        {
          employeeId: 1,
          date: new Date("2026-10-13"),
          check_in: at("09:00:00"),
          check_out: at("13:00:00"),
          total_hours: 3.5,
          status: "PRESENT",
        },
      ],
      anomalies: [
        {
          employeeId: 1,
          date: new Date("2026-10-14"),
          type: "ABSENT",
          evidenceState: "ACTIVE",
        },
      ],
      from: "2026-10-12",
      to: "2026-10-14",
      runtime: {
        resolve: (_id, day) => ({
          working: day.getUTCDate() === 14,
          calendarStatus:
            day.getUTCDate() === 12
              ? "WEEKLY_OFF"
              : day.getUTCDate() === 13
                ? "HOLIDAY"
                : null,
        }),
      },
    });
    expect(rows.find((r) => r.calendarStatus === "HOLIDAY")).toMatchObject({
      status: 'PRESENT',
      total_hours: 3.5,
      check_in: at("09:00:00"),
      check_out: at("13:00:00"),
    });
    expect(rows.map((r) => r.status).sort()).toEqual([
      "ABSENT",
      "PRESENT",
      "WEEKLY_OFF",
    ]);
  });
  it("cards count exactly the paginated review records, including legacy cases and status filters", async () => {
    const db = captureDb({
      employee: [{ id: 1, tenant_id: TENANT, employee_code: "EMP-001" }],
      attendanceAnomaly: [
        ...[
          "ABSENT",
          "LATE_CHECKIN",
          "EARLY_CHECKOUT",
          "MISSING_CHECKOUT",
        ].map((type, i) => ({
          id: i + 1,
          tenantId: TENANT,
          employeeId: 1,
          date: new Date("2026-10-12"),
          type,
          status: i % 2 ? "APPROVED" : "PENDING",
          evidenceState: "ACTIVE",
          rulesVersion: i === 3 ? 1 : 2,
        })),
        // TS-KPI-01 — a case the evaluator closed is no longer detected, and an
        // older legacy row beside its rules-v2 successor is the same day.
        {
          id: 5,
          tenantId: TENANT,
          employeeId: 1,
          date: new Date("2026-10-12"),
          type: "LATE_CHECKIN",
          status: "RESOLVED",
          evidenceState: "RESOLVED",
          rulesVersion: 2,
        },
        {
          id: 6,
          tenantId: TENANT,
          employeeId: 1,
          date: new Date("2026-10-12"),
          type: "ABSENT",
          status: "PENDING",
          evidenceState: "ACTIVE",
          rulesVersion: 1,
        },
      ],
    });
    const query = {
      user: { tenantId: TENANT, roles: ["HR Manager"] },
      from: "2026-10-01",
      to: "2026-10-31",
      pageSize: 2,
    };
    const a = await listRuleCases(query, db),
      b = await listRuleCases({ ...query, page: 2 }, db),
      c = await listRuleCases({ ...query, page: 3 }, db);
    // Tiles: distinct, still-detected employee-days. The review table still
    // lists every record, so `total` is the number of records.
    expect(a.summary).toEqual({
      absent: 1,
      late: 1,
      early: 1,
      other: 1,
      total: 6,
      open: 2,
    });
    expect([...a.items, ...b.items, ...c.items]).toHaveLength(a.summary.total);
    const pending = await listRuleCases({ ...query, status: "PENDING" }, db);
    // Three PENDING records, listed two to a page.
    expect(pending.summary.total).toBe(3);
    expect(pending.total).toBe(3);
    expect(pending.items).toHaveLength(2);
  });
});
