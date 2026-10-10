import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { accountAttendance } from "../../src/lib/attendanceIntervals.js";
import { evaluateSiteEvidence } from "../../src/lib/attendanceSiteRules.js";
import { evaluateShift } from "../../src/lib/attendanceEvaluator.js";
import { applyEvaluatedShifts } from "../../src/services/attendanceWriter.service.js";
import {
  attendanceCompleteness,
  saveAttendanceTimeCredit,
  reviewAttendancePunch,
} from "../../src/services/attendanceEvaluation.service.js";
import {
  drainAttendanceFinalization,
  planAttendanceFinalization,
} from "../../src/services/attendanceFinalization.service.js";
const date = "2026-10-01",
  at = (t) => new Date(date + "T" + t + ":00Z");
const shift = { start: at("09:00"), end: at("17:00") };
const records = (items) =>
  items.map(([t, type]) => ({
    timestamp: at(t),
    type,
    directionVerified: true,
  }));
const score = (items, extra = {}) =>
  evaluateShift({
    shift,
    punches: records(items),
    now: new Date("2026-10-03"),
    ...extra,
  });
const config = (
  pattern = { shift: { from: "09:00", to: "17:00" }, offDays: [] },
) => ({
  version: 3,
  settings: {
    timeZone: "Asia/Karachi",
    defaultCalendarId: 1,
    profiles: [],
    assignments: [],
    staffingTargets: [],
  },
  policy: { graceMinutes: 5, checkoutLeniencyMin: 240 },
  employees: [{ id: 1, payroll_included: true, hire_date: "2026-01-01" }],
  periods: [],
  schedules: [
    {
      employeeId: 1,
      effective_start_date: "2026-01-01",
      schedule_pattern: pattern,
    },
  ],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
});
function database(items = [], configuration = config(), extra = {}) {
  return captureDb({
    attendanceSetupRelease: [
      {
        id: 3,
        tenantId: TENANT,
        version: 3,
        effectiveFrom: new Date("2026-01-01"),
        coverageThrough: new Date("2026-12-31"),
        config: configuration,
      },
    ],
    attendanceDevicePunch: items.map(([t, status], i) => ({
      id: i + 1,
      tenantId: TENANT,
      employeeId: 1,
      sn: "DEVICE-1",
      punchedAt: at(t),
      status,
      directionVerified: true,
    })),
    ...extra,
  });
}
const apply = (db, extra = {}) =>
  applyEvaluatedShifts({
    tenantId: TENANT,
    from: date,
    to: date,
    db,
    dryRun: false,
    now: new Date("2026-10-03"),
    ...extra,
  });
