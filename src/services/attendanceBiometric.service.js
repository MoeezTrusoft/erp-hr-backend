import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  captureError,
  fingerprint,
  jsonValue,
  parseCaptureTimestamp,
} from "../lib/attendanceCapture.js";
import {
  assertPublicKey,
  biometricModality,
  biometricSlot,
  matchThreshold,
  openTemplate,
  profilePublic,
  sampleDigest,
  sampleSchema,
  sealTemplate,
  templateContext,
  validateSignedSample,
} from "../lib/attendanceBiometric.js";
import { captureAudit, devicePublic } from "./attendanceCapture.service.js";
import { callBiometricEngine } from "./biometricEngine.client.js";

const system = (fn) => mcpCtx.run({ system: true }, fn);
const deviceConfigHash = (d) =>
  fingerprint([
    d.biometricPublicKey,
    d.biometricSite,
    d.timeZone,
    d.fingerprintPadLevel,
    d.fingerprintPadValidated,
  ]);
const validSlot = (modality, slot) =>
  biometricSlot.safeParse(slot).success &&
  (modality === "FACE") === (slot === "FACE");
const requireReason = (reason) => {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000)
    throw captureError("An audit reason is required");
};
async function registeredDevice(db, id, tenantId) {
  const device = await db.attendanceCaptureDevice.findFirst({
    where: { id, tenantId, active: true },
  });
  if (!device?.biometricPublicKey || !device.biometricSite)
    throw captureError("Provision an active biometric kiosk first", 409);
  return device;
}
export async function configureBiometricDevice(
  {
    tenantId,
    actorId,
    id,
    publicKey,
    site,
    fingerprintPadLevel = 0,
    fingerprintPadValidated = false,
    reason,
  },
  db = prisma,
) {
  requireReason(reason);
  assertPublicKey(publicKey);
  if (
    !site?.trim() ||
    site.length > 120 ||
    !Number.isInteger(fingerprintPadLevel) ||
    fingerprintPadLevel < 0 ||
    fingerprintPadLevel > 100 ||
    (fingerprintPadValidated && fingerprintPadLevel === 0)
  )
    throw captureError(
      "Site and a supported, tested fingerprint PAD level are required",
    );
  return tenantTransaction(
    db,
    async (tx) => {
      const device = await tx.attendanceCaptureDevice.findFirst({
        where: { id, tenantId },
      });
      if (!device) throw captureError("Device not found", 404);
      const updated = await tx.attendanceCaptureDevice.update({
        where: { id, tenantId },
        data: {
          biometricPublicKey: publicKey,
          biometricSite: site.trim(),
          fingerprintPadLevel,
          fingerprintPadValidated,
        },
      });
      await captureAudit(tx, {
        tenantId,
        actorId,
        action: "BIOMETRIC_DEVICE_CONFIGURED",
        reason,
        detail: {
          id,
          site: site.trim(),
          publicKeyFingerprint: fingerprint(publicKey),
          fingerprintPadLevel,
          fingerprintPadValidated,
        },
      });
      return devicePublic(updated);
    },
    { tenantId },
  );
}
async function createChallenge(args, db, now) {
  const {
    tenantId,
    employeeId,
    deviceId,
    modality,
    purpose,
    slot,
    direction,
    actorId,
    reason,
  } = args;
  if (
    !Number.isInteger(employeeId) ||
    employeeId <= 0 ||
    !biometricModality.safeParse(modality).success ||
    !validSlot(modality, slot)
  )
    throw captureError(
      "Valid employee, modality and biometric slot are required",
    );
  if (purpose === "VERIFY" && ![0, 1].includes(direction))
    throw captureError("Select an explicit IN or OUT attendance action");
  return tenantTransaction(
    db,
    async (tx) => {
      const device = await registeredDevice(tx, deviceId, tenantId);
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, tenant_id: tenantId },
      });
      if (!employee) throw captureError("Employee not found", 404);
      // A per-device database lock makes the issue-rate limit effective across HR instances.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`biometric-issue:${deviceId}`}))`;
      const issued = await tx.attendanceBiometricChallenge.count({
        where: {
          deviceId,
          tenantId,
          createdAt: { gte: new Date(+now - 60000) },
        },
      });
      const employeeAttempts = await tx.attendanceBiometricChallenge.count({
        where: {
          deviceId,
          tenantId,
          employeeId,
          createdAt: { gte: new Date(+now - 60000) },
        },
      });
      if (issued >= 60 || employeeAttempts >= 5)
        throw captureError("Too many capture attempts; wait one minute", 429);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`biometric-profile:${tenantId}:${employeeId}:${modality}:${slot}`}))`;
      const profile = await tx.attendanceBiometricProfile.findFirst({
        where: { tenantId, employeeId, modality, slot, active: true },
      });
      if (purpose === "VERIFY") {
        matchThreshold(modality);
        if (!profile)
          throw captureError("This biometric has not been enrolled", 409);
      }
      const row = await tx.attendanceBiometricChallenge.create({
        data: {
          tenantId,
          employeeId,
          deviceId,
          modality,
          purpose,
          slot,
          direction: direction ?? null,
          expectedProfileId: profile?.id ?? null,
          deviceConfigHash: deviceConfigHash(device),
          actorId: actorId == null ? null : String(actorId),
          reason: reason || null,
          createdAt: now,
          expiresAt: new Date(+now + (purpose === "ENROL" ? 300000 : 90000)),
        },
      });
      if (purpose === "ENROL")
        await captureAudit(tx, {
          tenantId,
          actorId,
          action: "BIOMETRIC_ENROLMENT_REQUESTED",
          reason,
          detail: { employeeId, modality, slot, deviceId, challengeId: row.id },
        });
      return {
        challengeId: row.id,
        employeeId,
        modality,
        purpose,
        slot,
        direction: row.direction,
        expiresAt: row.expiresAt,
        sn: device.sn,
        site: device.biometricSite,
        fingerprintPadLevel: device.fingerprintPadLevel,
      };
    },
    { tenantId },
  );
}
export async function requestBiometricEnrolment(
  args,
  db = prisma,
  now = new Date(),
) {
  requireReason(args.reason);
  if (!args.actorId)
    throw captureError("An authenticated HR operator is required", 403);
  return createChallenge({ ...args, purpose: "ENROL" }, db, now);
}
export async function requestBiometricVerification(
  { device, employeeCode, modality, slot, direction },
  db = prisma,
  now = new Date(),
) {
  if (
    typeof employeeCode !== "string" ||
    !employeeCode.trim() ||
    employeeCode.length > 64
  )
    throw captureError("Employee code is required");
  // Biometric kiosks are owner-company scoped; legacy shared-device mappings do
  // not authorize a kiosk to enumerate another company's biometric gallery.
  return system(async () => {
    const employees = await db.employee.findMany({
      where: { tenant_id: device.tenantId, employee_code: employeeCode.trim() },
      take: 2,
    });
    if (employees.length !== 1)
      throw captureError("Employee code is unavailable or ambiguous", 409);
    return createChallenge(
      {
        tenantId: device.tenantId,
        employeeId: employees[0].id,
        deviceId: device.id,
        modality,
        slot,
        direction,
        purpose: "VERIFY",
      },
      db,
      now,
    );
  });
}
export async function readBiometricChallenge(
  { device, id },
  db = prisma,
  now = new Date(),
) {
  if (!sampleSchema.shape.challengeId.safeParse(id).success)
    throw captureError("A valid capture request ID is required");
  return system(async () => {
    const row = await db.attendanceBiometricChallenge.findFirst({
      where: { id, deviceId: device.id, tenantId: device.tenantId },
    });
    if (!row || row.consumedAt || +row.expiresAt <= +now)
      throw captureError("Capture request is unavailable or expired", 409);
    return {
      challengeId: row.id,
      modality: row.modality,
      slot: row.slot,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      sn: device.sn,
      fingerprintPadLevel: device.fingerprintPadLevel,
    };
  });
}
export async function listBiometricProfiles(
  { tenantId, employeeId },
  db = prisma,
) {
  if (!Number.isInteger(employeeId) || employeeId <= 0)
    throw captureError("Employee is required");
  const profiles = await db.attendanceBiometricProfile.findMany({
    where: { tenantId, employeeId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return { items: profiles.map(profilePublic) };
}
export async function revokeBiometricProfile(
  { tenantId, actorId, id, reason },
  db = prisma,
) {
  requireReason(reason);
  return tenantTransaction(
    db,
    async (tx) => {
      const profile = await tx.attendanceBiometricProfile.findFirst({
        where: { id, tenantId, active: true },
      });
      if (!profile)
        throw captureError("Active biometric enrolment not found", 404);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`biometric-profile:${tenantId}:${profile.employeeId}:${profile.modality}:${profile.slot}`}))`;
      if (
        !(await tx.attendanceBiometricProfile.findFirst({
          where: { id, tenantId, active: true },
        }))
      )
        throw captureError(
          "Enrolment changed; refresh the employee enrolments",
          409,
        );
      await tx.attendanceBiometricProfile.update({
        where: { id, tenantId },
        data: { active: false, revokedAt: new Date(), encryptedTemplate: null },
      });
      await captureAudit(tx, {
        tenantId,
        actorId,
        action: "BIOMETRIC_REVOKED",
        reason,
        detail: { profileId: id, employeeId: profile.employeeId },
      });
      return { revoked: true };
    },
    { tenantId },
  );
}
export async function submitBiometricSample(
  { device, input, signature },
  db = prisma,
  { engine = callBiometricEngine, now = new Date() } = {},
) {
  const sample = validateSignedSample(input, signature, device);
  const digest = sampleDigest(sample);
  return system(async () => {
    const challenge = await db.attendanceBiometricChallenge.findFirst({
      where: {
        id: sample.challengeId,
        deviceId: device.id,
        tenantId: device.tenantId,
      },
    });
    if (!challenge) throw captureError("Capture request not found", 404);
    if (challenge.consumedAt) {
      if (challenge.payloadHash !== digest)
        throw captureError(
          "Capture request was already used with different evidence",
          409,
        );
      return { ...challenge.result, replayed: true };
    }
    const capturedAt = new Date(sample.capturedAt);
    if (
      +now >
        +challenge.expiresAt +
          (challenge.purpose === "VERIFY" ? 86400000 : 0) ||
      challenge.modality !== sample.modality ||
      +capturedAt < +challenge.createdAt - 5000 ||
      +capturedAt > +now + 5000 ||
      +capturedAt > +challenge.expiresAt
    )
      throw captureError(
        "Capture request expired or does not match this sample",
        409,
      );
    let profile, extracted, matched, rejection;
    if (sample.pad === "FAILED") rejection = "BIOMETRIC_PAD_FAILED";
    if (!rejection) {
      try {
        extracted = await engine(sample.modality, "extract", {
          format: sample.format,
          imageBase64: sample.imageBase64,
          width: sample.width,
          height: sample.height,
          dpi: sample.dpi,
        });
        if (challenge.purpose === "VERIFY") {
          profile = await db.attendanceBiometricProfile.findFirst({
            where: {
              id: challenge.expectedProfileId,
              tenantId: challenge.tenantId,
              employeeId: challenge.employeeId,
              modality: challenge.modality,
              slot: challenge.slot,
              active: true,
            },
          });
          if (!profile)
            throw captureError(
              "Biometric enrolment was revoked; start again",
              409,
            );
          if (
            profile.engineVersion !== extracted.engineVersion ||
            profile.engine !== extracted.engine
          )
            throw captureError(
              "Biometric engine changed; re-enrol this employee",
              409,
            );
          const stored = openTemplate(
            profile.encryptedTemplate,
            templateContext(profile),
          );
          const result = await engine(sample.modality, "match", {
            probe: extracted.template,
            candidate: stored.template,
            engineVersion: profile.engineVersion,
          });
          if (
            result.engineVersion !== profile.engineVersion ||
            result.engine !== profile.engine
          )
            throw captureError(
              "Recognition engine version changed during verification",
              503,
            );
          const threshold = matchThreshold(sample.modality);
          matched = {
            score: result.score,
            threshold,
            matched: result.score >= threshold,
          };
          if (!matched.matched) rejection = "BIOMETRIC_NO_MATCH";
        }
      } catch (err) {
        if (err.status === 422) rejection = "BIOMETRIC_SAMPLE_REJECTED";
        else throw err; // Infrastructure failures may retry the same signed sample.
      }
    }
    return tenantTransaction(
      db,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`biometric-challenge:${challenge.id}`}))`;
        const fresh = await tx.attendanceBiometricChallenge.findFirst({
          where: { id: challenge.id, tenantId: challenge.tenantId },
        });
        if (fresh.consumedAt) {
          if (fresh.payloadHash !== digest)
            throw captureError(
              "Capture request was already used with different evidence",
              409,
            );
          return { ...fresh.result, replayed: true };
        }
        // Serialize security changes without blocking the KEY SHARE lock taken
        // by concurrent challenge inserts referencing this device.
        await tx.$executeRaw`SELECT id FROM attendance_capture_devices WHERE id = ${device.id}::uuid FOR NO KEY UPDATE`;
        const current = await registeredDevice(tx, device.id, device.tenantId);
        if (
          deviceConfigHash(current) !== challenge.deviceConfigHash ||
          deviceConfigHash(current) !== deviceConfigHash(device)
        )
          throw captureError(
            "Device security configuration changed; start a new capture",
            409,
          );
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`biometric-profile:${challenge.tenantId}:${challenge.employeeId}:${challenge.modality}:${challenge.slot}`}))`;
        const employee = await tx.employee.findFirst({
          where: { id: challenge.employeeId, tenant_id: challenge.tenantId },
        });
        if (!employee)
          throw captureError("Employee is no longer available", 409);
        const currentProfile = await tx.attendanceBiometricProfile.findFirst({
          where: {
            tenantId: challenge.tenantId,
            employeeId: challenge.employeeId,
            modality: challenge.modality,
            slot: challenge.slot,
            active: true,
          },
        });
        if ((currentProfile?.id ?? null) !== challenge.expectedProfileId)
          throw captureError(
            "Biometric enrolment changed during capture; start again",
            409,
          );
        const pad =
          sample.modality === "FINGERPRINT" &&
          sample.pad === "PASSED" &&
          current.fingerprintPadValidated &&
          current.fingerprintPadLevel > 0 &&
          sample.padLevel === current.fingerprintPadLevel
            ? "PASSED"
            : "UNKNOWN";
        let outcome;
        if (rejection) outcome = { outcome: "REJECTED", reason: rejection };
        else if (challenge.purpose === "ENROL") {
          await tx.attendanceBiometricProfile.updateMany({
            where: {
              tenantId: challenge.tenantId,
              employeeId: challenge.employeeId,
              modality: challenge.modality,
              slot: challenge.slot,
              active: true,
            },
            data: { active: false, revokedAt: now, encryptedTemplate: null },
          });
          const record = {
            id: randomUUID(),
            tenantId: challenge.tenantId,
            employeeId: challenge.employeeId,
            modality: challenge.modality,
            slot: challenge.slot,
            engine: extracted.engine,
            engineVersion: extracted.engineVersion,
            enrolledBy: challenge.actorId,
            enrolledDeviceId: device.id,
          };
          await tx.attendanceBiometricProfile.create({
            data: {
              ...record,
              encryptedTemplate: sealTemplate(
                { template: extracted.template },
                templateContext(record),
              ),
            },
          });
          outcome = {
            outcome: "ENROLLED",
            profileId: record.id,
            modality: record.modality,
            slot: record.slot,
          };
        } else {
          const receiptId = randomUUID(),
            eventId = randomUUID();
          const state =
            pad === "PASSED" && +now <= +challenge.expiresAt
              ? "PENDING"
              : "NEEDS_REVIEW";
          const reviewReason =
            pad !== "PASSED"
              ? "BIOMETRIC_PAD_UNVERIFIED"
              : "BIOMETRIC_DELAYED_UPLOAD";
          const summary = {
            received: 1,
            stored: 1,
            duplicates: 0,
            pending: state === "PENDING" ? 1 : 0,
            needsReview: state === "NEEDS_REVIEW" ? 1 : 0,
          };
          await tx.attendanceCaptureReceipt.create({
            data: {
              id: receiptId,
              tenantId: challenge.tenantId,
              source: "BIOMETRIC",
              sn: device.sn,
              requestKey: challenge.id,
              payloadHash: digest,
              summary,
            },
          });
          const deviceUserId = `BIO:${challenge.employeeId}`;
          const times = parseCaptureTimestamp(
            sample.capturedAt,
            current.timeZone,
          );
          await tx.attendanceCaptureEvent.create({
            data: {
              id: eventId,
              tenantId: challenge.tenantId,
              receiptId,
              source: "BIOMETRIC",
              sn: device.sn,
              deviceUserId,
              employeeId: challenge.employeeId,
              fingerprint: fingerprint(["BIOMETRIC", challenge.id]),
              raw: {
                receivedAt: now.toISOString(),
                biometric: {
                  ...matched,
                  engine: profile.engine,
                  engineVersion: profile.engineVersion,
                  profileId: profile.id,
                  enrolledBy: profile.enrolledBy,
                  modality: sample.modality,
                  slot: challenge.slot,
                  site: current.biometricSite,
                  pad,
                  delayedUpload: +now > +challenge.expiresAt,
                  reportedPad: sample.pad,
                  padLevel: sample.padLevel,
                  sampleDigest: digest,
                  signature,
                  publicKeyFingerprint: fingerprint(device.biometricPublicKey),
                  challengeId: challenge.id,
                },
              },
              parsed: jsonValue({
                ...times,
                deviceUserId,
                status: challenge.direction,
                verifyMode: sample.modality === "FACE" ? 15 : 1,
                workCode: 0,
                rawLine: `biometric:${challenge.id}`,
              }),
              state,
              reason: state === "NEEDS_REVIEW" ? reviewReason : null,
            },
          });
          outcome = {
            outcome: state,
            eventId,
            receiptId,
            ...summary,
            reason: state === "NEEDS_REVIEW" ? reviewReason : null,
          };
        }
        await tx.attendanceBiometricChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: now, payloadHash: digest, result: outcome },
        });
        await tx.attendanceCaptureDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: now },
        });
        await captureAudit(tx, {
          tenantId: challenge.tenantId,
          actorId: challenge.actorId || `kiosk:${device.sn}`,
          eventId: outcome.eventId,
          receiptId: outcome.receiptId,
          action: `BIOMETRIC_${outcome.outcome}`,
          reason:
            challenge.reason ||
            outcome.reason ||
            "Biometric verification completed",
          detail: {
            challengeId: challenge.id,
            employeeId: challenge.employeeId,
            modality: sample.modality,
            profileId: outcome.profileId || profile?.id,
            ...matched,
          },
        });
        return { ...outcome, replayed: false };
      },
      { tenantId: challenge.tenantId, txOptions: { timeout: 30000 } },
    );
  });
}
