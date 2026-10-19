// tests/unit/offerSendPrivacy.test.js
//
// Phase 10 — sending an offer IS candidate-facing contact, so the privacy gate
// has to sit on that path, not merely exist as a service. A fully approved offer
// must still be refused when the candidate has asked not to be contacted.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// A DRAFT offer whose HR Approval Centre request is APPROVED (consumed on send).
const OFFER = { id: 9, status: "DRAFT", candidateId: 5, tenantId: "tenant-a" };

const prisma = { offer: { findFirst: jest.fn(async () => OFFER), update: jest.fn(async () => ({ ...OFFER, status: "SENT" })) } };
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(prisma)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({ uploadFileToDAM: jest.fn() }));

const consumeApproval = jest.fn(async () => ({ id: "approval-1", stage: "APPROVED" }));
jest.unstable_mockModule("../../src/services/approval/adapters.js", () => ({ consumeApproval }));

const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
jest.unstable_mockModule("../../src/services/candidatePrivacy.service.js", () => ({
  assertCommunicationsAllowed,
  CONSENT_STATUS: { UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", WITHDRAWN: "WITHDRAWN" },
}));

jest.unstable_mockModule("../../src/services/recruitmentHandoff.service.js", () => ({
  runOfferHandoff: jest.fn(),
  getOfferHandoff: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/applicationWorkflow.service.js", () => ({
  transitionApplicationStageInTransaction: jest.fn(),
  transitionApplicationStage: jest.fn(),
}));

const { sendOffer } = await import("../../src/services/offer.service.js");

describe("offer send respects the privacy gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findFirst.mockResolvedValue(OFFER);
    consumeApproval.mockResolvedValue({ id: "approval-1", stage: "APPROVED" });
    assertCommunicationsAllowed.mockResolvedValue({ allowed: true });
  });

  it("sends when the candidate is contactable", async () => {
    const row = await sendOffer(9, "tenant-a");

    expect(row.status).toBe("SENT");
    expect(assertCommunicationsAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", candidateId: 5, purpose: "PROCESSING" }),
    );
    expect(prisma.offer.update).toHaveBeenCalled();
    // The send consumed the HR Approval Centre approval for this exact offer.
    expect(consumeApproval).toHaveBeenCalledWith(prisma, "tenant-a", "OFFER", "9");
  });

  it("refuses to send without a completed HR Approval Centre approval", async () => {
    consumeApproval.mockRejectedValue(
      Object.assign(new Error("Complete the employee, manager, HR and Management approval workflow"), { status: 400 }),
    );

    await expect(sendOffer(9, "tenant-a")).rejects.toThrow(/approval workflow/);
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("refuses to send an offer that is no longer a DRAFT", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...OFFER, status: "SENT" });

    await expect(sendOffer(9, "tenant-a")).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-STATUS" });
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("refuses to send to a do-not-contact candidate", async () => {
    assertCommunicationsAllowed.mockRejectedValue(
      Object.assign(new Error("blocked"), { code: "HR-RECRUITMENT-DNC-BLOCKED" }),
    );

    await expect(sendOffer(9, "tenant-a")).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
    // The offer must not have been flipped to SENT.
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("refuses to send when processing consent was withdrawn", async () => {
    assertCommunicationsAllowed.mockRejectedValue(
      Object.assign(new Error("withdrawn"), { code: "HR-RECRUITMENT-CONSENT-WITHDRAWN" }),
    );

    await expect(sendOffer(9, "tenant-a")).rejects.toMatchObject({ code: "HR-RECRUITMENT-CONSENT-WITHDRAWN" });
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("re-checks inside the transaction so a concurrent DNC cannot be raced", async () => {
    // First call (pre-check) passes, the in-transaction check blocks.
    assertCommunicationsAllowed
      .mockResolvedValueOnce({ allowed: true })
      .mockRejectedValueOnce(Object.assign(new Error("blocked"), { code: "HR-RECRUITMENT-DNC-BLOCKED" }));

    await expect(sendOffer(9, "tenant-a")).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
    expect(assertCommunicationsAllowed).toHaveBeenCalledTimes(2);
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });
});
