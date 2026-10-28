// ATT-DEVICE-PER-COMPANY-01 — companies are independent. A device may serve
// several companies; each keeps its own enrolments and a punch is resolved
// separately for every company that enrolled the device ID. Nothing about one
// company's enrolments affects another's.
//
// ATT-PUNCH-KEY-01 (D4) — a physical punch is identified by device + user +
// timestamp. A re-delivery with a different direction code is recorded as a
// conflict, never stored as a second punch.
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
import {
  chooseEnrolments,
  chooseEnrolment,
  fingerprint,
} from "../../src/lib/attendanceCapture.js";

let db;
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: new Proxy({}, { get: (_target, key) => db[key] }),
}));
const { receiveCapture, reconcileCaptureIdentities } = await import(
  "../../src/services/attendanceCapture.service.js"
);
const { drainCapture } = await import(
  "../../src/services/attendanceCaptureWorker.service.js"
);
const { reEnrol } = await import(
  "../../src/services/deviceEnrolment.service.js"
);

const enrol = (over) => ({
  deviceUserId: "101",
  sn: "DEVICE-1",
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
  ...over,
});
// Two independent companies on one device; no person link between records.
const twoCompanies = (extra = {}) => ({
  employee: [
    { id: 1, tenant_id: TENANT, employee_code: "A-1" },
    { id: 2, tenant_id: OTHER_TENANT, employee_code: "B-7" },
  ],
  employeeDeviceEnrolment: [
    enrol({ id: 10, tenantId: TENANT, employeeId: 1 }),
    enrol({ id: 11, tenantId: OTHER_TENANT, employeeId: 2 }),
  ],
  ...extra,
});
const punch = (line = "101\t2026-10-01 12:00:00\t0") => ({
  sn: "DEVICE-1",
  rows: [line],
});
const at = new Date("2026-10-01T12:00:00Z");

describe("chooseEnrolments resolves each company on its own", () => {
  const rows = [
    enrol({ id: 10, tenantId: TENANT, employeeId: 1 }),
    enrol({ id: 11, tenantId: OTHER_TENANT, employeeId: 2 }),
  ];

  it("credits each company that enrolled the ID", () => {
    expect(
      chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT]),
    ).toEqual({
      hits: [
        { employeeId: 1, tenantId: TENANT, enrolmentId: 10 },
        { employeeId: 2, tenantId: OTHER_TENANT, enrolmentId: 11 },
      ],
      issues: [],
    });
  });
  it("an overlap inside one company holds only that company", () => {
    const own = [...rows, enrol({ id: 12, tenantId: TENANT, employeeId: 3 })];
    expect(
      chooseEnrolments(own, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT]),
    ).toEqual({
      hits: [{ employeeId: 2, tenantId: OTHER_TENANT, enrolmentId: 11 }],
      issues: [{ tenantId: TENANT, reason: "AMBIGUOUS_ENROLMENT" }],
    });
  });
  it("a company the device does not serve is not involved", () => {
    expect(chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT])).toEqual({
      hits: [{ employeeId: 1, tenantId: TENANT, enrolmentId: 10 }],
      issues: [],
    });
  });
  it("a company whose enrolment ended is not involved", () => {
    const ended = [
      rows[0],
      { ...rows[1], effectiveTo: new Date("2026-09-30") },
    ];
    expect(
      chooseEnrolments(ended, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT]),
    ).toEqual({
      hits: [{ employeeId: 1, tenantId: TENANT, enrolmentId: 10 }],
      issues: [],
    });
  });
  it("reports unknown, ended and not-permitted identities", () => {
    expect(chooseEnrolments(rows, "999", "DEVICE-1", at, [TENANT])).toEqual({
      reason: "UNKNOWN_IDENTITY",
    });
    expect(
      chooseEnrolments(
        [{ ...rows[0], effectiveTo: new Date("2026-09-30") }],
        "101",
        "DEVICE-1",
        at,
        [TENANT],
      ),
    ).toEqual({ reason: "OUTSIDE_ENROLMENT_PERIOD" });
    expect(
      chooseEnrolments([rows[1]], "101", "DEVICE-1", at, [TENANT]),
    ).toEqual({ reason: "TENANT_NOT_PERMITTED" });
  });
  it("single-answer callers still require exactly one employee", () => {
    expect(
      chooseEnrolment(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT]),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
    expect(chooseEnrolment(rows, "101", "DEVICE-1", at, [TENANT])).toEqual({
      employeeId: 1,
      tenantId: TENANT,
      enrolmentId: 10,
    });
  });
});

