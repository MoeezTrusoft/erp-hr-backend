import { describe, it, expect, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { nativeFixture } from "../fixtures/native-verification.js";
import { nativeDigest, nativeProvisioningKey } from "../../src/lib/native-verification-plan.js";
import { nativeVerificationEntryStatus } from "../../src/services/native-verification-status.service.js";
import { registerNativeVerificationTools } from "../../src/mcp/tools/native-verification-tools.js";
import { mcpCtx } from "../../src/mcp/context.js";
function fixture() {
  const f = nativeFixture(),
    { plan, entry, ctx } = f;
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
    status: "PENDING",
    rbacUserId: null,
    lastError: "PRIVATE_ERROR",
    result: { password: "PRIVATE_PASSWORD" },
  };
  const owned = {
    tenantId: plan.tenantId,
    grantId: plan.grantId,
    entryId: entry.entryId,
    employeeId: 101,
    provisioningId: intent.id,
    idempotencyKey: intent.idempotencyKey,
    payloadFingerprint: intent.payloadFingerprint,
    actorUserId: plan.bootstrap.userId,
    requestFingerprint: f.authorization.requestFingerprint,
    deactivatedAt: null,
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
  const employee = { id: 101, tenant_id: plan.tenantId };
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    nativeVerificationGrant: { findFirst: jest.fn(async () => grant) },
    nativeVerificationEntry: { findFirst: jest.fn(async () => owned) },
    systemAccountProvisioning: { findFirst: jest.fn(async () => intent) },
    employee: { findFirst: jest.fn(async () => employee) },
  };
  const db = { $transaction: jest.fn(async (fn) => fn(tx)) };
  return { ...f, intent, owned, grant, employee, tx, db };
}
const options = (f) => ({ ctx: f.ctx, loadPlan: async () => f.plan, now: () => f.now, db: f.db });
const read = (f) => nativeVerificationEntryStatus({ entryId: f.entry.entryId }, options(f));
const denied = (promise) =>
  expect(promise).rejects.toMatchObject({
    code: "HR-0310",
    status: 403,
    message: "HR-0310: native verification authorization is unavailable",
  });
