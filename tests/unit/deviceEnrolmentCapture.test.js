import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
let db;
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: new Proxy({}, { get: (_target, key) => db[key] }),
}));
const { setPrimaryEnrolment, clearPrimaryEnrolment, reEnrol } =
  await import("../../src/services/deviceEnrolment.service.js");
beforeEach(() => {
  db = captureDb({
    employeeDeviceEnrolment: [
      {
        id: 10,
        tenantId: TENANT,
        employeeId: 1,
        deviceUserId: "101",
        sn: "DEVICE-1",
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: null,
        isPrimary: true,
      },
    ],
  });
});
describe("tenant-safe dated enrolment changes", () => {
  it("cannot set or clear another tenant employee primary", async () => {
    await expect(
      setPrimaryEnrolment({ tenantId: OTHER_TENANT, enrolmentId: 10 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      clearPrimaryEnrolment({ tenantId: OTHER_TENANT, employeeId: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.snapshot().employeeDeviceEnrolment[0].isPrimary).toBe(true);
  });
  it("clearing primary from a date preserves earlier history", async () => {
    await clearPrimaryEnrolment({
      tenantId: TENANT,
      employeeId: 1,
      effectiveFrom: "2026-10-01",
      actorId: "hr",
      reason: "Moved device",
    });
    const rows = db.snapshot().employeeDeviceEnrolment;
    expect(rows[0]).toMatchObject({
      isPrimary: true,
      effectiveTo: new Date("2026-09-30T23:59:59.999Z"),
    });
    expect(rows[1]).toMatchObject({
      isPrimary: false,
      effectiveFrom: new Date("2026-10-01"),
    });
    expect(db.snapshot().attendanceCaptureAudit[0].actorId).toBe("hr");
  });
  it("re-enrolment keeps serial and closes the whole earlier day", async () => {
    await reEnrol({
      tenantId: TENANT,
      employeeId: 1,
      newDeviceUserId: "102",
      sn: "DEVICE-1",
      effectiveFrom: "2026-10-01",
      note: "Verified register",
      actorId: "hr",
    });
    expect(
      db.snapshot().employeeDeviceEnrolment[0].effectiveTo.toISOString(),
    ).toBe("2026-09-30T23:59:59.999Z");
    expect(db.snapshot().employeeDeviceEnrolment[1]).toMatchObject({
      sn: "DEVICE-1",
      deviceUserId: "102",
    });
  });
  it("overlapping identity is refused before any history changes", async () => {
    await db.employeeDeviceEnrolment.create({
      data: {
        tenantId: OTHER_TENANT,
        employeeId: 2,
        deviceUserId: "102",
        sn: "DEVICE-1",
        effectiveFrom: new Date("2026-09-01"),
        effectiveTo: null,
      },
    });
    await expect(
      reEnrol({
        tenantId: TENANT,
        employeeId: 1,
        newDeviceUserId: "102",
        sn: "DEVICE-1",
        effectiveFrom: "2026-10-01",
        note: "Verified register",
      }),
    ).rejects.toThrow(/overlaps/);
    expect(db.snapshot().employeeDeviceEnrolment[0].effectiveTo).toBeNull();
  });
  it("audit failure rolls back the history split", async () => {
    const seed = db.snapshot();
    db = captureDb(seed, {
      before(model) {
        if (model === "attendanceCaptureAudit") throw new Error("audit failed");
      },
    });
    await expect(
      clearPrimaryEnrolment({
        tenantId: TENANT,
        employeeId: 1,
        effectiveFrom: "2026-10-01",
      }),
    ).rejects.toThrow("audit failed");
    expect(db.snapshot().employeeDeviceEnrolment).toEqual(
      seed.employeeDeviceEnrolment,
    );
  });
});