describe("independent intake", () => {
  beforeEach(() => {
    db = captureDb(twoCompanies());
  });

  it("stores one attributed event per company", async () => {
    const summary = await receiveCapture(punch(), db);
    expect(summary).toMatchObject({ received: 1, stored: 2, pending: 2 });
    const events = db.snapshot().attendanceCaptureEvent;
    expect(events.map((e) => [e.tenantId, e.employeeId, e.state]).sort()).toEqual(
      [
        [OTHER_TENANT, 2, "PENDING"],
        [TENANT, 1, "PENDING"],
      ].sort(),
    );
    expect(events[0].raw.companies.sort()).toEqual([TENANT, OTHER_TENANT].sort());
  });
  it("one company's ambiguity does not hold the other company's punch", async () => {
    await db.employee.create({ data: { id: 3, tenant_id: TENANT, employee_code: "A-3" } });
    await db.employeeDeviceEnrolment.create({
      data: enrol({ id: 12, tenantId: TENANT, employeeId: 3 }),
    });
    await receiveCapture(punch(), db);
    const events = db.snapshot().attendanceCaptureEvent;
    expect(events.map((e) => [e.tenantId, e.employeeId ?? null, e.state, e.reason]).sort()).toEqual(
      [
        [OTHER_TENANT, 2, "PENDING", null],
        [TENANT, null, "NEEDS_REVIEW", "AMBIGUOUS_ENROLMENT"],
      ].sort(),
    );
  });
  it("a re-delivery is a duplicate in both companies", async () => {
    await receiveCapture(punch(), db);
    expect(
      await receiveCapture({ ...punch(), source: "DEVICE_LISTENER" }, db),
    ).toMatchObject({ stored: 0, duplicates: 2 });
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(2);
  });
  it("both companies record the punch without an attribution conflict", async () => {
    await receiveCapture(punch(), db);
    await drainCapture({ now: new Date("2027-01-01T00:00:00Z") }, db);
    const punches = db.snapshot().attendanceDevicePunch;
    expect(punches.map((p) => [p.tenantId, p.employeeId]).sort()).toEqual(
      [
        [OTHER_TENANT, 2],
        [TENANT, 1],
      ].sort(),
    );
    expect(
      db
        .snapshot()
        .attendanceCaptureEvent.some((e) => /ATTRIBUTION_CONFLICT/.test(e.reason || "")),
    ).toBe(false);
  });
});

describe("punch identity is device + user + timestamp (D4)", () => {
  beforeEach(() => {
    db = captureDb();
  });

  it("a re-delivery with a different direction is a recorded conflict, not a second punch", async () => {
    await receiveCapture(punch("101\t2026-10-01 12:00:00\t0"), db);
    expect(
      await receiveCapture(punch("101\t2026-10-01 12:00:00\t1"), db),
    ).toMatchObject({ stored: 0, duplicates: 1 });
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(1);
    expect(
      db.snapshot().attendanceCaptureAudit.filter((a) => a.action === "DIRECTION_CONFLICT"),
    ).toHaveLength(1);
  });
  it("recognises events stored under the previous key", async () => {
    await db.attendanceCaptureEvent.create({
      data: {
        tenantId: TENANT,
        sn: "DEVICE-1",
        deviceUserId: "101",
        employeeId: 1,
        state: "PROCESSED",
        fingerprint: fingerprint(["DEVICE-1", "101", "2026-10-01T12:00:00.000Z", 0]),
        parsed: { status: 0 },
      },
    });
    expect(await receiveCapture(punch(), db)).toMatchObject({
      stored: 0,
      duplicates: 1,
    });
  });
});

describe("identity recovery per company", () => {
  it("an unknown punch resolves for every company that later enrols the ID", async () => {
    db = captureDb(twoCompanies({ employeeDeviceEnrolment: [] }));
    await receiveCapture(punch("777\t2026-10-01 12:00:00\t0"), db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: "UNKNOWN_IDENTITY",
    });
    await db.employeeDeviceEnrolment.create({
      data: enrol({ id: 12, tenantId: TENANT, employeeId: 1, deviceUserId: "777" }),
    });
    await db.employeeDeviceEnrolment.create({
      data: enrol({ id: 13, tenantId: OTHER_TENANT, employeeId: 2, deviceUserId: "777" }),
    });
    await reconcileCaptureIdentities({}, db);
    await reconcileCaptureIdentities({}, db);
    const events = db.snapshot().attendanceCaptureEvent;
    expect(events.map((e) => [e.tenantId, e.employeeId, e.state]).sort()).toEqual(
      [
        [OTHER_TENANT, 2, "PENDING"],
        [TENANT, 1, "PENDING"],
      ].sort(),
    );
  });
  it("a company's held copy resolves only for that company", async () => {
    db = captureDb(twoCompanies());
    await db.employee.create({ data: { id: 3, tenant_id: TENANT, employee_code: "A-3" } });
    await db.employeeDeviceEnrolment.create({
      data: enrol({ id: 12, tenantId: TENANT, employeeId: 3 }),
    });
    await receiveCapture(punch(), db);
    // HR in the first company ends the wrong enrolment.
    await db.employeeDeviceEnrolment.updateMany({
      where: { id: 12 },
      data: { effectiveTo: new Date("2026-09-30") },
    });
    await reconcileCaptureIdentities({}, db);
    const events = db.snapshot().attendanceCaptureEvent;
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.tenantId, e.employeeId, e.state]).sort()).toEqual(
      [
        [OTHER_TENANT, 2, "PENDING"],
        [TENANT, 1, "PENDING"],
      ].sort(),
    );
  });
});

describe("enrolment overlap is checked inside one company", () => {
  beforeEach(() => {
    db = captureDb(
      twoCompanies({
        employeeDeviceEnrolment: [enrol({ id: 10, tenantId: TENANT, employeeId: 1 })],
      }),
    );
  });
  const enrolAs = (tenantId, employeeId) =>
    reEnrol({
      tenantId,
      employeeId,
      newDeviceUserId: "101",
      sn: "DEVICE-1",
      effectiveFrom: "2026-10-01",
      note: "Enrolled on shared device",
      actorId: "hr",
    });

  it("another company may enrol the same device ID", async () => {
    await expect(enrolAs(OTHER_TENANT, 2)).resolves.toMatchObject({ employeeId: 2 });
  });
  it("a second employee in the same company may not", async () => {
    await db.employee.create({ data: { id: 3, tenant_id: TENANT, employee_code: "A-3" } });
    await expect(enrolAs(TENANT, 3)).rejects.toMatchObject({ status: 409 });
  });
});