describe("bootstrap-owned provisioning observation", () => {
  it("returns exactly the eight bound fields without errors, credentials, payload or writes", async () => {
    const f = fixture(),
      before = structuredClone({ owned: f.owned, intent: f.intent, grant: f.grant });
    const result = await read(f);
    expect(Object.keys(result).sort()).toEqual(
      [
        "grantId",
        "entryId",
        "employeeId",
        "provisioningId",
        "idempotencyKey",
        "payloadFingerprint",
        "status",
        "rbacUserId",
      ].sort(),
    );
    expect(result).toMatchObject({ employeeId: 101, status: "PENDING", rbacUserId: null });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|password|lastError|payload":/);
    expect({ owned: f.owned, intent: f.intent, grant: f.grant }).toEqual(before);
    expect(f.tx.nativeVerificationEntry.findFirst).toHaveBeenCalledWith({
      where: { tenantId: f.plan.tenantId, grantId: f.plan.grantId, entryId: f.entry.entryId },
    });
    expect(f.tx.employee.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: f.plan.tenantId, id: 101 },
      select: { id: true, tenant_id: true },
    });
  });
  it("returns every canonical non-success state with a null RBAC ID", async () => {
    for (const state of ["PENDING", "PROCESSING", "RETRY_WAIT", "TERMINAL_FAILED"]) {
      const f = fixture();
      f.intent.status = state;
      expect(await read(f)).toMatchObject({ status: state, rbacUserId: null });
    }
  });
  it("returns only the actual stored canonical positive Int32 ID on success", async () => {
    for (const id of ["1", "2147483647"]) {
      const f = fixture();
      f.intent.status = "SUCCEEDED";
      f.intent.rbacUserId = id;
      expect((await read(f)).rbacUserId).toBe(id);
    }
  });
  it("denies inconsistent, padded, out-of-range and nondecimal success IDs", async () => {
    for (const id of [
      null,
      "",
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "2147483648",
      "Infinity",
      "unknown",
      1,
    ]) {
      const f = fixture();
      f.intent.status = "SUCCEEDED";
      f.intent.rbacUserId = id;
      await denied(read(f));
    }
    const f = fixture();
    f.intent.rbacUserId = "1";
    await denied(read(f));
  });
  it("denies unknown states and malformed output identifiers", async () => {
    const f = fixture();
    f.intent.status = "UNKNOWN";
    await denied(read(f));
    const g = fixture();
    g.owned.employeeId = g.intent.employeeId = g.employee.id = 2147483648;
    await denied(read(g));
  });
  it("denies broad roles, impersonated users, foreign companies, unverified contexts and extra grants", async () => {
    const changes = [
      (f) => (f.ctx.user.roles = ["HR_ADMIN"]),
      (f) => (f.ctx.user.userId = "8"),
      (f) => (f.ctx.user.tenantId = randomUUID()),
      (f) => (f.ctx.user.employeeId = 101),
      (f) => (f.ctx.user.isAdmin = true),
      (f) => (f.ctx.actorVerified = false),
      (f) => (f.ctx.system = true),
      (f) => f.ctx.permissions.push("hr.employee.read"),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  });
  it("accepts no tenant or arbitrary employee selector in input", async () => {
    const f = fixture();
    for (const input of [
      { entryId: f.entry.entryId, employeeId: 101 },
      { entryId: f.entry.entryId, tenantId: f.plan.tenantId },
      { entryId: "bad" },
    ])
      await denied(nativeVerificationEntryStatus(input, options(f)));
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it("denies missing plans and entries absent from the immutable plan", async () => {
    const f = fixture();
    await denied(
      nativeVerificationEntryStatus(
        { entryId: f.entry.entryId },
        { ...options(f), loadPlan: async () => null },
      ),
    );
    await denied(nativeVerificationEntryStatus({ entryId: randomUUID() }, options(f)));
  });
  it("denies missing, revoked, expired or drifted installed grants", async () => {
    const changes = [
      (f) => f.tx.nativeVerificationGrant.findFirst.mockResolvedValue(null),
      (f) => (f.grant.cancelledAt = f.now),
      (f) => (f.grant.expiresAt = f.now),
      (f) => (f.grant.fingerprint = "d".repeat(64)),
      (f) => (f.grant.operatorReceiptId = null),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
    }
  });
  it("rechecks the mounted plan after acquiring a potentially delayed grant lock", async () => {
    const f = fixture();
    const replacement = structuredClone(f.plan);
    replacement.approvalRef = "test:replaced";
    let loads = 0;
    await denied(
      nativeVerificationEntryStatus(
        { entryId: f.entry.entryId },
        { ...options(f), loadPlan: async () => (++loads === 1 ? f.plan : replacement) },
      ),
    );
  });
  it("rejects a grant that expires while waiting for the lock", async () => {
    const f = fixture();
    f.grant.expiresAt = new Date(f.now.getTime() + 10);
    f.tx.$queryRaw.mockImplementation(async () => {
      f.now = new Date(f.grant.expiresAt);
    });
    await denied(read(f));
  });
  it("denies missing, other-owner and deactivated entries", async () => {
    const changes = [
      (f) => f.tx.nativeVerificationEntry.findFirst.mockResolvedValue(null),
      (f) => (f.owned.actorUserId = 8),
      (f) => (f.owned.deactivatedAt = f.now),
      (f) => (f.owned.grantId = randomUUID()),
      (f) => (f.owned.entryId = randomUUID()),
      (f) => (f.owned.tenantId = randomUUID()),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
    }
  });
  it("explicitly checks the employee tenant and ID and requires the provisioning row", async () => {
    const changes = [
      (f) => f.tx.employee.findFirst.mockResolvedValue(null),
      (f) => (f.employee.tenant_id = randomUUID()),
      (f) => (f.employee.id = 102),
      (f) => f.tx.systemAccountProvisioning.findFirst.mockResolvedValue(null),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
    }
  });
  it("rejects drift in the durable business payload, key, identity or actor", async () => {
    const changes = [
      (f) => (f.intent.payload.email = "other@example.invalid"),
      (f) => (f.intent.idempotencyKey = randomUUID()),
      (f) => (f.intent.id = randomUUID()),
      (f) => (f.intent.actor.userId = "8"),
      (f) => (f.intent.payloadFingerprint = "f".repeat(64)),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
    }
  });
  it("registers a strict schema, read-only annotations and only the existing CREATE permission", async () => {
    const f = fixture(),
      result = await read(f),
      reader = jest.fn(async () => result);
    let config, handler;
    registerNativeVerificationTools(
      {
        registerTool: (name, c, h) => {
          expect(name).toBe("hr_native_verification_entry_status");
          config = c;
          handler = h;
        },
      },
      { statusReader: reader },
    );
    expect(
      config.inputSchema.safeParse({ entryId: f.entry.entryId, employeeId: 101 }).success,
    ).toBe(false);
    expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const response = await mcpCtx.run(f.ctx, () => handler({ entryId: f.entry.entryId }));
    expect(JSON.parse(response.content[0].text)).toEqual({ success: true, data: result });
    expect(reader).toHaveBeenCalledTimes(1);
    const refusal = await mcpCtx.run({ ...f.ctx, permissions: ["hr.employee.read"] }, () =>
      handler({ entryId: f.entry.entryId }),
    );
    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text)).toMatchObject({ code: "HR-0310", status: 403 });
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it("the tool boundary refuses extra result fields instead of leaking worker errors", async () => {
    const f = fixture(),
      result = await read(f);
    let handler;
    registerNativeVerificationTools(
      {
        registerTool: (_n, _c, h) => {
          handler = h;
        },
      },
      { statusReader: async () => ({ ...result, lastError: "PRIVATE" }) },
    );
    const response = await mcpCtx.run(f.ctx, () => handler({ entryId: f.entry.entryId }));
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("PRIVATE");
  });
});
