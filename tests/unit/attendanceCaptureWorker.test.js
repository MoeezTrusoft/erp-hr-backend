import { describe, it, expect } from "@jest/globals";
import { receiveCapture } from "../../src/services/attendanceCapture.service.js";
import {assertAttendancePeriodOpen} from "../../src/services/attendancePeriod.service.js";
import { drainCapture } from "../../src/services/attendanceCaptureWorker.service.js";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";

const submit = (db) =>
  receiveCapture(
    {
      sn: "DEVICE-1",
      rows: [
        "101\t2026-10-01 22:00:00\t0\t1\t0",
        "101\t2026-10-02 06:00:00\t1\t1\t0",
      ],
    },
    db,
  );
const now = new Date("2027-01-01");
const evaluate = async ({ db, tenantId, employeeIds }) => {
  await assertAttendancePeriodOpen(db,tenantId,"2026-10-01","2026-10-01");
  await db.attendance.create({
    data: {
      tenantId,
      employeeId: employeeIds[0],
      date: new Date("2026-10-01"),
      status: "PRESENT",
      setupVersion: 3,
      manually_corrected: false,
    },
  });
  return { created: 1 };
};
describe("capture processing recovery", () => {
  it("commits punch projection, calculation and outbox together", async () => {
    const db = captureDb();
    await submit(db);
    const result = await drainCapture({ limit: 1, now, evaluate }, db);
    expect(result.processed).toBe(1);
    const state = db.snapshot();
    expect(state.attendanceDevicePunch).toHaveLength(1);
    expect(state.attendance).toHaveLength(1);
    expect(state.attendanceCaptureEvent[0].state).toBe("PROCESSED");
    expect(
      state.attendanceCaptureEvent[0].result.attendance[0].setupVersion,
    ).toBe(3);
    expect(state.outboxEvent).toHaveLength(1);
  });
  it("rolls back projection and calculation on failure, keeping evidence for retry", async () => {
    const db = captureDb();
    await submit(db);
    const failAfterWrite = async (args) => {
      await evaluate(args);
      throw new Error("worker interrupted");
    };
    expect(
      (await drainCapture({ limit: 1, now, evaluate: failAfterWrite }, db))
        .failed,
    ).toBe(1);
    const state = db.snapshot();
    expect(state.attendance).toHaveLength(0);
    expect(state.attendanceDevicePunch).toHaveLength(0);
    expect(state.outboxEvent).toHaveLength(0);
    expect(state.attendanceCaptureEvent[0]).toMatchObject({
      state: "FAILED",
      attempts: 1,
      reason: "PROCESSING_FAILED",
    });
    expect(state.attendanceCaptureEvent[0].raw.line).toContain("22:00");
    await drainCapture({ limit: 1, now: new Date("2027-01-02"), evaluate }, db);
    expect(db.snapshot().attendance).toHaveLength(1);
  });
  it("does not complete processing if the notification intent cannot be stored", async () => {
    const db = captureDb(
      {},
      {
        before(model, method) {
          if (model === "outboxEvent" && method === "create")
            throw new Error("outbox unavailable");
        },
      },
    );
    await submit(db);
    await drainCapture({ limit: 1, now, evaluate }, db);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe("FAILED");
  });
  it("retains evidence but holds changes to protected payroll periods", async () => {
    const db = captureDb({
      payrollRun: [
        {
          id: 1,
          tenantId: TENANT,
          periodStart: new Date("2026-10-01"),
          periodEnd: new Date("2026-10-31"),
          status: "FINALIZED",
        },
      ],
    });
    await submit(db);
    await drainCapture({ limit: 1, now, evaluate }, db);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: expect.stringContaining("PERIOD_PROTECTED"),
    });
  });
  it("refuses to steal an existing historical punch from another employee", async () => {
    const db = captureDb({
      attendanceDevicePunch: [
        {
          id: 9,
          tenantId: TENANT,
          employeeId: 99,
          sn: "DEVICE-1",
          deviceUserId: "101",
          punchedAt: new Date("2026-10-01T22:00:00Z"),
          status: 0,
        },
      ],
    });
    await submit(db);
    await drainCapture({ limit: 1, now, evaluate }, db);
    expect(db.snapshot().attendanceCaptureEvent[0].reason).toContain(
      "ATTRIBUTION_CONFLICT",
    );
    expect(db.snapshot().attendanceDevicePunch[0].employeeId).toBe(99);
  });
});

it("reconciles an unassigned legacy punch across permitted companies while preserving its raw row", async () => {
  const db = captureDb({
    employee: [{ id: 1, tenant_id: OTHER_TENANT }],
    employeeDeviceEnrolment: [
      {
        id: 10,
        tenantId: OTHER_TENANT,
        employeeId: 1,
        deviceUserId: "101",
        sn: "DEVICE-1",
        effectiveFrom: new Date("2026-01-01"),
      },
    ],
    attendanceDevicePunch: [
      {
        id: 99,
        tenantId: TENANT,
        employeeId: null,
        sn: "DEVICE-1",
        deviceUserId: "101",
        punchedAt: new Date("2026-10-01T22:00:00Z"),
        status: 0,
        rawLine: "original",
      },
    ],
  });
  await submit(db);
  expect((await drainCapture({ limit: 1, now, evaluate }, db)).failed).toBe(0);
  expect(db.snapshot().attendanceDevicePunch).toHaveLength(1);
  expect(db.snapshot().attendanceDevicePunch[0]).toMatchObject({
    id: 99,
    tenantId: OTHER_TENANT,
    employeeId: 1,
    rawLine: "original",
  });
  expect(
    db
      .snapshot()
      .attendanceCaptureAudit.some(
        (a) => a.tenantId === TENANT && a.action === "LEGACY_IDENTITY_ROUTED",
      ),
  ).toBe(true);
});
