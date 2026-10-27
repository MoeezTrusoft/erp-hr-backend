// tests/unit/offerAcceptance.service.test.js
//
// Phase 9 — offer response is a one-way transition: only a SENT offer can be
// answered, a repeat acceptance REPLAYS (never re-provisions), and acceptance
// moves the application to hired inside the same transaction.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const offerRow = {
  id: 9,
  status: "SENT",
  applicationId: 3,
  candidateId: 5,
  tenantId: "tenant-a",
  employeeCategory: "EMPLOYEE",
};

const mockRunOfferHandoff = jest.fn(async () => ({
  handoff: { id: 1, status: "COMPLETED" },
  replayed: false,
}));
const mockGetOfferHandoff = jest.fn(async () => ({
  id: 1,
  status: "COMPLETED",
  employeeId: 77,
}));
const mockTransition = jest.fn(async () => ({ success: true, changed: true }));

const prisma = {
  $queryRawUnsafe: jest.fn(async () => []),
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRaw: jest.fn(async () => [{ id: 9 }]),
  offer: { findFirst: jest.fn(), update: jest.fn(async () => offerRow) },
};

// offer.service now reaches the candidate PII service (privacy gate on send), so
// the canonical singleton and every export the mocked module graph needs must
// resolve to doubles — otherwise a real PrismaClient is constructed here.
jest.unstable_mockModule("../../src/config/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(prisma)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({
  uploadFileToDAM: jest.fn(),
  normalizeDamAssetResponse: jest.fn((x) => x),
  getDamAssetById: jest.fn(),
  downloadDamAssetBuffer: jest.fn(),
  deleteDamAsset: jest.fn(),
}));
jest.unstable_mockModule(
  "../../src/services/applicationWorkflow.service.js",
  () => ({
    transitionApplicationStageInTransaction: mockTransition,
    transitionApplicationStage: jest.fn(),
  }),
);
jest.unstable_mockModule(
  "../../src/services/recruitmentHandoff.service.js",
  () => ({
    runOfferHandoff: mockRunOfferHandoff,
    getOfferHandoff: mockGetOfferHandoff,
  }),
);

jest.unstable_mockModule(
  "../../src/services/candidatePrivacy.service.js",
  () => ({
    assertCommunicationsAllowed: jest.fn(async () => ({ allowed: true })),
    CONSENT_STATUS: {
      UNKNOWN: "UNKNOWN",
      GRANTED: "GRANTED",
      WITHDRAWN: "WITHDRAWN",
    },
  }),
);
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => true),
}));
jest.unstable_mockModule("../../src/services/offerLetter.service.js",()=>({createOfferLetter:jest.fn(),persistOfferPdf:jest.fn(),offerLetterAccess:jest.fn()}));
jest.unstable_mockModule("../../src/services/offerSignature.service.js",()=>({queueOfferSignature:jest.fn(),requireOfferSignature:jest.fn(async()=>null)}));
const { respondOffer } = await import("../../src/services/offer.service.js");

describe("Offer acceptance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow });
    prisma.offer.update.mockResolvedValue({ ...offerRow, status: "ACCEPTED" });
  });

  it("accepts a SENT offer, hires the application, and runs the handoff once", async () => {
    const result = await respondOffer(9, true, "tenant-a", { actorId: 12 });

    expect(result.replayed).toBe(false);
    expect(prisma.offer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACCEPTED" }),
      }),
    );
    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        targetStage: "hired",
        source: "offer-accept",
        actorId: 12,
      }),
      prisma,
    );
    expect(mockRunOfferHandoff).toHaveBeenCalledTimes(1);
  });

  it("replays a repeated acceptance without provisioning again", async () => {
    prisma.offer.findFirst.mockResolvedValue({
      ...offerRow,
      status: "ACCEPTED",
      employeeCategory: null,
    });

    const result = await respondOffer(9, true, "tenant-a");

    expect(result.replayed).toBe(true);
    expect(result.handoff.employeeId).toBe(77);
    expect(mockRunOfferHandoff).not.toHaveBeenCalled();
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("rejects a conflicting response on a finalized offer", async () => {
    prisma.offer.findFirst.mockResolvedValue({
      ...offerRow,
      status: "ACCEPTED",
    });

    await expect(respondOffer(9, false, "tenant-a")).rejects.toMatchObject({
      code: "HR-RECRUITMENT-OFFER-FINALIZED",
    });
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("refuses a response to an offer that was never sent", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, status: "DRAFT" });

    await expect(respondOffer(9, true, "tenant-a")).rejects.toMatchObject({
      code: "HR-RECRUITMENT-OFFER-NOT-SENT",
    });
    expect(mockRunOfferHandoff).not.toHaveBeenCalled();
  });

  it("declines a SENT offer without provisioning", async () => {
    prisma.offer.update.mockResolvedValue({ ...offerRow, status: "DECLINED" });

    const result = await respondOffer(9, false, "tenant-a");

    expect(result.handoff).toBeNull();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockRunOfferHandoff).not.toHaveBeenCalled();
  });
});
