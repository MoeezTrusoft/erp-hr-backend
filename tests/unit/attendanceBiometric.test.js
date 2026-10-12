import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
import {
  configureBiometricDevice,
  listBiometricProfiles,
  readBiometricChallenge,
  requestBiometricEnrolment,
  requestBiometricVerification,
  revokeBiometricProfile,
  submitBiometricSample,
} from "../../src/services/attendanceBiometric.service.js";
import {
  receiveCapture,
  reviewCaptureEvents,
} from "../../src/services/attendanceCapture.service.js";
import { drainCapture } from "../../src/services/attendanceCaptureWorker.service.js";
import {
  openTemplate,
  sampleMessage,
  sealTemplate,
} from "../../src/lib/attendanceBiometric.js";
import { sessioniseByRoster } from "../../src/lib/attendanceReplay.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const device = {
  id: randomUUID(),
  tenantId: TENANT,
  sn: "KIOSK-1",
  name: "Reception",
  active: true,
  allowedTenantIds: [TENANT],
  timeZone: "Asia/Karachi",
  biometricSite: "Head office",
  biometricPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  fingerprintPadLevel: 3,
  fingerprintPadValidated: true,
};
const now = new Date("2026-10-10T04:00:00Z");
const database = () => captureDb({ attendanceCaptureDevice: [device] });
const engine = jest.fn(async (modality, operation) => ({
  engine: modality === "FACE" ? "INSIGHTFACE" : "SOURCEAFIS",
  engineVersion: "test-engine-v1",
  ...(operation === "extract"
    ? { template: "SECRET-TEMPLATE" }
    : { score: modality === "FACE" ? 0.9 : 80 }),
}));
const args = (extra = {}) => ({
  tenantId: TENANT,
  actorId: "operator-1",
  deviceId: device.id,
  employeeId: 1,
  modality: "FINGERPRINT",
  slot: "RIGHT_INDEX",
  reason: "Supervised identity check",
  ...extra,
});
function signed(ticket, extra = {}) {
  const face = ticket.modality === "FACE";
  const input = {
    sn: device.sn,
    challengeId: ticket.challengeId,
    capturedAt: now.toISOString(),
    modality: ticket.modality,
    format: face ? "JPEG" : "GRAY8",
    imageBase64: Buffer.alloc(face ? 128 : 120000, 91).toString("base64"),
    width: face ? null : 300,
    height: face ? null : 400,
    dpi: face ? null : 500,
    pad: face ? "UNKNOWN" : "PASSED",
    padLevel: face ? 0 : 3,
    ...extra,
  };
  return {
    device,
    input,
    signature: sign(
      null,
      Buffer.from(sampleMessage(input)),
      privateKey,
    ).toString("base64"),
  };
}
async function enrol(db, modality = "FINGERPRINT") {
  const ticket = await requestBiometricEnrolment(
    args({ modality, slot: modality === "FACE" ? "FACE" : "RIGHT_INDEX" }),
    db,
    now,
  );
  return submitBiometricSample(signed(ticket), db, { engine, now });
}
async function verifyTicket(db, modality = "FINGERPRINT", extra = {}) {
  return requestBiometricVerification(
    {
      device,
      employeeCode: "EMP1",
      modality,
      slot: modality === "FACE" ? "FACE" : "RIGHT_INDEX",
      direction: 0,
      ...extra,
    },
    db,
    now,
  );
}
const vars = [
  "BIOMETRIC_ACTIVE_KEY_ID",
  "BIOMETRIC_ENCRYPTION_KEYS",
  "BIOMETRIC_FACE_THRESHOLD",
  "BIOMETRIC_FINGERPRINT_THRESHOLD",
];
let original;
beforeEach(() => {
  original = Object.fromEntries(vars.map((key) => [key, process.env[key]]));
  process.env.BIOMETRIC_ACTIVE_KEY_ID = "test-key";
  process.env.BIOMETRIC_ENCRYPTION_KEYS = JSON.stringify({
    "test-key": "a1".repeat(32),
  });
  process.env.BIOMETRIC_FACE_THRESHOLD = "0.65";
  process.env.BIOMETRIC_FINGERPRINT_THRESHOLD = "50";
  engine.mockClear();
});
afterEach(() => {
  for (const key of vars) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("supervised biometric enrolment and verification", () => {
  it("encrypts templates, exposes metadata only, and never stores raw samples", async () => {
    const db = database();
    const result = await enrol(db);
    expect(result.outcome).toBe("ENROLLED");
    const stored = db.snapshot().attendanceBiometricProfile[0];
    expect(stored.encryptedTemplate).not.toContain("SECRET-TEMPLATE");
    expect(JSON.stringify(db.snapshot())).not.toContain("imageBase64");
    const listed = await listBiometricProfiles(
      { tenantId: TENANT, employeeId: 1 },
      db,
    );
    expect(listed.items[0]).not.toHaveProperty("encryptedTemplate");
    expect(
      (
        await listBiometricProfiles(
          { tenantId: OTHER_TENANT, employeeId: 1 },
          db,
        )
      ).items,
    ).toEqual([]);
  });
  it("creates exactly one durable punch and keeps signed direction and local/UTC times", async () => {
    const db = database();
    await enrol(db);
    const ticket = await verifyTicket(db, "FINGERPRINT", { direction: 1 });
    const sample = signed(ticket);
    const result = await submitBiometricSample(sample, db, { engine, now });
    expect(result.outcome).toBe("PENDING");
    expect(
      await submitBiometricSample(sample, db, { engine, now }),
    ).toMatchObject({ replayed: true, eventId: result.eventId });
    const state = db.snapshot();
    expect(state.attendanceCaptureEvent).toHaveLength(1);
    expect(state.attendanceCaptureReceipt).toHaveLength(1);
    expect(state.attendanceCaptureEvent[0].parsed).toMatchObject({
      status: 1,
      occurredAt: now.toISOString(),
      punchedAt: "2026-10-10T09:00:00.000Z",
    });
    await drainCapture(
      { now: new Date("2027-01-01"), limit: 1, evaluate: async () => ({}) },
      db,
    );
    expect(db.snapshot().attendanceDevicePunch[0]).toMatchObject({
      directionVerified: true,
      status: 1,
    });
  });
  it("rejects changed evidence on a used challenge", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    await submitBiometricSample(signed(ticket), db, { engine, now });
    await expect(
      submitBiometricSample(
        signed(ticket, { capturedAt: new Date(+now + 1).toISOString() }),
        db,
        { engine, now },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects tampered signature metadata before engine access", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    const sample = signed(ticket);
    sample.input.padLevel = 4;
    await expect(
      submitBiometricSample(sample, db, { engine, now }),
    ).rejects.toMatchObject({ status: 403 });
    expect(engine).not.toHaveBeenCalled();
  });
  it("binds challenge, device and company even on the system intake path", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    await expect(
      submitBiometricSample(
        { ...signed(ticket), device: { ...device, tenantId: OTHER_TENANT } },
        db,
        { engine, now },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readBiometricChallenge(
        { device: { ...device, id: randomUUID() }, id: ticket.challengeId },
        db,
        now,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      readBiometricChallenge({ device }, db, now),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("expires enrolment and rejects samples captured beyond the challenge window", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    await expect(
      submitBiometricSample(signed(ticket), db, {
        engine,
        now: new Date(+now + 300001),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      submitBiometricSample(
        signed(ticket, { capturedAt: new Date(+now + 10000).toISOString() }),
        db,
        { engine, now },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not let older enrolment tickets overwrite a replacement", async () => {
    const db = database();
    await enrol(db);
    const older = await requestBiometricEnrolment(args(), db, now),
      newer = await requestBiometricEnrolment(args(), db, now);
    await submitBiometricSample(signed(newer), db, { engine, now });
    await expect(
      submitBiometricSample(signed(older), db, { engine, now }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      db.snapshot().attendanceBiometricProfile.filter((p) => p.active),
    ).toHaveLength(1);
  });
  it("revocation erases the template and invalidates outstanding capture and replacement tickets", async () => {
    const db = database();
    const profile = await enrol(db);
    const verification = await verifyTicket(db);
    const replacement = await requestBiometricEnrolment(args(), db, now);
    await revokeBiometricProfile(
      {
        tenantId: TENANT,
        actorId: "operator-2",
        id: profile.profileId,
        reason: "Employee departure",
      },
      db,
    );
    expect(db.snapshot().attendanceBiometricProfile[0]).toMatchObject({
      active: false,
      encryptedTemplate: null,
    });
    for (const ticket of [verification, replacement])
      await expect(
        submitBiometricSample(signed(ticket), db, { engine, now }),
      ).rejects.toMatchObject({ status: 409 });
  });
  it("never creates attendance from a failed match or rejected fake finger", async () => {
    const db = database();
    await enrol(db);
    const ticket = await verifyTicket(db);
    engine
      .mockImplementationOnce(async () => ({
        engine: "SOURCEAFIS",
        engineVersion: "test-engine-v1",
        template: "PROBE",
      }))
      .mockImplementationOnce(async () => ({
        engine: "SOURCEAFIS",
        engineVersion: "test-engine-v1",
        score: 3,
      }));
    expect(
      await submitBiometricSample(signed(ticket), db, { engine, now }),
    ).toMatchObject({ outcome: "REJECTED", reason: "BIOMETRIC_NO_MATCH" });
    const other = await verifyTicket(db);
    const calls = engine.mock.calls.length;
    expect(
      await submitBiometricSample(signed(other, { pad: "FAILED" }), db, {
        engine,
        now,
      }),
    ).toMatchObject({ outcome: "REJECTED", reason: "BIOMETRIC_PAD_FAILED" });
    expect(engine.mock.calls.length).toBe(calls);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
  });
  it("holds face matching for explicit independent HR approval and preserves unknown liveness", async () => {
    const db = database();
    await enrol(db, "FACE");
    const ticket = await verifyTicket(db, "FACE");
    const result = await submitBiometricSample(signed(ticket), db, {
      engine,
      now,
    });
    expect(result).toMatchObject({
      outcome: "NEEDS_REVIEW",
      reason: "BIOMETRIC_PAD_UNVERIFIED",
    });
    const review = {
      tenantId: TENANT,
      actorId: "operator-2",
      items: [{ id: result.eventId, version: 1 }],
      reason: "Witnessed employee at kiosk",
    };
    for (const action of ["RETRY", "RESOLVE"])
      await expect(
        reviewCaptureEvents({ ...review, action }, db),
      ).rejects.toMatchObject({ status: 409 });
    await expect(
      reviewCaptureEvents(
        { ...review, actorId: "operator-1", action: "APPROVE_BIOMETRIC" },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await reviewCaptureEvents({ ...review, action: "APPROVE_BIOMETRIC" }, db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({
      state: "PENDING",
      biometricApprovedBy: "operator-2",
      raw: { biometric: { pad: "UNKNOWN" } },
    });
  });
  it("holds unvalidated SDK reports and late valid fingerprint uploads for review", async () => {
    for (const late of [false, true]) {
      const db = database();
      await enrol(db);
      if (!late)
        await db.attendanceCaptureDevice.update({
          where: { id: device.id },
          data: { fingerprintPadValidated: false },
        });
      const current = await db.attendanceCaptureDevice.findFirst({
        where: { id: device.id },
      });
      const ticket = await requestBiometricVerification(
        {
          device: current,
          employeeCode: "EMP1",
          modality: "FINGERPRINT",
          slot: "RIGHT_INDEX",
          direction: 0,
        },
        db,
        now,
      );
      const result = await submitBiometricSample(
        { ...signed(ticket), device: current },
        db,
        { engine, now: new Date(+now + (late ? 120000 : 0)) },
      );
      expect(result.outcome).toBe("NEEDS_REVIEW");
      const review = {
        tenantId: TENANT,
        actorId: "operator-2",
        items: [{ id: result.eventId, version: 1 }],
        reason: "Witness and delivery log checked",
      };
      await expect(
        reviewCaptureEvents({ ...review, action: "RETRY" }, db),
      ).rejects.toMatchObject({ status: 409 });
      await reviewCaptureEvents({ ...review, action: "APPROVE_BIOMETRIC" }, db);
    }
  });
  it("guards the worker against an unapproved biometric accidentally marked pending", async () => {
    const db = database();
    await enrol(db, "FACE");
    const result = await submitBiometricSample(
      signed(await verifyTicket(db, "FACE")),
      db,
      { engine, now },
    );
    await db.attendanceCaptureEvent.update({
      where: { id: result.eventId },
      data: { state: "PENDING" },
    });
    const evaluate = jest.fn();
    await drainCapture({ now: new Date("2027-01-01"), limit: 1, evaluate }, db);
    expect(evaluate).not.toHaveBeenCalled();
    expect(db.snapshot().attendanceDevicePunch).toHaveLength(0);
  });
  it("keeps infrastructure failures retryable without acknowledging or consuming the sample", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    const unavailable = async () => {
      throw Object.assign(new Error("Engine offline"), { status: 503 });
    };
    await expect(
      submitBiometricSample(signed(ticket), db, { engine: unavailable, now }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      db.snapshot().attendanceBiometricChallenge[0].consumedAt,
    ).toBeUndefined();
    expect(
      (await submitBiometricSample(signed(ticket), db, { engine, now }))
        .outcome,
    ).toBe("ENROLLED");
  });
  it("rejects changed model versions and missing calibrated thresholds", async () => {
    const db = database();
    await enrol(db);
    const ticket = await verifyTicket(db);
    engine.mockImplementationOnce(async () => ({
      engine: "SOURCEAFIS",
      engineVersion: "different",
      template: "NEW",
    }));
    await expect(
      submitBiometricSample(signed(ticket), db, { engine, now }),
    ).rejects.toMatchObject({ status: 409 });
    delete process.env.BIOMETRIC_FINGERPRINT_THRESHOLD;
    await expect(verifyTicket(db)).rejects.toMatchObject({ status: 503 });
  });
  it("blocks a kiosk credential from bypassing biometric intake through legacy uploads", async () => {
    await expect(
      receiveCapture(
        { sn: device.sn, rows: ["101\t2026-10-10 09:00:00\t0"] },
        database(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("invalidates tickets when site configuration changes and requires an audit reason", async () => {
    const db = database();
    const ticket = await requestBiometricEnrolment(args(), db, now);
    await configureBiometricDevice(
      {
        tenantId: TENANT,
        actorId: "operator-1",
        id: device.id,
        publicKey: device.biometricPublicKey,
        site: "Site 2",
        reason: "Moved kiosk",
      },
      db,
    );
    await expect(
      submitBiometricSample(signed(ticket), db, { engine, now }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      requestBiometricEnrolment(args({ reason: "" }), db, now),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("caps challenge issuance per employee and requires an explicit IN/OUT direction", async () => {
    const db = database();
    await enrol(db);
    await expect(
      verifyTicket(db, "FINGERPRINT", { direction: 2 }),
    ).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 4; i++) await verifyTicket(db);
    await expect(verifyTicket(db)).rejects.toMatchObject({ status: 429 });
  });
  it("binds encrypted templates to their tenant and employee context", () => {
    const ciphertext = sealTemplate(
      { template: "secret" },
      "tenant-a:employee-1",
    );
    expect(openTemplate(ciphertext, "tenant-a:employee-1")).toEqual({
      template: "secret",
    });
    expect(() => openTemplate(ciphertext, "tenant-b:employee-1")).toThrow(
      /decrypted/,
    );
  });
  it("refuses a private signing key in the public device configuration", async () => {
    await expect(
      configureBiometricDevice(
        {
          tenantId: TENANT,
          actorId: "operator-1",
          id: device.id,
          publicKey: privateKey.export({ type: "pkcs8", format: "pem" }),
          site: "Office",
          reason: "Provision",
        },
        database(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("does not rewrite explicit biometric OUT to IN or deduplicate opposite actions", () => {
    const punch = {
      punchedAt: new Date("2026-10-10T09:00:00Z"),
      status: 1,
      directionVerified: true,
    };
    const roster = { shift: { from: "09:00", to: "17:00" } };
    expect(sessioniseByRoster([punch], roster)[0].punches[0].type).toBe("OUT");
    const paired = sessioniseByRoster(
      [
        { ...punch, status: 0 },
        { ...punch, punchedAt: new Date(+punch.punchedAt + 60000) },
      ],
      roster,
    );
    expect(paired.flatMap((day) => day.punches).map((p) => p.type)).toEqual([
      "IN",
      "OUT",
    ]);
  });
});
