import { jest } from "@jest/globals";

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
const { approveOffer, assertOfferApproved, OFFER_APPROVAL_STAGES } =
  await import("../../src/services/offerApproval.service.js");

describe("Recruitment offer approvals", () => {
  const db = () => ({
    offer: {
      findFirst: jest.fn().mockResolvedValue({ id: 4, status: "DRAFT", approvalStatus: "PENDING" }),
      update: jest.fn().mockResolvedValue({}),
    },
    offerApproval: {
      upsert: jest.fn().mockResolvedValue({ stage: "hiringManager", decision: "APPROVED" }),
      findMany: jest.fn().mockResolvedValue(
        OFFER_APPROVAL_STAGES.map((stage) => ({ stage, decision: "APPROVED" }))
      ),
    },
  });

  test("requires all approval stages before sending", async () => {
    const client = db();
    const result = await approveOffer({
      offerId: 4,
      stage: "hiringManager",
      decision: "APPROVED",
      tenantId: "tenant-a",
      db: client,
    });
    expect(result.approvalStatus).toBe("APPROVED");
    expect(client.offer.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { approvalStatus: "APPROVED" } });

    const pending = db();
    pending.offerApproval.findMany.mockResolvedValue([{ stage: "hiringManager", decision: "APPROVED" }]);
    await expect(assertOfferApproved({ offerId: 4, tenantId: "tenant-a", db: pending }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED" });
  });

  test("requires a reason for rejected approvals", async () => {
    await expect(approveOffer({
      offerId: 4,
      stage: "finance",
      decision: "REJECTED",
      tenantId: "tenant-a",
      db: db(),
    })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-REASON-REQUIRED" });
  });
});
