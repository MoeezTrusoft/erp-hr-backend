// tests/unit/talentPoolInvitation.service.test.js
//
// FR-10 residue — the invitation LIFECYCLE, the SEGMENTATION wiring and the pool
// RETENTION SWEEP:
//
//   * inviting twice while an invitation is open returns the SAME row (a retry is
//     not a second invitation)
//   * an answered invitation cannot be answered again
//   * an invitation past its expiry is reported as expired before the sweep runs,
//     and the sweep dry-runs unless apply is asked for AND the flag is on
//   * the pool sweep REMOVES MEMBERSHIPS and never erases a candidate — the
//     distinction the APPLICANT sweep's popualtion marker exists to protect
//   * legal holds suspend the sweep rather than being swept through
import { jest } from "@jest/globals";

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/lib/recruitment-ops-metrics.util.js", () => ({ recordRetentionRun: jest.fn() }));
jest.unstable_mockModule("../../src/lib/recruitment-flags.util.js", () => ({
  isRecruitmentFlagEnabled: jest.fn(() => true),
}));

const {
  expireInvitations,
  inviteToApply,
  listInvitations,
  respondToInvitation,
  segmentTalentPool,
  sweepTalentPoolRetention,
  withdrawInvitation,
} = await import("../../src/services/talent-pool-invitation.service.js");
const { isRecruitmentFlagEnabled } = await import("../../src/lib/recruitment-flags.util.js");
const { recordRetentionRun } = await import("../../src/lib/recruitment-ops-metrics.util.js");

const TENANT = "tenant-a";

const invitation = (over = {}) => ({
  id: 1,
  tenantId: TENANT,
  candidateId: 9,
  jobRequisitionId: 4,
  status: "INVITED",
  invitedAt: new Date("2026-01-01T00:00:00.000Z"),
  expiresAt: new Date("2026-01-31T00:00:00.000Z"),
  respondedAt: null,
  responseNote: null,
  ...over,
});