describe("interval attendance calculation", () => {
  it("never invents an OUT from repeated authenticated IN events", () => {
    expect(
      score([
        ["09:00", "IN"],
        ["17:00", "IN"],
      ]),
    ).toMatchObject({ status: "PUNCH_CONFLICT", dayCredit: null });
    expect(
      score(
        [
          ["09:00", "IN"],
          ["17:00", "IN"],
        ],
        { policy: { trustDeviceDirection: false } },
      ).dayCredit,
    ).toBeNull();
  });
  it("excludes an actual exit/re-entry gap", () => {
    expect(
      score([
        ["09:00", "IN"],
        ["12:00", "OUT"],
        ["15:00", "IN"],
        ["17:00", "OUT"],
      ]),
    ).toMatchObject({ workedMinutes: 300, presenceMinutes: 300 });
  });
  it("does not subtract an absent lunch interval twice", () => {
    expect(
      score(
        [
          ["09:00", "IN"],
          ["12:00", "OUT"],
          ["13:00", "IN"],
          ["17:00", "OUT"],
        ],
        {
          shift: {
            ...shift,
            exclusions: [{ start: at("12:00"), end: at("13:00") }],
          },
        },
      ).workedMinutes,
    ).toBe(420);
  });
  it("credits a scheduled paid break without inventing physical presence", () => {
    expect(
      score(
        [
          ["09:00", "IN"],
          ["12:00", "OUT"],
          ["13:00", "IN"],
          ["17:00", "OUT"],
        ],
        {
          shift: {
            ...shift,
            paidBreaks: [{ start: at("12:00"), end: at("13:00") }],
          },
        },
      ),
    ).toMatchObject({
      presenceMinutes: 420,
      paidBreakMinutes: 60,
      dayCredit: 1,
      payableMinutes: 480,
    });
  });
  it("holds a reopened interval and does not reuse its earlier OUT", () => {
    expect(
      score([
        ["09:00", "IN"],
        ["12:00", "OUT"],
        ["13:00", "IN"],
      ]),
    ).toMatchObject({
      status: "MISSING_CHECKOUT",
      dayCredit: null,
      workedMinutes: 180,
      checkOut: null,
    });
  });
});
describe("persisted evaluation and finalization", () => {
  it("uses the real Pakistan-time cutoff, without waiting for another scan", async () => {
    const db = database([["09:00", 0]]);
    await apply(db, { now: new Date(date + "T20:59:00+05:00") });
    expect(db.snapshot().attendance[0]).toMatchObject({
      processingState: "OPEN",
    });
    expect(
      db.snapshot().attendanceEvaluationJob[0].nextAttemptAt.toISOString(),
    ).toBe(date + "T16:00:00.000Z");
    await drainAttendanceFinalization(
      { now: new Date(date + "T21:01:00+05:00") },
      db,
    );
    expect(db.snapshot().attendance[0]).toMatchObject({
      status: "MISSING_CHECKOUT",
      processingState: "NEEDS_REVIEW",
    });
  });
  it("resolves system exceptions when delayed evidence completes the shift, preserving revisions", async () => {
    const db = database([["09:00", 0]]);
    await apply(db);
    await db.attendanceDevicePunch.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        sn: "DEVICE-1",
        punchedAt: at("17:00"),
        status: 1,
        directionVerified: true,
      },
    });
    await apply(db);
    expect(db.snapshot().attendance[0]).toMatchObject({
      status: "PRESENT",
      processingState: "FINALIZED",
    });
    expect(db.snapshot().attendanceAnomaly[0]).toMatchObject({
      status: "RESOLVED",
      evidenceState: "RESOLVED",
    });
    expect(db.snapshot().attendanceEvaluation).toHaveLength(2);
    await apply(db);
    expect(db.snapshot().attendanceEvaluation).toHaveLength(2);
  });
  it("does not overwrite a human anomaly decision when evidence changes", async () => {
    const db = database([["09:00", 0]]);
    await apply(db);
    await db.attendanceAnomaly.update({
      where: { id: db.snapshot().attendanceAnomaly[0].id },
      data: { status: "APPROVED", reviewerId: 9 },
    });
    await db.attendanceDevicePunch.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        sn: "DEVICE-1",
        punchedAt: at("17:00"),
        status: 1,
        directionVerified: true,
      },
    });
    await apply(db);
    expect(db.snapshot().attendanceAnomaly[0]).toMatchObject({
      status: "APPROVED",
      reviewerId: 9,
      evidenceState: "RESOLVED",
    });
  });
  it("creates separate split-shift records with one daily summary", async () => {
    const db = database(
      [
        ["09:00", 0],
        ["12:00", 1],
        ["15:00", 0],
        ["19:00", 1],
      ],
      config({
        shifts: [
          { from: "09:00", to: "12:00" },
          { from: "15:00", to: "19:00" },
        ],
        offDays: [],
      }),
    );
    await apply(db);
    expect(db.snapshot().attendance).toHaveLength(1);
    expect(db.snapshot().attendanceSession).toHaveLength(2);
    expect(db.snapshot().attendance[0]).toMatchObject({
      total_hours: 7,
      day_credit: 1,
    });
  });
  it("leaves a 22:00–06:00 shift open during the 03:00 sweep", async () => {
    const db = database(
      [],
      config({ shift: { from: "22:00", to: "06:00" }, offDays: [] }),
    );
    await apply(db, { now: new Date("2026-10-02T03:00:00+05:00") });
    expect(db.snapshot().attendance[0]).toMatchObject({
      status: "PENDING_ATTENDANCE",
      day_credit: null,
      processingState: "OPEN",
    });
  });
  it("retains a data hold while captured biometric evidence awaits review", async () => {
    const db = database([], config(), {
      attendanceCaptureEvent: [
        {
          id: "pending",
          tenantId: TENANT,
          employeeId: 1,
          state: "NEEDS_REVIEW",
          reason: "PAD_UNVERIFIED",
          parsed: { punchedAt: at("09:00").toISOString() },
        },
      ],
    });
    await apply(db);
    expect(db.snapshot().attendance[0]).toMatchObject({
      day_credit: null,
      processingState: "AWAITING_DATA",
    });
  });
  it("refuses replay inside a protected payroll period", async () => {
    const db = database(
      [
        ["09:00", 0],
        ["17:00", 1],
      ],
      config(),
      {
        payrollRun: [
          {
            id: 1,
            tenantId: TENANT,
            status: "PENDING",
            periodStart: new Date(date),
            periodEnd: new Date("2026-10-31"),
          },
        ],
      },
    );
    await expect(apply(db)).rejects.toThrow("PERIOD_PROTECTED");
    expect(db.snapshot().attendance).toHaveLength(0);
  });
  it("plans exact work dates durably and resumes without duplicating jobs", async () => {
    const db = database();
    const now = new Date("2026-10-02T00:00:00+05:00");
    expect((await planAttendanceFinalization({ now }, db)).failures).toEqual(
      [],
    );
    await planAttendanceFinalization({ now }, db);
    expect(db.snapshot().attendanceEvaluationJob).toHaveLength(2);
  });
  it("detects a single missing day in an otherwise complete period", async () => {
    const db = database([
      ["09:00", 0],
      ["17:00", 1],
    ]);
    await apply(db);
    const result = await attendanceCompleteness(
      { tenantId: TENANT, from: date, to: "2026-10-02" },
      db,
    );
    expect(result.ready).toBe(false);
    expect(result.totals).toMatchObject({
      expectedDays: 2,
      finalizedDays: 1,
      missingDays: 1,
    });
  });
  it("rejects self-approved travel", async () => {
    const db = database();
    await expect(
      saveAttendanceTimeCredit(
        {
          tenantId: TENANT,
          employeeId: 1,
          date,
          kind: "TRAVEL",
          start: at("12:00").toISOString(),
          end: at("13:00").toISOString(),
          reason: "Site visit",
          actorId: "u1",
          actorEmployeeId: 1,
        },
        db,
      ),
    ).rejects.toThrow("own time credit");
  });
});

