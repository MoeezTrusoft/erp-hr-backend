import { describe, it, expect, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { nativeFixture } from "../fixtures/native-verification.js";
import { nativeDigest, nativeProvisioningKey } from "../../src/lib/native-verification-plan.js";
import {
  checkNativeHrCreate,
  authorizeNativeHrCreate,
  lockNativeHrGrant,
  assertNativeOwnedIntent,
  withNativeHrWorkerClaim,
} from "../../src/services/native-verification-guard.service.js";

const check = (fixture) =>
  checkNativeHrCreate(fixture.plan, fixture.data, fixture.ctx, fixture.entry.entryId, fixture.now);
const denied = (fn) => expect(fn).toThrow("HR-0310");
const clone = (value) => structuredClone(value);

function ownedFixture() {
  const fixture = nativeFixture(),
    { plan, entry, ctx } = fixture;
  const payload = {
    first_name: entry.firstName,
    last_name: entry.lastName,
    job_title: entry.jobTitle,
    email: entry.email,
    phone: entry.phone,
    gender: entry.gender,
    hire_date: entry.hireDate,
    status: "Active",
    roles: [{ roleId: entry.roleId }],
    hrEmployeeId: 101,
    mediaId: null,
    departmentId: null,
  };
  const intent = {
    id: randomUUID(),
    tenantId: plan.tenantId,
    employeeId: 101,
    payload,
    payloadFingerprint: nativeDigest(payload),
    idempotencyKey: nativeProvisioningKey(plan.tenantId, 101),
    actor: { ...ctx.user, permissions: ctx.permissions },
    status: "PROCESSING",
    claimedBy: "worker",
    claimExpiresAt: new Date(fixture.now.getTime() + 60000),
  };
  const owned = {
    tenantId: plan.tenantId,
    grantId: plan.grantId,
    entryId: entry.entryId,
    employeeId: 101,
    provisioningId: intent.id,
    idempotencyKey: intent.idempotencyKey,
    payloadFingerprint: intent.payloadFingerprint,
    requestFingerprint: fixture.authorization.requestFingerprint,
    actorUserId: plan.bootstrap.userId,
  };
  const grant = {
    id: plan.grantId,
    tenantId: plan.tenantId,
    plan,
    fingerprint: nativeDigest(plan),
    bootstrapUserId: plan.bootstrap.userId,
    expiresAt: new Date(plan.expiresAt),
    cancelledAt: null,
    operatorReceiptId: "123",
    operatorReceiptFingerprint: "c".repeat(64),
  };
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    nativeVerificationGrant: { findFirst: jest.fn(async () => grant) },
    nativeVerificationEntry: { findFirst: jest.fn(async () => owned) },
    systemAccountProvisioning: { findFirst: jest.fn(async () => intent) },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn) => fn(tx)) };
  return { ...fixture, intent, owned, grant, tx, prisma };
}