const db = (over = {}) => ({
  candidate: {
    findFirst: jest.fn().mockResolvedValue({ id: 9, anonymizedAt: null }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  talentPoolInvitation: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(async ({ data }) => invitation({ ...data, id: 77 })),
    update: jest.fn(async ({ data }) => invitation(data)),
  },
  talentPool: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  candidateLegalHold: { findMany: jest.fn().mockResolvedValue([]) },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  isRecruitmentFlagEnabled.mockReturnValue(true);
});

describe("inviteToApply", () => {
  it("opens an invitation with an expiry derived from the validity window", async () => {
    const client = db();
    const result = await inviteToApply({ tenantId: TENANT, candidateId: 9, jobRequisitionId: 4, db: client });
    expect(result.reused).toBe(false);
    const data = client.talentPoolInvitation.create.mock.calls[0][0].data;
    expect(data.status).toBe("INVITED");
    expect(data.expiresAt.getTime()).toBeGreaterThan(data.invitedAt.getTime());
    expect(data.tenantId).toBe(TENANT);
  });

  it("returns the LIVE invitation instead of opening a second one", async () => {
    const client = db();
    client.talentPoolInvitation.findFirst.mockResolvedValue(
      invitation({ expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    const result = await inviteToApply({ tenantId: TENANT, candidateId: 9, jobRequisitionId: 4, db: client });
    expect(result.reused).toBe(true);
    expect(result.invitation.id).toBe(1);
    expect(client.talentPoolInvitation.create).not.toHaveBeenCalled();
  });

  it("opens a NEW invitation when the previous one has lapsed", async () => {
    const client = db();
    client.talentPoolInvitation.findFirst.mockResolvedValue(
      invitation({ expiresAt: new Date(Date.now() - 86_400_000) }),
    );
    const result = await inviteToApply({ tenantId: TENANT, candidateId: 9, db: client });
    expect(result.reused).toBe(false);
    expect(client.talentPoolInvitation.create).toHaveBeenCalledTimes(1);
  });

  it("refuses to invite an anonymized candidate (the erasure would be undone)", async () => {
    const client = db();
    client.candidate.findFirst.mockResolvedValue({ id: 9, anonymizedAt: new Date() });
    await expect(inviteToApply({ tenantId: TENANT, candidateId: 9, db: client })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-INVITATION-CANDIDATE-ANONYMIZED",
    });
    expect(client.talentPoolInvitation.create).not.toHaveBeenCalled();
  });

  it("requires tenant context", async () => {
    await expect(inviteToApply({ candidateId: 9, db: db() })).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });
});

describe("answering an invitation", () => {
  it("records the answer with its timestamp", async () => {
    const client = db();
    client.talentPoolInvitation.findFirst.mockResolvedValue(invitation());
    const result = await respondToInvitation({
      tenantId: TENANT,
      invitationId: 1,
      response: "accept",
      note: "Happy to talk",
      db: client,
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.respondedAt).toBeInstanceOf(Date);
    expect(result.responseNote).toBe("Happy to talk");
  });

  it("REFUSES to re-answer an already answered invitation", async () => {
    const client = db();
    client.talentPoolInvitation.findFirst.mockResolvedValue(invitation({ status: "DECLINED" }));
    await expect(respondToInvitation({ tenantId: TENANT, invitationId: 1, response: "ACCEPTED", db: client }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-INVITATION-TRANSITION-INVALID" });
  });

  it("withdraws an open invitation with the recruiter's reason", async () => {
    const client = db();
    client.talentPoolInvitation.findFirst.mockResolvedValue(invitation());
    const result = await withdrawInvitation({ tenantId: TENANT, invitationId: 1, reason: "Role closed", db: client });
    expect(result.status).toBe("WITHDRAWN");
    expect(result.responseNote).toBe("Role closed");
  });

  it("404s an invitation outside the tenant", async () => {
    const client = db();
    await expect(respondToInvitation({ tenantId: TENANT, invitationId: 1, response: "ACCEPTED", db: client }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("listing and expiry", () => {
  it("reports a lapsed INVITED row as expired before the sweep stamps it", async () => {
    const client = db();
    client.talentPoolInvitation.findMany.mockResolvedValue([
      invitation({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
      invitation({ id: 2, expiresAt: new Date("2099-01-01T00:00:00.000Z") }),
    ]);
    const result = await listInvitations({ tenantId: TENANT, db: client });
    expect(result.items[0].expired).toBe(true);
    expect(result.items[1].expired).toBe(false);
  });

  it("dry-runs the expiry sweep by default", async () => {
    const client = db();
    client.talentPoolInvitation.findMany.mockResolvedValue([
      invitation({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    ]);
    const result = await expireInvitations({ tenantId: TENANT, db: client });
    expect(result.dryRun).toBe(true);
    expect(result.wouldExpire).toEqual([1]);
    expect(client.talentPoolInvitation.update).not.toHaveBeenCalled();
  });

  it("expires only the rows past their expiry when applied", async () => {
    const client = db();
    client.talentPoolInvitation.findMany.mockResolvedValue([
      invitation({ id: 1, expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
      invitation({ id: 2, expiresAt: new Date("2099-01-01T00:00:00.000Z") }),
    ]);
    // The transition re-reads the row through the tenant scope (the one-way map is
    // enforced against the STORED status, not the caller's copy).
    client.talentPoolInvitation.findFirst.mockResolvedValue(
      invitation({ id: 1, expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    const result = await expireInvitations({ tenantId: TENANT, dryRun: false, db: client });
    expect(result.expired).toEqual([1]);
    expect(client.talentPoolInvitation.update).toHaveBeenCalledTimes(1);
  });
});

describe("segmentTalentPool", () => {
  const membership = (candidate) => ({ id: 1, candidateId: candidate.id, poolName: "Engineering", candidate });

  it("refuses an unknown filter key rather than returning everyone", async () => {
    await expect(segmentTalentPool({ tenantId: TENANT, filters: { skils: ["node"] }, db: db() }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-SEGMENT-KEY-INVALID" });
  });

  it("matches a pool candidate and reports the count", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([
      membership({
        id: 9,
        firstName: "Ada",
        lastName: "Lovelace",
        location: "Lahore",
        source: "Referral",
        anonymizedAt: null,
        parsedResume: { totalExperienceYears: 8 },
        candidateSkills: [{ name: "Node.js" }],
      }),
    ]);
    const result = await segmentTalentPool({ tenantId: TENANT, filters: { skills: ["Node.js"] }, db: client });
    expect(result.counts.matched).toBe(1);
    expect(result.matched[0]).toMatchObject({ candidateId: 9, experienceYears: 8, pools: ["Engineering"] });
  });

  it("attributes an exclusion to the filter that caused it", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([
      membership({
        id: 9,
        firstName: "Ada",
        lastName: "Lovelace",
        location: "Lahore",
        source: "Referral",
        anonymizedAt: null,
        parsedResume: { totalExperienceYears: 2 },
        candidateSkills: [{ name: "Go" }],
      }),
    ]);
    const result = await segmentTalentPool({ tenantId: TENANT, filters: { skills: ["Node.js"] }, db: client });
    expect(result.counts.matched).toBe(0);
    expect(result.excludedByReason).toEqual({ skills: 1 });
  });

  it("never segments an anonymized candidate (a tombstone is not a person)", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([
      membership({
        id: 9,
        firstName: null,
        lastName: null,
        location: null,
        source: null,
        anonymizedAt: new Date(),
        parsedResume: null,
        candidateSkills: [],
      }),
    ]);
    const result = await segmentTalentPool({ tenantId: TENANT, filters: {}, db: client });
    expect(result.matched).toEqual([]);
    expect(result.excludedByReason).toEqual({ anonymized: 1 });
  });
});

describe("sweepTalentPoolRetention", () => {
  const pooled = (over = {}) => ({
    id: 5,
    candidateId: 9,
    poolName: "Engineering",
    candidate: {
      id: 9,
      retentionUntil: new Date("2020-01-01T00:00:00.000Z"),
      retentionPopulation: "TALENT_POOL",
      anonymizedAt: null,
      ...(over.candidate || {}),
    },
    ...over,
  });

  it("dry-runs by default and states that it does NOT erase candidates", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([pooled()]);
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, db: client });
    expect(result.dryRun).toBe(true);
    expect(result.wouldRemoveMemberships).toEqual([5]);
    expect(result.candidateErasure).toMatch(/not performed/);
    expect(client.talentPool.deleteMany).not.toHaveBeenCalled();
    expect(recordRetentionRun).toHaveBeenCalledWith("dry-run");
  });

  it("ignores an APPLICANT clock — that population is erased, not un-pooled", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([
      pooled({ candidate: { retentionPopulation: "APPLICANT" } }),
      // NULL is a pre-existing clock (APPLICANT policy) — never the pool's.
      pooled({ id: 6, candidate: { retentionPopulation: null } }),
    ]);
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, db: client });
    expect(result.wouldRemoveMemberships).toEqual([]);
  });

  it("ignores a clock that has not closed", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([
      pooled({ candidate: { retentionUntil: new Date("2099-01-01T00:00:00.000Z") } }),
    ]);
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, db: client });
    expect(result.wouldRemoveMemberships).toEqual([]);
  });

  it("suspends a held candidate instead of sweeping through the hold", async () => {
    const client = db();
    client.talentPool.findMany.mockResolvedValue([pooled()]);
    client.candidateLegalHold.findMany.mockResolvedValue([{ candidateId: 9 }]);
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, db: client });
    expect(result.wouldRemoveMemberships).toEqual([]);
    expect(result.suspendedByLegalHold).toEqual([{ membershipId: 5, candidateId: 9 }]);
  });

  it("refuses APPLY while the retention flag is off", async () => {
    isRecruitmentFlagEnabled.mockReturnValue(false);
    const client = db();
    client.talentPool.findMany.mockResolvedValue([pooled()]);
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, dryRun: false, db: client });
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("flag-disabled");
    expect(client.talentPool.deleteMany).not.toHaveBeenCalled();
    expect(recordRetentionRun).toHaveBeenCalledWith("refused-flag");
  });

  it("removes the memberships and clears the pool clock when applied", async () => {
    const client = db();
    client.talentPool.findMany
      .mockResolvedValueOnce([pooled()])
      .mockResolvedValueOnce([]); // no pool memberships left for that candidate
    const result = await sweepTalentPoolRetention({ tenantId: TENANT, dryRun: false, db: client });
    expect(result.removedMemberships).toEqual([5]);
    expect(client.talentPool.deleteMany).toHaveBeenCalled();
    // The clock belonged to the pool basis; with the memberships gone, it must not
    // keep counting down and re-reporting a population that no longer exists.
    expect(client.candidate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: { in: [9] } },
      data: { retentionUntil: null, retentionPopulation: null },
    });
    expect(recordRetentionRun).toHaveBeenCalledWith("applied");
  });

  it("keeps the clock for a candidate still in another pool", async () => {
    const client = db();
    client.talentPool.findMany
      .mockResolvedValueOnce([pooled()])
      .mockResolvedValueOnce([{ candidateId: 9 }]);
    await sweepTalentPoolRetention({ tenantId: TENANT, dryRun: false, db: client });
    expect(client.candidate.updateMany).not.toHaveBeenCalled();
  });
});