describe("site evidence, review and recovery safeguards", () => {
  it("does not double-subtract overlapping paid break and travel windows", () => {
    const interval = {
      start: at("09:00"),
      end: at("17:00"),
      elapsedMinutes: 480,
    };
    const result = accountAttendance(
      [interval],
      { ...shift, paidBreaks: [{ start: at("12:00"), end: at("13:00") }] },
      {},
      [{ kind: "TRAVEL", paid: true, start: at("12:00"), end: at("14:00") }],
    );
    expect(result).toMatchObject({
      regularMinutes: 480,
      travelMinutes: 0,
      payableMinutes: 480,
    });
  });
  it("does not deduct an overtime exclusion from regular work", () => {
    const result = accountAttendance(
      [{ start: at("08:00"), end: at("18:00"), elapsedMinutes: 600 }],
      { ...shift, exclusions: [{ start: at("08:00"), end: at("09:00") }] },
    );
    expect(result).toMatchObject({
      workedMinutes: 540,
      regularMinutes: 480,
      overtimeMinutes: 60,
    });
  });
  it("normalizes legacy and current timestamps before measuring elapsed work", async () => {
    const db = database([
      ["09:00", 0],
      ["17:00", 1],
    ]);
    await db.attendanceDevicePunch.update({
      where: { id: 2 },
      data: { occurredAt: new Date(date + "T12:00:00Z") },
    });
    await apply(db);
    expect(db.snapshot().attendance[0].total_hours).toBe(8);
  });
  it("holds absent employees when their configured device has no current evidence", async () => {
    const c = config();
    c.enrolments = [
      {
        employeeId: 1,
        sn: "DEVICE-1",
        isPrimary: true,
        effectiveFrom: "2026-01-01",
      },
    ];
    const db = database([], c);
    await apply(db);
    expect(db.snapshot().attendance[0]).toMatchObject({
      processingState: "AWAITING_DATA",
      day_credit: null,
    });
    expect(
      db.snapshot().attendance[0].calculation.verdict.issues,
    ).toContainEqual({ code: "DEVICE_DATA_UNCONFIRMED", sn: "DEVICE-1" });
  });
  it("never permits an approved transfer faster than the published route minimum", () => {
    const info = {
      sites: [{ id: "HO" }, { id: "SITE" }],
      siteAssignment: { siteIds: ["HO", "SITE"] },
      siteRoutes: [{ fromSiteId: "HO", toSiteId: "SITE", minimumMinutes: 30 }],
    };
    const punches = [
      { type: "OUT", timestamp: at("12:00"), siteId: "HO" },
      { type: "IN", timestamp: at("12:05"), siteId: "SITE" },
    ];
    const issues = evaluateSiteEvidence(punches, info, [
      {
        kind: "TRAVEL",
        fromSiteId: "HO",
        toSiteId: "SITE",
        start: at("12:00"),
        end: at("12:05"),
      },
    ]);
    expect(issues.map((i) => i.code)).toContain("IMPLAUSIBLE_SITE_TRANSFER");
  });
  it("requires captured departure and arrival evidence before approving paid travel", async () => {
    const c = config();
    c.settings.sites = [{ id: "HO" }, { id: "SITE" }];
    const db = database([], c);
    await expect(
      saveAttendanceTimeCredit(
        {
          tenantId: TENANT,
          employeeId: 1,
          date,
          kind: "TRAVEL",
          start: at("12:00"),
          end: at("13:00"),
          fromSiteId: "HO",
          toSiteId: "SITE",
          paid: true,
          reason: "Trip",
          actorId: "hr",
          actorEmployeeId: 2,
        },
        db,
      ),
    ).rejects.toThrow("recorded OUT");
    expect(db.snapshot().attendanceTimeCredit).toHaveLength(0);
  });
  it("retains original punches and audits a versioned exclusion, rejecting stale reviews", async () => {
    const db = database([
      ["09:00", 0],
      ["12:00", 0],
      ["17:00", 1],
    ]);
    await apply(db);
    await db.attendanceDevicePunch.update({
      where: { id: 2 },
      data: { exclusionVersion: 0 },
    });
    const args = {
      tenantId: TENANT,
      id: 2,
      version: 0,
      exclude: true,
      reason: "Duplicate confirmed",
      actorId: "hr",
      actorEmployeeId: 2,
    };
    await reviewAttendancePunch(args, db);
    expect(db.snapshot().attendanceDevicePunch).toHaveLength(3);
    expect(db.snapshot().attendanceDevicePunch[1]).toMatchObject({
      status: 0,
      exclusionVersion: 1,
      exclusionReason: "Duplicate confirmed",
    });
    expect(db.snapshot().attendance[0]).toMatchObject({
      status: "PRESENT",
      total_hours: 8,
    });
    expect(
      db
        .snapshot()
        .attendanceCaptureAudit.some((a) => a.action === "PUNCH_EXCLUDED"),
    ).toBe(true);
    await expect(reviewAttendancePunch(args, db)).rejects.toThrow(
      "Punch changed",
    );
  });
  it("respects a final request decision for a missing punch without waiving a capture hold", async () => {
    const db = database([["09:00", 0]]);
    await apply(db);
    await db.attendanceAnomaly.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        date: at("00:00"),
        sourceKind: "REGULARIZATION",
        status: "APPROVED",
      },
    });
    expect(
      (
        await attendanceCompleteness(
          { tenantId: TENANT, from: date, to: date },
          db,
        )
      ).ready,
    ).toBe(true);
    await db.attendanceCaptureEvent.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        state: "NEEDS_REVIEW",
        parsed: { punchedAt: at("17:00").toISOString() },
      },
    });
    expect(
      (
        await attendanceCompleteness(
          { tenantId: TENANT, from: date, to: date },
          db,
        )
      ).ready,
    ).toBe(false);
  });
  it("checks all 550 employees across seven sites with a constant number of source reads", async () => {
    const c = config();
    c.employees = Array.from({ length: 550 }, (_, i) => ({
      id: i + 1,
      payroll_included: true,
      hire_date: "2026-01-01",
    }));
    c.schedules = c.employees.map((e) => ({
      ...c.schedules[0],
      employeeId: e.id,
    }));
    c.settings.sites = Array.from({ length: 7 }, (_, i) => ({ id: "S" + i }));
    c.settings.siteAssignments = c.employees.map((e) => ({
      employeeId: e.id,
      siteIds: ["S" + (e.id % 7)],
      effectiveFrom: "2026-01-01",
    }));
    const db = database([], c, {
      employee: c.employees.map((e) => ({ ...e, tenant_id: TENANT })),
    });
    const result = await attendanceCompleteness(
      { tenantId: TENANT, from: date, to: date },
      db,
    );
    expect(result.totals).toMatchObject({
      expectedDays: 550,
      missingDays: 550,
    });
    expect(db.calls.filter((c) => c.method === "findMany").length).toBeLessThan(
      12,
    );
  });
});

