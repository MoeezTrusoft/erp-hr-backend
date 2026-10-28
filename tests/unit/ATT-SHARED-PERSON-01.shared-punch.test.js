// ATT-SHARED-PERSON-01 — one person employed by two companies punches once on a
// shared device. The punch is credited to every company that enrolled that
// person under the same device ID; two DIFFERENT people on one ID stay ambiguous.
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

const PERSON = "aaaaaaaa-0000-4000-8000-000000000001";
const enrol = (over) => ({
  deviceUserId: "101",
  sn: "DEVICE-1",
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
  ...over,
});
// Employee 1 (TENANT) and employee 2 (OTHER_TENANT) are the same person.
const sharedSeed = (extra = {}) => ({
  employee: [
    { id: 1, tenant_id: TENANT, employee_code: "BOC-1", personId: PERSON },
    { id: 2, tenant_id: OTHER_TENANT, employee_code: "JOC-1", personId: PERSON },
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

describe("chooseEnrolments", () => {
  const at = new Date("2026-10-01T12:00:00Z");
  const rows = [
    enrol({ id: 10, tenantId: TENANT, employeeId: 1 }),
    enrol({ id: 11, tenantId: OTHER_TENANT, employeeId: 2 }),
  ];
  const samePerson = new Map([
    [1, PERSON],
    [2, PERSON],
  ]);

  it("credits every company of one person", () => {
    expect(
      chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT], samePerson),
    ).toEqual({
      hits: [
        { employeeId: 1, tenantId: TENANT, enrolmentId: 10 },
        { employeeId: 2, tenantId: OTHER_TENANT, enrolmentId: 11 },
      ],
    });
  });
  it("keeps two different people on one ID ambiguous", () => {
    const people = new Map([
      [1, PERSON],
      [2, "bbbbbbbb-0000-4000-8000-000000000002"],
    ]);
    expect(
      chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT], people),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
  });
  it("keeps records without a person link ambiguous", () => {
    expect(
      chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT], new Map()),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
  });
  it("keeps duplicate records of one person in one company ambiguous", () => {
    const dup = [rows[0], { ...rows[1], tenantId: TENANT }];
    expect(
      chooseEnrolments(dup, "101", "DEVICE-1", at, [TENANT], samePerson),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
  });
  it("credits only the companies the device serves", () => {
    expect(
      chooseEnrolments(rows, "101", "DEVICE-1", at, [TENANT], samePerson),
    ).toEqual({ hits: [{ employeeId: 1, tenantId: TENANT, enrolmentId: 10 }] });
  });
  it("single-answer callers still see a shared ID as ambiguous", () => {
    expect(
      chooseEnrolment(rows, "101", "DEVICE-1", at, [TENANT, OTHER_TENANT]),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
  });
});

describe("shared-person intake", () => {
  beforeEach(() => {
    db = captureDb(sharedSeed());
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
    expect(events[0].raw.sharedPerson.tenantIds.sort()).toEqual(
      [TENANT, OTHER_TENANT].sort(),
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

describe("shared-person identity recovery", () => {
  it("an ambiguous event resolves to every company of one person", async () => {
    db = captureDb({
      ...sharedSeed(),
      employeeDeviceEnrolment: [enrol({ id: 10, tenantId: TENANT, employeeId: 1 })],
    });
    // Received before the second company enrolled the person.
    await db.employeeDeviceEnrolment.create({
      data: enrol({ id: 99, tenantId: TENANT, employeeId: 3, deviceUserId: "999" }),
    });
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
});

describe("enrolment overlap between companies", () => {
  beforeEach(() => {
    db = captureDb(
      sharedSeed({
        employeeDeviceEnrolment: [enrol({ id: 10, tenantId: TENANT, employeeId: 1 })],
      }),
    );
  });
  const enrolOther = (employeeId) =>
    reEnrol({
      tenantId: OTHER_TENANT,
      employeeId,
      newDeviceUserId: "101",
      sn: "DEVICE-1",
      effectiveFrom: "2026-10-01",
      note: "Same person, second company",
      actorId: "hr",
    });

  it("allows the same person's record in another company to share the ID", async () => {
    await expect(enrolOther(2)).resolves.toMatchObject({ employeeId: 2 });
  });
  it("still refuses a different person", async () => {
    await db.employee.create({
      data: { id: 3, tenant_id: OTHER_TENANT, employee_code: "JOC-3", personId: "cccccccc-0000-4000-8000-000000000003" },
    });
    await expect(enrolOther(3)).rejects.toMatchObject({ status: 409 });
  });
});
