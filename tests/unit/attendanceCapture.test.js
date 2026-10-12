import { describe, it, expect } from "@jest/globals";
import {
  parseCaptureRow,
  parseCaptureTimestamp,
  chooseEnrolment,
  affectedDays,
} from "../../src/lib/attendanceCapture.js";
import {
  receiveCapture,
  reviewCaptureEvents,
  authenticateCaptureDevice,
  registerCaptureDevice,
} from "../../src/services/attendanceCapture.service.js";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";

const input = (rows) => ({
  sn: "DEVICE-1",
  rows: rows || ["101\t2026-10-01 22:00:00\t0\t1\t0"],
});
describe("capture validation and time semantics", () => {
  it.each([
    "2026-02-30 09:00:00",
    "2026-10-01 25:00:00",
    "2026-10-01 09:00:61",
    "not-a-date",
  ])("rejects invalid timestamp %s", (raw) =>
    expect(() => parseCaptureTimestamp(raw, "Asia/Karachi")).toThrow(),
  );
  it("preserves local wall time separately from the actual instant", () => {
    const p = parseCaptureRow(input().rows[0], "Asia/Karachi");
    expect(p.punchedAt.toISOString()).toBe("2026-10-01T22:00:00.000Z");
    expect(p.occurredAt.toISOString()).toBe("2026-10-01T17:00:00.000Z");
  });
  it("converts offset-bearing events to the configured local clock", () =>
    expect(
      parseCaptureTimestamp(
        "2026-10-01T17:00:00Z",
        "Asia/Karachi",
      ).punchedAt.toISOString(),
    ).toBe("2026-10-01T22:00:00.000Z"));
  it.each(["nonsense", "", "-1", "6"])(
    "rejects invalid direction %s",
    (status) =>
      expect(() =>
        parseCaptureRow(`101\t2026-10-01 09:00:00\t${status}`, "UTC"),
      ).toThrow(),
  );
  it("requires an offset for ambiguous DST time and rejects a DST gap", () => {
    expect(() =>
      parseCaptureTimestamp("2026-11-01 01:30:00", "America/New_York"),
    ).toThrow(/Ambiguous/);
    expect(() =>
      parseCaptureTimestamp("2026-03-08 02:30:00", "America/New_York"),
    ).toThrow(/does not exist/);
    expect(
      parseCaptureTimestamp(
        "2026-11-01T01:30:00-04:00",
        "America/New_York",
      ).occurredAt.toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("does not widen sparse uploads into the intervening months", () =>
    expect(affectedDays(["2026-01-05", "2026-10-05"])).toHaveLength(6));
});
describe("durable receipt and tenant attribution", () => {
  it("stores original evidence and pending work atomically without writing attendance", async () => {
    const db = captureDb();
    const result = await receiveCapture(input(), db);
    expect(result).toMatchObject({ received: 1, stored: 1, pending: 1 });
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      employeeId: 1,
      tenantId: TENANT,
      enrolmentId: 10,
      state: "PENDING",
      raw: { line: input().rows[0] },
    });
    expect(db.snapshot().attendance).toHaveLength(0);
  });
  it("retains malformed evidence for review", async () => {
    const db = captureDb();
    const result = await receiveCapture(
      input(["101\t2026-02-30 09:00:00\t0"]),
      db,
    );
    expect(result.needsReview).toBe(1);
    expect(db.snapshot().attendanceCaptureEvent[0].parsed).toBeUndefined();
  });
  it("does not fall back to the current biometric holder after a dated enrolment expires", async () => {
    const db = captureDb({
      employeeDeviceEnrolment: [
        {
          id: 10,
          tenantId: TENANT,
          employeeId: 1,
          deviceUserId: "101",
          sn: "DEVICE-1",
          effectiveFrom: new Date("2026-01-01"),
          effectiveTo: new Date("2026-09-30"),
        },
      ],
    });
    await receiveCapture(input(), db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: "OUTSIDE_ENROLMENT_PERIOD",
    });
    expect(
      db.calls.some((c) => c.model === "employee" && c.method === "create"),
    ).toBe(false);
  });
  it("does not guess between overlapping identities", () => {
    const rows = [1, 2].map((employeeId) => ({
      employeeId,
      tenantId: TENANT,
      deviceUserId: "101",
      sn: "DEVICE-1",
      effectiveFrom: new Date("2026-01-01"),
    }));
    expect(
      chooseEnrolment(rows, "101", "DEVICE-1", new Date("2026-10-01")),
    ).toEqual({ reason: "AMBIGUOUS_ENROLMENT" });
  });
  it("uses the device serial and checks its permitted tenants", () => {
    const rows = [
      {
        id: 20,
        employeeId: 2,
        tenantId: OTHER_TENANT,
        deviceUserId: "101",
        sn: "DEVICE-2",
        effectiveFrom: new Date("2026-01-01"),
      },
    ];
    expect(
      chooseEnrolment(rows, "101", "DEVICE-1", new Date("2026-10-01")).reason,
    ).toBe("UNKNOWN_IDENTITY");
    expect(
      chooseEnrolment(rows, "101", "DEVICE-2", new Date("2026-10-01"), [TENANT])
        .reason,
    ).toBe("TENANT_NOT_PERMITTED");
  });
  it("same receipt is safe to retry; a changed payload cannot reuse its key", async () => {
    const db = captureDb();
    const first = await receiveCapture(
      { ...input(), requestKey: "delivery-1" },
      db,
    );
    expect(
      await receiveCapture({ ...input(), requestKey: "delivery-1" }, db),
    ).toMatchObject({ receiptId: first.receiptId, replayed: true });
    await expect(
      receiveCapture(
        { ...input(["101\t2026-10-01 23:00:00\t1"]), requestKey: "delivery-1" },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(1);
  });
  it("suppresses repeated physical punches across capture adapters", async () => {
    const db = captureDb();
    await receiveCapture(input(), db);
    expect(
      await receiveCapture({ ...input(), source: "DEVICE_LISTENER" }, db),
    ).toMatchObject({ stored: 0, duplicates: 1 });
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(1);
    expect(
      db
        .snapshot()
        .attendanceCaptureAudit.some((a) => a.action === "DUPLICATE_RECEIVED"),
    ).toBe(true);
  });
  it("rolls evidence back if its receipt cannot be saved", async () => {
    const db = captureDb(
      {},
      {
        before(model, method) {
          if (model === "attendanceCaptureReceipt" && method === "create")
            throw new Error("storage failed");
        },
      },
    );
    await expect(receiveCapture(input(), db)).rejects.toThrow("storage failed");
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
  });
  it("refuses an unregistered device", async () =>
    await expect(
      receiveCapture({ ...input(), sn: "UNKNOWN" }, captureDb()),
    ).rejects.toMatchObject({ status: 409 }));
  it("device credentials are hashed and returned only when issued", async () => {
    const db = captureDb();
    const registered = await registerCaptureDevice(
      {
        tenantId: TENANT,
        actorId: "hr",
        sn: "NEW",
        name: "Gate",
        timeZone: "Asia/Karachi",
      },
      db,
    );
    expect(registered.device.credentialHash).toBeUndefined();
    expect(
      db.snapshot().attendanceCaptureDevice.at(-1).credentialHash,
    ).not.toBe(registered.credential);
    expect(
      (await authenticateCaptureDevice("NEW", registered.credential, db)).sn,
    ).toBe("NEW");
    await expect(
      authenticateCaptureDevice("NEW", "incorrect", db),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("review cannot select another tenant event or overwrite immutable evidence", async () => {
    const db = captureDb();
    await receiveCapture(input(["999\t2026-10-01 09:00:00\t0"]), db);
    const row = db.snapshot().attendanceCaptureEvent[0];
    await expect(
      reviewCaptureEvents(
        {
          tenantId: OTHER_TENANT,
          actorId: "hr",
          items: [{ id: row.id, version: row.version }],
          action: "DISMISS",
          reason: "test",
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await reviewCaptureEvents(
      {
        tenantId: TENANT,
        actorId: "hr",
        items: [{ id: row.id, version: row.version }],
        action: "DISMISS",
        reason: "Unknown visitor",
      },
      db,
    );
    expect(db.snapshot().attendanceCaptureEvent[0].raw).toEqual(row.raw);
    await expect(
      reviewCaptureEvents(
        {
          tenantId: TENANT,
          actorId: "hr",
          items: [{ id: row.id, version: row.version }],
          action: "RETRY",
          reason: "stale click",
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