describe("native HR verification scope", () => {
  it("allows the exact verified bootstrap profile without an employee actor", () => {
    const f = nativeFixture();
    expect(check(f).entry.entryId).toBe(f.entry.entryId);
  });
  it.each(["employeeId", "isAdmin", "userId", "tenantId", "roles", "email"])(
    "rejects changed actor %s",
    (field) => {
      const f = nativeFixture();
      f.ctx.user[field] = field === "roles" ? ["HR_ADMIN"] : field === "isAdmin" ? true : "999";
      denied(() => check(f));
    },
  );
  it.each(["actorVerified", "system", "permissions"])(
    "does not grant authority via %s",
    (field) => {
      const f = nativeFixture();
      f.ctx[field] =
        field === "permissions" ? [...f.ctx.permissions, "hr.employee.update"] : field === "system";
      denied(() => check(f));
    },
  );
  it.each([
    "password",
    "permissions",
    "permissionMap",
    "additionalFields",
    "profilePhotoBase64",
    "departmentId",
    "nativeGrant",
  ])("rejects unrelated field %s before side effects", (field) => {
    const f = nativeFixture();
    f.data[field] = "injected";
    denied(() => check(f));
  });
  it("binds outer request key and exact role/profile", () => {
    const f = nativeFixture();
    denied(() => checkNativeHrCreate(f.plan, f.data, f.ctx, randomUUID(), f.now));
    f.data.roleId++;
    denied(() => check(f));
  });
  it("rejects expired plans even on replay", () => {
    const f = nativeFixture();
    f.now = new Date(f.plan.expiresAt);
    denied(() => check(f));
  });
  it("fails closed without a plan for the reserved identity, leaving ordinary creation unchanged", async () => {
    const f = nativeFixture(),
      loadPlan = async () => null;
    await expect(
      authorizeNativeHrCreate(f.data, { ctx: f.ctx, loadPlan, idempotencyKey: f.entry.entryId }),
    ).rejects.toThrow("HR-0310");
    expect(
      await authorizeNativeHrCreate({ firstName: "Ordinary" }, { ctx: {}, loadPlan }),
    ).toBeNull();
  });
  it("requires a durable operator receipt, not only the mounted plan", async () => {
    const f = ownedFixture();
    f.tx.nativeVerificationGrant.findFirst.mockResolvedValue(null);
    await expect(lockNativeHrGrant(f.tx, f.authorization, f.now)).rejects.toThrow("HR-0310");
  });
  it.each(["cancelled", "expired", "fingerprint"])("rejects %s durable grant", async (kind) => {
    const f = ownedFixture();
    if (kind === "cancelled") f.grant.cancelledAt = f.now;
    if (kind === "expired") f.grant.expiresAt = f.now;
    if (kind === "fingerprint") f.grant.fingerprint = "d".repeat(64);
    await expect(lockNativeHrGrant(f.tx, f.authorization, f.now)).rejects.toThrow("HR-0310");
  });
  it.each(["id", "employeeId", "idempotencyKey", "payloadFingerprint", "tenantId"])(
    "rejects changed provisioning %s",
    (key) => {
      const f = ownedFixture(),
        intent = clone(f.intent);
      intent[key] = key === "employeeId" ? 102 : randomUUID();
      denied(() => assertNativeOwnedIntent(f.authorization, f.owned, intent));
    },
  );
  it("rejects payload or actor drift even with matching employee/key", () => {
    const f = ownedFixture();
    f.intent.payload.roles[0].permissions = [];
    denied(() => assertNativeOwnedIntent(f.authorization, f.owned, f.intent));
  });
  it("passes the complete durable claim only within the locked worker transaction", async () => {
    const f = ownedFixture(),
      run = jest.fn(async (claim) => claim);
    const claim = await withNativeHrWorkerClaim(f.prisma, f.intent, run, {
      loadPlan: async () => f.plan,
      now: () => f.now,
    });
    expect(claim).toMatchObject({
      entryId: f.entry.entryId,
      provisioningId: f.intent.id,
      employeeId: 101,
    });
    expect(f.tx.$queryRaw).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("requires durable ownership even if email and bootstrap role markers are removed", async () => {
    const f = ownedFixture();
    f.intent.actor = {};
    f.intent.payload.email = "ordinary@example.invalid";
    await expect(
      withNativeHrWorkerClaim(f.prisma, f.intent, jest.fn(), { loadPlan: async () => null }),
    ).rejects.toThrow("HR-0310");
  });
  it("does not dispatch from an expired/replaced lease", async () => {
    const f = ownedFixture(),
      run = jest.fn();
    f.intent.claimExpiresAt = f.now;
    await expect(
      withNativeHrWorkerClaim(f.prisma, f.intent, run, {
        loadPlan: async () => f.plan,
        now: () => f.now,
      }),
    ).rejects.toThrow("HR-0310");
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves the owned receipt on an ambiguous RPC failure", async () => {
    const f = ownedFixture(),
      before = clone(f.owned);
    await expect(
      withNativeHrWorkerClaim(
        f.prisma,
        f.intent,
        async () => {
          throw new Error("RPC timeout");
        },
        { loadPlan: async () => f.plan, now: () => f.now },
      ),
    ).rejects.toThrow("RPC timeout");
    expect(f.owned).toEqual(before);
  });
});
