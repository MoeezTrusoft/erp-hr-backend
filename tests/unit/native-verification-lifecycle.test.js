import { describe, it, expect, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { nativeFixture } from "../fixtures/native-verification.js";
import { nativeDigest, nativeProvisioningKey } from "../../src/lib/native-verification-plan.js";
import { nativeVerificationEntryLifecycle } from "../../src/services/native-verification-lifecycle.service.js";
import { registerNativeLifecycleTools } from "../../src/mcp/tools/native-lifecycle-tools.js";
import {
  buildEmployeeLifecyclePayload,
  buildEmployeeLifecycleEnvelope,
  deterministicUuid,
} from "../../src/services/employeeOutbox.service.js";
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
  const payloadEvent = buildEmployeeLifecyclePayload({
    tenantId: plan.tenantId,
    employeeId: deterministicUuid("hr:employee:" + plan.tenantId + ":101"),
    employeeNumber: "FICT-101",
    name: { given: "Fictional", family: "Native" },
    orgUnitId: randomUUID(),
    phase: "hired",
    effectiveOn: "2026-10-23",
    workEmail: "private-person@example.invalid",
  });
  const envelope = buildEmployeeLifecycleEnvelope({
    payload: payloadEvent,
    tenantId: plan.tenantId,
    actorId: plan.bootstrap.userId,
    occurredAt: f.now.toISOString(),
  });
  const outbox = {
    id: randomUUID(),
    tenantId: plan.tenantId,
    eventName: "hr.employee.lifecycle.v1",
    aggregateType: "Employee",
    aggregateId: "101",
    payload: envelope,
    publishedAt: null,
    attempts: 0,
    lastError: "PRIVATE_OUTBOX_ERROR",
  };
  const tx = {
    outboxEvent: { findMany: jest.fn(async () => [outbox]) },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    nativeVerificationGrant: { findFirst: jest.fn(async () => grant) },
    nativeVerificationEntry: { findFirst: jest.fn(async () => owned) },
    systemAccountProvisioning: { findFirst: jest.fn(async () => intent) },
    employee: { findFirst: jest.fn(async () => employee) },
  };
  const db = { $transaction: jest.fn(async (fn) => fn(tx)) };
  return { ...f, intent, owned, grant, employee, tx, db, outbox, envelope };
}
const options = (f) => ({ ctx: f.ctx, loadPlan: async () => f.plan, now: () => f.now, db: f.db });
const read = (f) => nativeVerificationEntryLifecycle({ entryId: f.entry.entryId }, options(f));
const denied = (promise) =>
  expect(promise).rejects.toMatchObject({
    code: "HR-0310",
    status: 403,
    message: "HR-0310: native verification authorization is unavailable",
  });
