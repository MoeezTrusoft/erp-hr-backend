// tests/unit/talentPoolRetention.test.js
//
// Phase 10 (remainder) — TALENT_POOL retention wiring.
//
// The privacy model has always supported a second population (`appliesTo:
// 'TALENT_POOL'` beside `APPLICANT`), but nothing read it: the retention clock was
// stamped only on candidate creation, with the APPLICANT policy. A candidate kept
// on file for future roles therefore still counted down on the applicant clock —
// and the pool is a DIFFERENT lawful basis whose clock starts when the candidate
// enters it.
//
// These tests pin the wiring AND its two safety properties: no policy means no
// clock (never a guessed default), and a policy-lookup failure must not undo a pool
// entry that already exists.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
  talentPool: { create: jest.fn() },
  candidate: { updateMany: jest.fn() },
};

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), child: () => ({ warn: jest.fn() }) },
}));
const computeRetentionUntil = jest.fn();
jest.unstable_mockModule("../../src/services/candidatePrivacy.service.js", () => ({ computeRetentionUntil }));

const { addToPool } = await import("../../src/services/talentPool.service.js");

const TENANT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  jest.clearAllMocks();
  prisma.talentPool.create.mockResolvedValue({ id: 5, candidateId: 7, poolName: "Future roles" });
  prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
});

describe("Phase 10 — TALENT_POOL retention wiring", () => {
  it("stamps the clock from the TALENT_POOL policy, not the applicant one", async () => {
    const until = new Date("2028-09-20T00:00:00.000Z");
    computeRetentionUntil.mockResolvedValue(until);

    const result = await addToPool({ candidateId: 7, poolName: "Future roles", tenantId: TENANT });

    expect(computeRetentionUntil).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, appliesTo: "TALENT_POOL" }),
      expect.anything(),
    );
    expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
      // FR-10 residue — the population marker travels with the clock: the row has
      // to say WHICH basis is counting down, or a later sweep cannot tell whether
      // this candidate is a pool contact or a live applicant.
      expect.objectContaining({
        data: { retentionUntil: until, retentionPopulation: "TALENT_POOL" },
      }),
    );
    // The caller sees the clock the entry now carries.
    expect(result.retentionUntil).toBe(until);
  });

  it("leaves the clock alone when the tenant has NO pool policy — no policy, no clock", async () => {
    computeRetentionUntil.mockResolvedValue(null);

    const result = await addToPool({ candidateId: 7, poolName: "Future roles", tenantId: TENANT });

    expect(prisma.candidate.updateMany).not.toHaveBeenCalled();
    expect(result.retentionUntil).toBeUndefined();
    // The pool entry itself still exists — the clock is not a precondition.
    expect(prisma.talentPool.create).toHaveBeenCalled();
  });

  it("never fails the pool add because the clock could not be stamped", async () => {
    computeRetentionUntil.mockRejectedValue(new Error("policy read failed"));

    const result = await addToPool({ candidateId: 7, poolName: "Future roles", tenantId: TENANT });

    expect(result).toMatchObject({ id: 5, candidateId: 7 });
    expect(prisma.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("scopes the candidate write by tenant", async () => {
    computeRetentionUntil.mockResolvedValue(new Date("2028-01-01T00:00:00.000Z"));

    await addToPool({ candidateId: 7, poolName: "Future roles", tenantId: TENANT });

    expect(prisma.candidate.updateMany.mock.calls[0][0].where).toMatchObject({
      tenantId: TENANT,
      id: 7,
    });
  });
});
