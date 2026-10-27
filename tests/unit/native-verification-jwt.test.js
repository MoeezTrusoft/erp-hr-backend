import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { generateKeyPairSync, verify, randomUUID } from "node:crypto";
import { nativeFixture } from "../fixtures/native-verification.js";
import { nativeDigest, nativeProvisioningKey } from "../../src/lib/native-verification-plan.js";
import { signNativeVerificationJwt, signNativeCleanupJwt } from "../../src/lib/serviceJwt.js";
import { mcpCtx } from "../../src/mcp/context.js";

const names = [
  "SERVICE_JWT_PRIVATE_KEY_PEM",
  "SERVICE_JWT_CURRENT_KID",
  "SERVICE_JWT_SELF_ISSUER",
  "SERVICE_JWT_AUDIENCE",
  "SERVICE_JWT_SECRET",
];
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const keys = generateKeyPairSync("ed25519");
const f = nativeFixture();
const worker = {
  version: 1,
  grantId: f.plan.grantId,
  grantFingerprint: nativeDigest(f.plan),
  runId: f.plan.runId,
  entryId: f.entry.entryId,
  provisioningId: randomUUID(),
  employeeId: 101,
  idempotencyKey: nativeProvisioningKey(f.plan.tenantId, 101),
  payloadFingerprint: "a".repeat(64),
};
const cleanup = {
  ...worker,
  tenantId: f.plan.tenantId,
  bootstrapUserId: f.plan.bootstrap.userId,
  employeeStatus: "Inactive",
  grantStatus: "CANCELLED",
  deactivationReceiptId: randomUUID(),
};
const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
beforeEach(() => {
  process.env.SERVICE_JWT_PRIVATE_KEY_PEM = keys.privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  process.env.SERVICE_JWT_CURRENT_KID = "hr-owned-test";
  process.env.SERVICE_JWT_SELF_ISSUER = "unrelated-configured-issuer";
  process.env.SERVICE_JWT_AUDIENCE = "unrelated-configured-audience";
  process.env.SERVICE_JWT_SECRET = "must-not-be-used";
});
afterAll(() => {
  for (const name of names)
    previous[name] === undefined ? delete process.env[name] : (process.env[name] = previous[name]);
});
const signWorker = (claim) =>
  mcpCtx.run(f.ctx, () =>
    signNativeVerificationJwt({ userId: f.ctx.user.userId, sdlcVerification: claim }),
  );

describe("native HR signed provenance", () => {
  it("pins issuer/audience and signs the complete worker claim with the actual HR Ed25519 key", () => {
    const token = signWorker(worker),
      parts = token.split(".");
    expect(
      verify(
        null,
        Buffer.from(parts.slice(0, 2).join(".")),
        keys.publicKey,
        Buffer.from(parts[2], "base64url"),
      ),
    ).toBe(true);
    expect(decode(token)).toMatchObject({
      iss: "erp-hr-backend",
      sub: "erp-hr-backend",
      aud: "internal",
      tid: f.plan.tenantId,
      sdlcVerification: worker,
    });
    expect(decode(token).exp - decode(token).iat).toBe(60);
  });
  it("requires verified actor and matching signer-side user identity", () => {
    expect(
      signNativeVerificationJwt({ userId: f.ctx.user.userId, sdlcVerification: worker }),
    ).toBeNull();
    expect(
      mcpCtx.run(f.ctx, () => signNativeVerificationJwt({ userId: "8", sdlcVerification: worker })),
    ).toBeNull();
  });
  it.each(["SERVICE_JWT_PRIVATE_KEY_PEM", "SERVICE_JWT_CURRENT_KID"])(
    "never falls back to HMAC when %s is missing",
    (name) => {
      delete process.env[name];
      expect(signWorker(worker)).toBeNull();
      expect(signNativeCleanupJwt(cleanup)).toBeNull();
    },
  );
  it("rejects a non-Ed25519 key", () => {
    process.env.SERVICE_JWT_PRIVATE_KEY_PEM = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(signWorker(worker)).toBeNull();
    expect(signNativeCleanupJwt(cleanup)).toBeNull();
  });
  it("rejects malformed or expanded worker claims", () => {
    expect(signWorker({ ...worker, provisioningId: "invented" })).toBeNull();
    expect(signWorker({ ...worker, password: "not-allowed" })).toBeNull();
  });
  it("signs cleanup only with its distinct audience and bounded lifetime, without actor impersonation", () => {
    const token = signNativeCleanupJwt(cleanup),
      claims = decode(token);
    expect(claims).toMatchObject({
      iss: "erp-hr-backend",
      aud: "erp-rbac:sdlc-cleanup",
      sdlcCleanup: cleanup,
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.userId).toBeUndefined();
  });
  it.each(["employeeStatus", "grantStatus", "deactivationReceiptId", "tenantId"])(
    "refuses invalid cleanup %s",
    (field) => {
      expect(signNativeCleanupJwt({ ...cleanup, [field]: "invalid" })).toBeNull();
    },
  );
});