describe("native owned lifecycle observation", () => {
  it("rejects a mounted plan replaced during the evidence read", async () => {
    const f = fixture(),
      replacement = structuredClone(f.plan);
    replacement.approvalRef = "test:replaced-after-evidence";
    let reads = 0;
    await denied(
      nativeVerificationEntryLifecycle(
        { entryId: f.entry.entryId },
        { ...options(f), loadPlan: async () => (++reads < 3 ? f.plan : replacement) },
      ),
    );
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
      await denied(nativeVerificationEntryLifecycle(input, options(f)));
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it("denies missing plans and entries absent from the immutable plan", async () => {
    const f = fixture();
    await denied(
      nativeVerificationEntryLifecycle(
        { entryId: f.entry.entryId },
        { ...options(f), loadPlan: async () => null },
      ),
    );
    await denied(nativeVerificationEntryLifecycle({ entryId: randomUUID() }, options(f)));
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
      nativeVerificationEntryLifecycle(
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

  it("returns precisely persisted event and dispatch evidence without raw payload or mutation", async () => {
    const f = fixture(),
      before = structuredClone({
        outbox: f.outbox,
        owned: f.owned,
        intent: f.intent,
        grant: f.grant,
      });
    const result = await read(f);
    expect(Object.keys(result).sort()).toEqual(
      [
        "grantId",
        "entryId",
        "tenantId",
        "employeeId",
        "employeeUuid",
        "eventId",
        "outboxId",
        "eventName",
        "phase",
        "publishedAt",
        "dispatchAttempts",
      ].sort(),
    );
    expect(result).toMatchObject({
      eventId: f.envelope.id,
      outboxId: f.outbox.id,
      employeeUuid: f.envelope.payload.employeeId,
      publishedAt: null,
      dispatchAttempts: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-person|PRIVATE_|lastError|workEmail|name":/,
    );
    expect({ outbox: f.outbox, owned: f.owned, intent: f.intent, grant: f.grant }).toEqual(before);
    expect(f.tx.outboxEvent.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: f.plan.tenantId,
        eventName: "hr.employee.lifecycle.v1",
        aggregateType: "Employee",
        aggregateId: "101",
        payload: { path: ["payload", "phase"], equals: "hired" },
      },
      select: {
        id: true,
        tenantId: true,
        eventName: true,
        aggregateType: true,
        aggregateId: true,
        payload: true,
        publishedAt: true,
        attempts: true,
      },
      orderBy: { id: "asc" },
      take: 2,
    });
  });
  it("validates actual outbox and envelope IDs separately without an inequality requirement", async () => {
    const f = fixture();
    f.outbox.id = f.envelope.id;
    expect(await read(f)).toMatchObject({ outboxId: f.envelope.id, eventId: f.envelope.id });
  });
  it("fails generically for absent or ambiguous hired events", async () => {
    for (const count of [0, 2]) {
      const f = fixture();
      f.tx.outboxEvent.findMany.mockResolvedValue(
        count === 0 ? [] : [f.outbox, structuredClone(f.outbox)],
      );
      await denied(read(f));
    }
  });
  it("validates every row, outer envelope and inner lifecycle identity", async () => {
    const changes = [
      (f) => (f.outbox.tenantId = randomUUID()),
      (f) => (f.outbox.aggregateType = "Other"),
      (f) => (f.outbox.aggregateId = "102"),
      (f) => (f.outbox.eventName = "other.event.v1"),
      (f) => (f.envelope.tenantId = randomUUID()),
      (f) => (f.envelope.name = "other.event.v1"),
      (f) => (f.envelope.version = 2),
      (f) => (f.envelope.payload.tenantId = randomUUID()),
      (f) => (f.envelope.payload.employeeId = randomUUID()),
      (f) => (f.envelope.payload.phase = "terminated"),
      (f) => (f.envelope.id = "bad-id"),
      (f) => (f.outbox.id = "bad-id"),
      (f) => (f.envelope.payload.employeeId = "101"),
      (f) => (f.outbox.payload = null),
      (f) => (f.envelope.payload.unexpected = "PRIVATE"),
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await denied(read(f));
    }
  });
  it("returns actual persisted publication evidence only with a positive dispatch attempt", async () => {
    const f = fixture();
    f.outbox.publishedAt = f.now;
    f.outbox.attempts = 3;
    expect(await read(f)).toMatchObject({ publishedAt: f.now.toISOString(), dispatchAttempts: 3 });
    f.outbox.publishedAt = null;
    expect(await read(f)).toMatchObject({ publishedAt: null, dispatchAttempts: 3 });
  });
  it("rejects invalid attempt counts or publication timestamps", async () => {
    for (const attempts of [-1, 0.1, "1", null, 2147483648]) {
      const f = fixture();
      f.outbox.attempts = attempts;
      await denied(read(f));
    }
    for (const publishedAt of [undefined, "2026-10-23T00:00:00Z", new Date("bad")]) {
      const f = fixture();
      f.outbox.publishedAt = publishedAt;
      await denied(read(f));
    }
    const f = fixture();
    f.outbox.publishedAt = f.now;
    f.outbox.attempts = 0;
    await denied(read(f));
  });
  it("rechecks expiry after awaited outbox reads", async () => {
    const f = fixture();
    f.tx.outboxEvent.findMany.mockImplementation(async () => {
      f.now = new Date(f.plan.expiresAt);
      return [f.outbox];
    });
    await denied(read(f));
  });
  it("registers the strict read-only CREATE tool and preserves a minimal success envelope", async () => {
    const f = fixture(),
      result = await read(f),
      reader = jest.fn(async () => result);
    let config, handler;
    registerNativeLifecycleTools(
      {
        registerTool: (name, c, h) => {
          expect(name).toBe("hr_native_verification_entry_lifecycle");
          config = c;
          handler = h;
        },
      },
      { lifecycleReader: reader },
    );
    expect(
      config.inputSchema.safeParse({ entryId: f.entry.entryId, tenantId: f.plan.tenantId }).success,
    ).toBe(false);
    expect(config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const response = await mcpCtx.run(f.ctx, () => handler({ entryId: f.entry.entryId }));
    expect(response.structuredContent).toEqual({ success: true, data: result });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
    const refusal = await mcpCtx.run({ ...f.ctx, permissions: ["hr.employee.read"] }, () =>
      handler({ entryId: f.entry.entryId }),
    );
    expect(JSON.parse(refusal.content[0].text)).toMatchObject({ code: "HR-0310", status: 403 });
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it("refuses additional output fields before any raw event data can escape", async () => {
    const f = fixture(),
      result = await read(f);
    let handler;
    registerNativeLifecycleTools(
      {
        registerTool: (_n, _c, h) => {
          handler = h;
        },
      },
      { lifecycleReader: async () => ({ ...result, payload: { private: "PRIVATE_EVENT" } }) },
    );
    const response = await mcpCtx.run(f.ctx, () => handler({ entryId: f.entry.entryId }));
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("PRIVATE_EVENT");
  });
});
