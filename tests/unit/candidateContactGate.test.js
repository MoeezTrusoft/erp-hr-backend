// tests/unit/candidateContactGate.test.js
//
// D-11 — the do-not-contact register and withdrawn consent were enforced only
// on offer send. Interview invitations and talent-pool invitations are also
// recruiter-initiated contact, so both now pass the same gate, inside the
// write transaction, and a refusal leaves nothing behind.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const tx = {
  leaveRequest: { findMany: jest.fn(async () => []) },
  interview: { create: jest.fn(async ({ data }) => ({ id: 70, ...data, interviewers: [] })) },
  application: { findFirst: jest.fn(async () => ({ id: 3, stage: "interview", candidateId: 5 })) },
  candidate: { findFirst: jest.fn(async () => ({ id: 5, anonymizedAt: null })) },
  talentPoolInvitation: { findFirst: jest.fn(async () => null), create: jest.fn(async ({ data }) => ({ id: 80, ...data })) },
};
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
const blocked = () => Object.assign(new Error("blocked"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" });

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: tx }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: tx }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(tx)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed }));

const { scheduleInterview } = await import("../../src/services/interview.service.js");
const { inviteToApply } = await import("../../src/services/talentPoolInvitation.service.js");

beforeEach(() => {
  jest.clearAllMocks();
  assertCommunicationsAllowed.mockResolvedValue({ allowed: true });
});

describe("interview scheduling passes the contact gate", () => {
  const schedule = () =>
    scheduleInterview({ applicationId: 3, scheduledAt: "2026-11-02T09:00:00Z", tenantId: TENANT });

  it("checks the application's candidate for PROCESSING contact inside the transaction", async () => {
    await schedule();
    expect(assertCommunicationsAllowed).toHaveBeenCalledWith(
      { tenantId: TENANT, candidateId: 5, purpose: "PROCESSING" },
      { db: tx },
    );
  });

  it("refuses to schedule a do-not-contact candidate", async () => {
    assertCommunicationsAllowed.mockRejectedValue(blocked());
    await expect(schedule()).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
  });
});

describe("talent-pool invitations pass the contact gate", () => {
  it("checks TALENT_POOL contact before creating the invitation", async () => {
    await inviteToApply({ tenantId: TENANT, candidateId: 5, jobRequisitionId: 4, db: tx });
    expect(assertCommunicationsAllowed).toHaveBeenCalledWith(
      { tenantId: TENANT, candidateId: 5, purpose: "TALENT_POOL" },
      { db: tx },
    );
    expect(tx.talentPoolInvitation.create).toHaveBeenCalled();
  });

  it("refuses to invite a do-not-contact candidate and creates nothing", async () => {
    assertCommunicationsAllowed.mockRejectedValue(blocked());
    await expect(inviteToApply({ tenantId: TENANT, candidateId: 5, db: tx }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
    expect(tx.talentPoolInvitation.create).not.toHaveBeenCalled();
  });
});
