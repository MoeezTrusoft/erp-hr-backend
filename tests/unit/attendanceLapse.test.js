import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { markLapsedCases } from "../../src/services/attendanceLapse.service.js";
import { ruleDeductions } from "../../src/lib/attendanceAnomalyRules.js";

// Mon-Fri 09:00-17:00, Saturday and Sunday off. 2026-10-01 is a Thursday.
const config = {
  version: 3,
  settings: { timeZone: "Asia/Karachi", defaultCalendarId: 1, profiles: [], assignments: [], staffingTargets: [] },
  policy: { graceMinutes: 5 },
  employees: [{ id: 1, payroll_included: true, hire_date: "2026-01-01" }],
  periods: [],
  schedules: [{ employeeId: 1, effective_start_date: "2026-01-01", schedule_pattern: { shift: { from: "09:00", to: "17:00" }, offDays: [6, 7] } }],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
};
const db = () =>
  captureDb({
    attendanceSetupRelease: [{ id: 3, tenantId: TENANT, version: 3, effectiveFrom: new Date("2026-01-01"), coverageThrough: new Date("2026-12-31"), config }],
  });
let id = 0;
const kase = (date, type, extra = {}) => ({
  id: ++id, employeeId: 1, date: new Date(`${date}T00:00:00Z`), type, status: "PENDING",
  rulesVersion: 2, evidenceState: "ACTIVE", raisedById: null, sessionKey: `s${id}`, measuredMinutes: 10, ...extra,
});
const flags = async (cases, asOf) => (await markLapsedCases(cases, { tenantId: TENANT, db: db(), asOf: new Date(asOf) })).map((c) => c.lapsed);

describe("cases nobody raised in time", () => {
  it("counts the anomaly day as working day 1 for a late check-in", async () => {
    const c = kase("2026-10-01", "LATE_CHECKIN"); // Thu + Fri; window closes Fri 23:59 PKT
    expect(await flags([c], "2026-10-02T12:00:00Z")).toEqual([false]);
    expect(await flags([c], "2026-10-02T19:30:00Z")).toEqual([true]);
  });

  it("skips weekends on the employee's own roster", async () => {
    const c = kase("2026-10-02", "LATE_CHECKIN"); // Fri + Mon
    expect(await flags([c], "2026-10-05T12:00:00Z")).toEqual([false]);
    expect(await flags([c], "2026-10-06T00:00:00Z")).toEqual([true]);
  });

  it("starts an absence's window the day after", async () => {
    const c = kase("2026-10-01", "ABSENT"); // Fri + Mon
    expect(await flags([c], "2026-10-05T12:00:00Z")).toEqual([false]);
    expect(await flags([c], "2026-10-06T00:00:00Z")).toEqual([true]);
  });

  it("never lapses a case that was raised, decided or superseded", async () => {
    const late = "2026-10-20T00:00:00Z";
    const out = await flags(
      [
        kase("2026-10-01", "LATE_CHECKIN", { raisedById: 1 }),
        kase("2026-10-01", "LATE_CHECKIN", { raisedById: 2 }),
        kase("2026-10-01", "LATE_CHECKIN", { status: "APPROVED" }),
        kase("2026-10-01", "LATE_CHECKIN", { status: "REJECTED" }),
        kase("2026-10-01", "LATE_CHECKIN", { evidenceState: "RESOLVED" }),
        kase("2026-10-01", "LATE_CHECKIN"),
      ],
      late,
    );
    expect(out).toEqual([false, false, false, false, false, true]);
  });
});

describe("decisions made on the earlier case of the same day", () => {
  const withEarlier = (rows) => {
    const d = db();
    for (const r of rows) d.attendanceAnomaly.create({ data: { tenantId: TENANT, ...r } });
    return d;
  };
  const run = async (cases, rows) =>
    (await markLapsedCases(cases, { tenantId: TENANT, db: withEarlier(rows), asOf: new Date("2026-10-20T00:00:00Z") })).map((c) => c.lapsed);
  const earlier = (status, extra = {}) => ({ id: 900 + ++id, employeeId: 1, date: new Date("2026-10-01T00:00:00Z"), type: "LATE_CHECKIN", status, rulesVersion: 1, raisedById: 1, ...extra });

  it("excuses a day whose earlier appeal was approved", async () => {
    expect(await run([kase("2026-10-01", "LATE_CHECKIN")], [earlier("APPROVED")])).toEqual([false]);
  });
  it("charges a day whose earlier appeal was rejected, even inside the window", async () => {
    expect(await run([kase("2026-10-19", "LATE_CHECKIN")], [earlier("REJECTED", { date: new Date("2026-10-19T00:00:00Z") })])).toEqual([true]);
  });
  it("holds a day whose earlier appeal is still being decided", async () => {
    expect(await run([kase("2026-10-01", "LATE_CHECKIN")], [earlier("PENDING")])).toEqual([false]);
  });
  it("excuses every case of a day whose earlier approved appeal was of type OTHER", async () => {
    expect(await run([kase("2026-10-01", "ABSENT"), kase("2026-10-01", "LATE_CHECKIN")], [earlier("APPROVED", { type: "OTHER" })])).toEqual([false, false]);
  });
  it("ignores an earlier case that was never raised or is for another type", async () => {
    expect(await run([kase("2026-10-01", "LATE_CHECKIN")], [earlier("PENDING", { raisedById: null }), earlier("APPROVED", { type: "ABSENT" })])).toEqual([true]);
  });
});

describe("pricing of cases nobody raised", () => {
  const rules = { majorThresholdMinutes: 30, poolSize: 3, absentDays: 1, missingPunchDays: 0.5, majorTimingDays: 0.5, pooledMinorDays: 1 };
  const price = (cases) => ruleDeductions(cases, { rules });

  it("charges a lapsed case exactly like a disapproved one", () => {
    const lapsed = [{ ...kase("2026-10-01", "ABSENT"), lapsed: true }];
    const rejected = [kase("2026-10-01", "ABSENT", { status: "REJECTED", decisionRole: "Management" })];
    expect(price(lapsed).days).toBe(1);
    expect(price(lapsed).days).toBe(price(rejected).days);
  });

  it("does not charge a raised case that is still undecided", () => {
    expect(price([{ ...kase("2026-10-01", "ABSENT", { raisedById: 2 }), lapsed: false }]).days).toBe(0);
  });

  it("pools minor lateness across lapsed and disapproved cases", () => {
    const minors = [
      { ...kase("2026-10-01", "LATE_CHECKIN", { measuredMinutes: 6 }), lapsed: true },
      kase("2026-10-02", "LATE_CHECKIN", { measuredMinutes: 8, status: "REJECTED", decisionRole: "Management" }),
      { ...kase("2026-10-05", "LATE_CHECKIN", { measuredMinutes: 9 }), lapsed: true },
    ];
    const r = price(minors);
    expect(r.days).toBe(1);
    expect(r.minorCount).toBe(3);
  });

  it("prices major lateness and missing punches at the configured days", () => {
    const r = price([
      { ...kase("2026-10-01", "LATE_CHECKIN", { measuredMinutes: 45 }), lapsed: true },
      { ...kase("2026-10-02", "MISSING_CHECKOUT"), lapsed: true },
    ]);
    expect(r.days).toBe(1);
  });
});
