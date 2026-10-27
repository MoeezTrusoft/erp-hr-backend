// tests/unit/offerAcceptance.service.test.js
//
// Phase 9 — offer response is a one-way transition: only a SENT offer can be
// answered, a repeat acceptance REPLAYS (never re-provisions), and acceptance
// moves the application to hired inside the same transaction.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const offerRow = { id: 9, status: "SENT", applicationId: 3, candidateId: 5, tenantId: "tenant-a" };

const mockRunOfferHandoff = jest.fn(async () => ({ handoff: { id: 1, status: "COMPLETED" }, replayed: false }));
const mockGetOfferHandoff = jest.fn(async () => ({ id: 1, status: "COMPLETED", employeeId: 77 }));
const mockTransition = jest.fn(async () => ({ success: true, changed: true }));

const prisma = {
  offer: { findFirst: jest.fn(), update: jest.fn(async () => offerRow) },
  // Concurrent responses are serialized with a row lock on "offers".
  $queryRaw: jest.fn(async () => [{ id: 9 }]),
};

// offer.service now reaches the candidate PII service (privacy gate on send), so
// the canonical singleton and every export the mocked module graph needs must
// resolve to doubles — otherwise a real PrismaClient is constructed here.
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(prisma)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({ uploadFileToDAM: jest.fn(), deleteDamAsset: jest.fn() }));
jest.unstable_mockModule("../../src/services/application-workflow.service.js", () => ({
  transitionApplicationStageInTransaction: mockTransition,
  transitionApplicationStage: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/recruitment-handoff.service.js", () => ({
  runOfferHandoff: mockRunOfferHandoff,
  getOfferHandoff: mockGetOfferHandoff,
}));

const { respondOffer, updateOffer } = await import("../../src/services/offer.service.js");

describe("Offer acceptance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow });
    prisma.offer.update.mockResolvedValue({ ...offerRow, status: "ACCEPTED" });
  });

  it("accepts a SENT offer, hires the application, and runs the handoff once", async () => {
    const result = await respondOffer(9, true, "tenant-a", { actorId: 12, employeeCategory: "EMPLOYEE" });

    expect(result.replayed).toBe(false);
    // The category is stored so the handoff (and any retry) allocates the same
    // kind of employee code.
    expect(prisma.offer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED", employeeCategory: "EMPLOYEE" }) }),
    );
    // The lock names the real table; main's version locked "Offer", which does not exist.
    expect(prisma.$queryRaw.mock.calls[0][0].join("")).toContain('FROM "offers"');
    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, targetStage: "hired", source: "offer-accept", actorId: 12 }),
      prisma,
    );
    expect(mockRunOfferHandoff).toHaveBeenCalledTimes(1);
  });

  it("replays a repeated acceptance without provisioning again", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, status: "ACCEPTED" });

    const result = await respondOffer(9, true, "tenant-a", { employeeCategory: "EMPLOYEE" });

    expect(result.replayed).toBe(true);
    expect(result.handoff.employeeId).toBe(77);
    expect(mockRunOfferHandoff).not.toHaveBeenCalled();
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("rejects a conflicting response on a finalized offer", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, status: "ACCEPTED" });

    await expect(respondOffer(9, false, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-FINALIZED" });
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("refuses a response to an offer that was never sent", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, status: "DRAFT" });

    await expect(respondOffer(9, true, "tenant-a", { employeeCategory: "EMPLOYEE" }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-NOT-SENT" });
    expect(mockRunOfferHandoff).not.toHaveBeenCalled();
  });

  it("refuses to accept without an explicit employee category, before any write", async () => {
    for (const ctx of [{}, { employeeCategory: "CONTRACTOR" }]) {
      await expect(respondOffer(9, true, "tenant-a", ctx))
        .rejects.toMatchObject({ status: 422, code: "HR-RECRUITMENT-OFFER-CATEGORY-REQUIRED" });
    }
    expect(prisma.offer.update).not.toHaveBeenCalled();
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

describe("D-08 — HR_RECRUITMENT_OFFER_HANDOFF is read by acceptance", () => {
  afterEach(() => {
    delete process.env.HR_RECRUITMENT_OFFER_HANDOFF;
  });

  it("refuses an acceptance with 503 before any write while the flag is off", async () => {
    process.env.HR_RECRUITMENT_OFFER_HANDOFF = "off";
    prisma.offer.update.mockClear();

    await expect(respondOffer(9, true, "tenant-a", { employeeCategory: "EMPLOYEE" }))
      .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-OFFER-HANDOFF-DISABLED" });
    expect(prisma.offer.update).not.toHaveBeenCalled();
  });

  it("still records a decline while the flag is off — nothing is provisioned", async () => {
    process.env.HR_RECRUITMENT_OFFER_HANDOFF = "off";
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow });
    prisma.offer.update.mockResolvedValue({ ...offerRow, status: "DECLINED" });

    const result = await respondOffer(9, false, "tenant-a");
    expect(result.offer.status).toBe("DECLINED");
  });
});

describe("D-10 — the generic offer update cannot move status freely", () => {
  beforeEach(() => {
    prisma.offer.updateMany = jest.fn(async () => ({ count: 1 }));
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, status: "DRAFT" });
  });

  it.each([["SENT"], ["ACCEPTED"], ["DECLINED"], ["EXPIRED"], ["anything"]])(
    "refuses an update that sets status %s",
    async (status) => {
      await expect(updateOffer(9, { status }, "tenant-a"))
        .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-STATUS-READONLY" });
      expect(prisma.offer.updateMany).not.toHaveBeenCalled();
    },
  );

  it("accepts a re-sent current status as a no-op and allows withdrawing a live offer", async () => {
    await updateOffer(9, { status: "DRAFT", notes: "edited" }, "tenant-a");
    expect(prisma.offer.updateMany.mock.calls[0][0].data).not.toHaveProperty("status");

    await updateOffer(9, { status: "WITHDRAWN" }, "tenant-a");
    expect(prisma.offer.updateMany.mock.calls[1][0].data.status).toBe("WITHDRAWN");
  });
});
