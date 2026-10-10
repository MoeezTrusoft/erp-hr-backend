import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
import {
  captureHeartbeat,
  monitorCaptureDevices,
  receiveCapture,
  configureSharedCaptureDevice,
} from "../../src/services/attendanceCapture.service.js";
const now = new Date("2026-10-10T09:00:00Z");
const device = {
  id: "device-health",
  tenantId: TENANT,
  sn: "DEVICE-1",
  name: "Reception",
  timeZone: "Asia/Karachi",
  active: true,
  allowedTenantIds: [TENANT],
  staleAfterMinutes: 30,
  createdAt: new Date("2026-10-01"),
  lastSeenAt: new Date("2026-10-10T08:59:00Z"),
  lastHealthState: null,
};
describe("device health and routing", () => {
  it("measures clock drift from heartbeat time, not old punch evidence", async () => {
    const db = captureDb({ attendanceCaptureDevice: [device] });
    await captureHeartbeat(
      { device, deviceTime: "2026-10-10 14:03:00", now },
      db,
    );
    await receiveCapture(
      { sn: device.sn, rows: ["101\t2026-01-01 09:00:00\t0"] },
      db,
    );
    expect(db.snapshot().attendanceCaptureDevice[0].clockOffsetSeconds).toBe(
      180,
    );
    await monitorCaptureDevices({ now: new Date() }, db);
    expect(db.snapshot().outboxEvent[0].payload.payload.state).toBe(
      "CLOCK_DRIFT",
    );
  });
  it("publishes only health transitions and records recovery", async () => {
    const db = captureDb({
      attendanceCaptureDevice: [
        { ...device, lastSeenAt: new Date("2026-10-01") },
      ],
    });
    await monitorCaptureDevices({ now }, db);
    await monitorCaptureDevices({ now }, db);
    expect(db.snapshot().outboxEvent).toHaveLength(1);
    await captureHeartbeat(
      { device, deviceTime: "2026-10-10 14:00:00", now },
      db,
    );
    await monitorCaptureDevices({ now }, db);
    expect(db.snapshot().outboxEvent).toHaveLength(2);
    expect(db.snapshot().attendanceCaptureDevice[0].lastHealthState).toBe(
      "HEALTHY",
    );
  });
  it("rolls back a health transition if its notification cannot be recorded", async () => {
    const db = captureDb(
      { attendanceCaptureDevice: [device] },
      {
        before(model, method) {
          if (model === "outboxEvent" && method === "create")
            throw new Error("unavailable");
        },
      },
    );
    await expect(monitorCaptureDevices({ now }, db)).rejects.toThrow(
      "unavailable",
    );
    expect(db.snapshot().attendanceCaptureDevice[0].lastHealthState).toBeNull();
  });
  it("requires an exact preview token to authorize shared routing", async () => {
    const db = captureDb({ attendanceCaptureDevice: [device] });
    const args = {
      sn: device.sn,
      allowedTenantIds: [TENANT, OTHER_TENANT],
      actorId: "deployment-operator",
      reason: "Verified shared terminal",
    };
    const preview = await configureSharedCaptureDevice(args, db);
    expect(db.snapshot().attendanceCaptureDevice[0].allowedTenantIds).toEqual([
      TENANT,
    ]);
    await expect(
      configureSharedCaptureDevice({ ...args, previewToken: "forged" }, db),
    ).rejects.toMatchObject({ status: 409 });
    await configureSharedCaptureDevice(
      { ...args, previewToken: preview.previewToken },
      db,
    );
    expect(db.snapshot().attendanceCaptureDevice[0].allowedTenantIds).toEqual([
      TENANT,
      OTHER_TENANT,
    ]);
    expect(db.snapshot().attendanceCaptureAudit[0].action).toBe(
      "DEVICE_ROUTING_CHANGED",
    );
  });
  it("operator sync cannot submit evidence for another permitted company", async () => {
    const db = captureDb({
      employeeDeviceEnrolment: [
        {
          id: 11,
          ...device,
          tenantId: OTHER_TENANT,
          employeeId: 2,
          sn: device.sn,
          deviceUserId: "999",
          effectiveFrom: new Date("2026-01-01"),
        },
      ],
    });
    await receiveCapture(
      {
        sn: device.sn,
        source: "DEVICE_SYNC",
        tenantId: TENANT,
        rows: ["999\t2026-10-01 09:00:00\t0"],
      },
      db,
    );
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      tenantId: TENANT,
      state: "NEEDS_REVIEW",
      reason: "TENANT_NOT_PERMITTED",
    });
  });
});

it("operator uploads do not make an offline device appear healthy", async () => {
  const db = captureDb({ attendanceCaptureDevice: [device] });
  await receiveCapture(
    {
      sn: device.sn,
      source: "DEVICE_SYNC",
      tenantId: TENANT,
      rows: ["101\t2026-10-01 09:00:00\t0"],
    },
    db,
  );
  expect(db.snapshot().attendanceCaptureDevice[0].lastSeenAt).toEqual(
    device.lastSeenAt,
  );
});
