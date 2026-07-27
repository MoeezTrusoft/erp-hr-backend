// F-03 / ARCH-00 P-04/P-07/P-12 / ARCH-01 §3.5, §7-§9
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const {
  runSystemAccountProvisioningBatch,
  retrySystemAccountProvisioning,
  publicProvisioningState,
} = await import("../../../src/jobs/system-account-provisioning.js");

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const NOW = new Date("2026-07-26T12:00:00.000Z");

const row = (overrides = {}) => ({
  id: "intent-1",
  tenantId: TENANT,
  employeeId: 101,
  status: "PENDING",
  idempotencyKey: "7406c980-4ca2-5c54-9071-36f33c4b35f8",
  payloadFingerprint: "a".repeat(64),
  payload: {
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@corp.example",
    roles: [{ roleId: 7 }],
    hrEmployeeId: 101,
  },
  actor: {
    userId: "42",
    employeeId: "9",
    roles: ["hr_admin"],
    permissions: ["rbac.employee.create"],
  },
  correlationId: "corr-f03",
  attempts: 0,
  maxAttempts: 5,
  nextAttemptAt: NOW,
  claimedAt: null,
  claimedBy: null,
  claimExpiresAt: null,
  rbacUserId: null,
  result: null,
  lastError: null,
  manualRetryCount: 0,
  ...overrides,
});

function harness(candidate = row()) {
  let current = { ...candidate };
  const model = {
    findMany: jest.fn(async () => [current]),
    updateMany: jest.fn(async ({ where, data }) => {
      if (where.claimedBy && current.claimedBy !== where.claimedBy) return { count: 0 };
      if (where.status && typeof where.status === "string" && current.status !== where.status) return { count: 0 };
      current = { ...current, ...data };
      return { count: 1 };
    }),
    findFirst: jest.fn(async ({ where }) =>
      current.id === where.id && current.tenantId === where.tenantId ? current : null),
    update: jest.fn(async ({ data }) => {
      current = { ...current, ...data };
      return current;
    }),
  };
  return { prisma: { systemAccountProvisioning: model }, model, current: () => current };
}

describe("F-03 provisioning worker", () => {
  beforeEach(() => jest.clearAllMocks());

  it("claims under a lease and calls RBAC with stable idempotency metadata, without retaining password", async () => {
    const h = harness();
    const provision = jest.fn(async (payload, _headers, options) => {
      expect(payload.password).toEqual(expect.any(String));
      expect(options).toEqual({
        idempotencyKey: row().idempotencyKey,
        payloadFingerprint: row().payloadFingerprint,
      });
      return { ok: true, user: { id: 9001, email: "ada@corp.example" } };
    });

    const counts = await runSystemAccountProvisioningBatch({
      prisma: h.prisma,
      provision,
      workerId: "worker-a",
      now: () => NOW,
      randomBytesFn: () => Buffer.from("0123456789abcdef"),
    });

    expect(counts).toEqual(expect.objectContaining({ claimed: 1, succeeded: 1, failed: 0 }));
    expect(h.current()).toMatchObject({ status: "SUCCEEDED", rbacUserId: "9001", attempts: 1 });
    expect(JSON.stringify(h.current())).not.toContain("MDEyMzQ1Njc4OWFiY2RlZg");
    expect(h.current().result).toEqual({ userId: "9001" });
  });

  it("does not call RBAC when the conditional lease claim loses the race", async () => {
    const h = harness();
    h.model.updateMany.mockResolvedValueOnce({ count: 0 });
    const provision = jest.fn();

    const counts = await runSystemAccountProvisioningBatch({
      prisma: h.prisma, provision, workerId: "worker-b", now: () => NOW,
    });

    expect(provision).not.toHaveBeenCalled();
    expect(counts.claimRaceLost).toBe(1);
  });

  it("backs off transient failures and becomes terminal at the bounded attempt limit", async () => {
    const h = harness(row({ attempts: 4, maxAttempts: 5 }));
    const provision = jest.fn(async () => ({ ok: false, status: 503, error: "RBAC unavailable" }));

    await runSystemAccountProvisioningBatch({
      prisma: h.prisma, provision, workerId: "worker-c", now: () => NOW,
      jitterFn: () => 0,
    });

    expect(h.current()).toMatchObject({
      status: "TERMINAL_FAILED",
      attempts: 5,
      lastError: "RBAC unavailable",
      lastHttpStatus: 503,
    });
    expect(h.current().nextAttemptAt).toBeNull();
  });

  it("schedules exponential retry for a transient failure before the attempt limit", async () => {
    const h = harness(row({ attempts: 1, maxAttempts: 5 }));
    await runSystemAccountProvisioningBatch({
      prisma: h.prisma,
      provision: async () => ({ ok: false, status: 503, error: "RBAC unavailable" }),
      workerId: "worker-retry",
      now: () => NOW,
      jitterFn: () => 0,
    });
    expect(h.current()).toMatchObject({ status: "RETRY_WAIT", attempts: 2 });
    expect(h.current().nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it("marks permanent 4xx failures terminal immediately", async () => {
    const h = harness();
    await runSystemAccountProvisioningBatch({
      prisma: h.prisma,
      provision: async () => ({ ok: false, status: 403, code: "RBAC-403", error: "Forbidden" }),
      workerId: "worker-d",
      now: () => NOW,
    });
    expect(h.current()).toMatchObject({
      status: "TERMINAL_FAILED",
      attempts: 1,
      lastErrorCode: "RBAC-403",
    });
  });

  it("manual retry is tenant-scoped and preserves the original idempotency key", async () => {
    const h = harness(row({ status: "TERMINAL_FAILED", attempts: 5, nextAttemptAt: null }));
    const retried = await retrySystemAccountProvisioning("intent-1", TENANT, {
      prisma: h.prisma, now: () => NOW,
    });
    expect(retried.status).toBe("pending");
    expect(h.current()).toMatchObject({
      status: "PENDING",
      attempts: 0,
      idempotencyKey: row().idempotencyKey,
    });
    expect(h.model.findFirst).toHaveBeenCalledWith({ where: { id: "intent-1", tenantId: TENANT } });
  });

  it("maps internal states to honest public states without exposing payload or actor", () => {
    expect(publicProvisioningState(row({ status: "RETRY_WAIT", attempts: 2, lastError: "timeout" }))).toEqual({
      provisioningId: "intent-1",
      status: "retrying",
      attempts: 2,
      nextAttemptAt: NOW,
      error: "timeout",
    });
  });
});
