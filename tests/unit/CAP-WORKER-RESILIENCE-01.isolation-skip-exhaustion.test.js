// Capture worker resilience (plan items 1.1, 1.2, 1.3, 3.1):
//   • one bad punch must not block the valid ones in its batch;
//   • an employee held by another worker must not starve the rest of the queue;
//   • an event that ran out of retries is queued for review, not left FAILED.
import { describe, it, expect } from "@jest/globals";
import { receiveCapture } from "../../src/services/attendanceCapture.service.js";
import { drainCapture } from "../../src/services/attendanceCaptureWorker.service.js";
import { captureDb, TENANT } from "../helpers/captureDb.js";

const now = new Date("2027-01-01");
const evaluate = async () => ({ created: 0 });
const enrol = (id, employeeId, deviceUserId) => ({
  id,
  tenantId: TENANT,
  employeeId,
  deviceUserId,
  sn: "DEVICE-1",
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
});
const people = [
  { id: 1, tenant_id: TENANT, employee_code: "EMP1" },
  { id: 2, tenant_id: TENANT, employee_code: "EMP2" },
];
const twoEmployees = () =>
  captureDb({
    employee: people,
    employeeDeviceEnrolment: [enrol(10, 1, "101"), enrol(11, 2, "102")],
  });
const sendRows = (db, rows) => receiveCapture({ sn: "DEVICE-1", rows }, db);
const byDeviceUser = (db, id) =>
  db.snapshot().attendanceCaptureEvent.find((e) => e.deviceUserId === id);

describe("one bad punch does not block valid ones", () => {
  it("processes the valid punch and sends only the bad one to review with its own reason", async () => {
    const db = captureDb();
    await sendRows(db, [
      "101\t2026-10-01 09:00:00\t0\t1\t0",
      "101\t2026-10-01 18:00:00\t1\t1\t0",
    ]);
    const [first, second] = db.snapshot().attendanceCaptureEvent;
    // Mark the second punch as one that needs supervised approval.
    await db.attendanceCaptureEvent.updateMany({
      where: { id: second.id },
      data: { raw: { ...second.raw, acceptanceMode: "SUPERVISED" } },
    });
    const result = await drainCapture({ limit: 5, now, evaluate }, db);
    const events = db.snapshot().attendanceCaptureEvent;
    expect(events.find((e) => e.id === first.id).state).toBe("PROCESSED");
    const bad = events.find((e) => e.id === second.id);
    expect(bad.state).toBe("NEEDS_REVIEW");
    expect(bad.reason).toContain("ONSITE_SUPERVISED_REVIEW");
    expect(result.processed).toBeGreaterThanOrEqual(1);
    // Only the valid punch became attendance evidence.
    expect(db.snapshot().attendanceDevicePunch).toHaveLength(1);
  });
});

describe("a busy employee does not starve the queue", () => {
  it("processes the next employee in the same cycle", async () => {
    const db = twoEmployees();
    db.busyEmployees = new Set([1]);
    await sendRows(db, ["101\t2026-10-01 09:00:00\t0\t1\t0"]);
    await sendRows(db, ["102\t2026-10-01 09:05:00\t0\t1\t0"]);
    const result = await drainCapture({ limit: 5, now, evaluate }, db);
    expect(byDeviceUser(db, "102").state).toBe("PROCESSED");
    expect(byDeviceUser(db, "101").state).toBe("PENDING");
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });
  it("picks the held employee up once the other worker is done", async () => {
    const db = twoEmployees();
    db.busyEmployees = new Set([1]);
    await sendRows(db, ["101\t2026-10-01 09:00:00\t0\t1\t0"]);
    await drainCapture({ limit: 5, now, evaluate }, db);
    db.busyEmployees = new Set();
    await drainCapture({ limit: 5, now, evaluate }, db);
    expect(byDeviceUser(db, "101").state).toBe("PROCESSED");
  });
});

describe("retries that ran out are visible", () => {
  it("moves an event failing for the 8th time to NEEDS_REVIEW / RETRIES_EXHAUSTED", async () => {
    const db = captureDb();
    await sendRows(db, ["101\t2026-10-01 09:00:00\t0\t1\t0"]);
    const boom = async () => {
      throw new Error("downstream unavailable");
    };
    let t = new Date("2027-01-01");
    for (let attempt = 1; attempt <= 8; attempt++) {
      t = new Date(+t + 7 * 24 * 3600 * 1000);
      await drainCapture({ limit: 1, now: t, evaluate: boom }, db);
      const e = db.snapshot().attendanceCaptureEvent[0];
      if (attempt < 8) {
        expect(e.state).toBe("FAILED");
        expect(e.reason).toBe("PROCESSING_FAILED");
      }
    }
    const e = db.snapshot().attendanceCaptureEvent[0];
    expect(e.attempts).toBe(8);
    expect(e).toMatchObject({ state: "NEEDS_REVIEW", reason: "RETRIES_EXHAUSTED" });
    expect(
      db.snapshot().attendanceCaptureAudit.some(
        (a) => a.action === "PROCESSING_FAILED" && a.detail?.exhausted === true,
      ),
    ).toBe(true);
  });
});
