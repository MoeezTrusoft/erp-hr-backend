import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { z } from "zod";
import { captureError } from "./attendanceCapture.js";

export const biometricModality = z.enum(["FACE", "FINGERPRINT"]);
export const biometricSlot = z.enum([
  "FACE",
  "LEFT_THUMB",
  "LEFT_INDEX",
  "RIGHT_THUMB",
  "RIGHT_INDEX",
]);
export const sampleSchema = z
  .object({
    sn: z.string().min(1).max(64),
    challengeId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    modality: biometricModality,
    format: z.enum(["JPEG", "GRAY8"]),
    imageBase64: z.string().min(1).max(2800000),
    width: z.number().int().min(1).max(2048).nullable(),
    height: z.number().int().min(1).max(2048).nullable(),
    dpi: z.number().int().min(250).max(1000).nullable(),
    pad: z.enum(["PASSED", "FAILED", "UNKNOWN"]),
    padLevel: z.number().int().min(0).max(100),
  })
  .strict();

// Fixed array protocol, shared with the site agent. Do not sign arbitrary JSON
// object serialization or omit metadata that affects the verification decision.
export const sampleMessage = (s) =>
  JSON.stringify([
    s.challengeId,
    s.sn,
    s.capturedAt,
    s.modality,
    s.format,
    s.dpi,
    s.width,
    s.height,
    s.pad,
    s.padLevel,
    s.imageBase64,
  ]);
export const sampleDigest = (s) =>
  createHash("sha256").update(sampleMessage(s)).digest("hex");
export function assertPublicKey(pem) {
  try {
    if (
      typeof pem !== "string" ||
      pem.length > 2048 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(
        pem,
      ) ||
      createPublicKey(pem).asymmetricKeyType !== "ed25519"
    )
      throw new Error();
  } catch {
    throw captureError("An Ed25519 public key in PEM format is required");
  }
}
export function validateSignedSample(input, signature, device) {
  const parsed = sampleSchema.safeParse(input);
  if (!parsed.success) throw captureError("Invalid biometric capture payload");
  const s = parsed.data;
  if (!device.biometricPublicKey || !device.biometricSite || s.sn !== device.sn)
    throw captureError("Biometric device is not provisioned", 403);
  try {
    if (
      typeof signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
      !verify(
        null,
        Buffer.from(sampleMessage(s)),
        device.biometricPublicKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error();
  } catch {
    throw captureError("Invalid biometric capture signature", 403);
  }
  const image = Buffer.from(s.imageBase64, "base64");
  if (image.toString("base64") !== s.imageBase64)
    throw captureError("Invalid image encoding");
  if (image.length > 2 * 1024 * 1024)
    throw captureError("Biometric sample is too large", 413);
  if (s.modality === "FINGERPRINT") {
    if (
      s.format !== "GRAY8" ||
      s.dpi !== 500 ||
      s.width !== 300 ||
      s.height !== 400 ||
      image.length !== s.width * s.height
    )
      throw captureError(
        "HU20 captures require a 300 by 400, 500 DPI grayscale image",
      );
  } else if (
    s.format !== "JPEG" ||
    s.width !== null ||
    s.height !== null ||
    s.dpi !== null ||
    s.pad !== "UNKNOWN" ||
    s.padLevel !== 0
  ) {
    throw captureError(
      "InsightFace performs recognition; this adapter cannot attest face liveness",
    );
  }
  return s;
}
function encryptionConfig() {
  let keys;
  try {
    keys = JSON.parse(process.env.BIOMETRIC_ENCRYPTION_KEYS || "{}");
  } catch {
    throw captureError("Biometric encryption is not configured", 503);
  }
  const id = process.env.BIOMETRIC_ACTIVE_KEY_ID;
  const read = (keyId) => {
    const raw = keys[keyId];
    if (typeof raw !== "string" || !/^[a-fA-F0-9]{64}$/.test(raw))
      throw captureError("Biometric encryption key is unavailable", 503);
    return Buffer.from(raw, "hex");
  };
  return { id, read };
}
export function sealTemplate(value, context) {
  const { id, read } = encryptionConfig();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", read(id), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    kid: id,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}
export function openTemplate(envelope, context) {
  try {
    const value = JSON.parse(envelope);
    if (value.v !== 1) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionConfig().read(value.kid),
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.data, "base64")),
        decipher.final(),
      ]).toString(),
    );
  } catch {
    throw captureError("Biometric template could not be decrypted", 503);
  }
}
export const templateContext = (p) =>
  `${p.tenantId}:${p.employeeId}:${p.modality}:${p.slot}:${p.id}:${p.engineVersion}`;
export function matchThreshold(modality) {
  const value =
    process.env[
      modality === "FACE"
        ? "BIOMETRIC_FACE_THRESHOLD"
        : "BIOMETRIC_FINGERPRINT_THRESHOLD"
    ];
  const number = Number(value);
  if (
    !value ||
    !Number.isFinite(number) ||
    number <= 0 ||
    (modality === "FACE" && number >= 1) ||
    (modality === "FINGERPRINT" && number > 1000)
  )
    throw captureError(
      `Configure a calibrated ${modality.toLowerCase()} match threshold`,
      503,
    );
  return number;
}
export const profilePublic = ({
  encryptedTemplate: _encryptedTemplate,
  ...profile
}) => profile;