it("approves evidence-backed site travel and credits only the gap", async () => {
  const c = config();
  c.settings.sites = [{ id: "HO" }, { id: "SITE" }];
  c.settings.siteAssignments = [
    { employeeId: 1, siteIds: ["HO", "SITE"], effectiveFrom: "2026-01-01" },
  ];
  c.settings.deviceSites = [
    { sn: "DEVICE-1", siteId: "HO", effectiveFrom: "2026-01-01" },
    { sn: "DEVICE-2", siteId: "SITE", effectiveFrom: "2026-01-01" },
  ];
  c.settings.siteRoutes = [
    { fromSiteId: "HO", toSiteId: "SITE", minimumMinutes: 30 },
  ];
  const db = database(
    [
      ["09:00", 0],
      ["12:00", 1],
      ["13:00", 0],
      ["17:00", 1],
    ],
    c,
  );
  await db.attendanceDevicePunch.updateMany({
    where: { id: { in: [3, 4] } },
    data: { sn: "DEVICE-2" },
  });
  await apply(db);
  expect(db.snapshot().attendance[0].day_credit).toBeNull();
  await saveAttendanceTimeCredit(
    {
      tenantId: TENANT,
      employeeId: 1,
      date,
      kind: "TRAVEL",
      start: at("12:00"),
      end: at("13:00"),
      fromSiteId: "HO",
      toSiteId: "SITE",
      paid: true,
      reason: "Authorized site visit",
      actorId: "hr",
      actorEmployeeId: 2,
    },
    db,
  );
  expect(db.snapshot().attendance[0]).toMatchObject({
    status: "PRESENT",
    total_hours: 7,
    day_credit: 1,
  });
  expect(db.snapshot().attendance[0].calculation.verdict).toMatchObject({
    travelMinutes: 60,
    payableMinutes: 480,
  });
});

it("uses approved overtime requests and limits payment time to actual recorded work", async () => {
  const db = database(
    [
      ["09:00", 0],
      ["19:00", 1],
    ],
    config(),
    {
      overtimeRequest: [
        {
          id: 1,
          tenantId: TENANT,
          employeeId: 1,
          date: at("00:00"),
          status: "APPROVED",
          hours: 1,
          approverId: 9,
        },
      ],
    },
  );
  await apply(db);
  expect(db.snapshot().attendance[0].calculation.verdict).toMatchObject({
    overtimeMinutes: 120,
    approvedOvertimeMinutes: 60,
    payableMinutes: 540,
  });
});
it("does not bypass the existing overtime approval chain with a time credit", async () => {
  await expect(
    saveAttendanceTimeCredit(
      {
        tenantId: TENANT,
        employeeId: 1,
        date,
        kind: "OVERTIME",
        start: at("17:00"),
        end: at("19:00"),
        reason: "Extra work",
        actorId: "hr",
        actorEmployeeId: 2,
      },
      database(),
    ),
  ).rejects.toThrow("existing overtime");
});
