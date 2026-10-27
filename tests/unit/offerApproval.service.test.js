import { jest } from "@jest/globals";

const legacyDecision = jest.fn(async () => {
  throw Object.assign(new Error("Open HR Approval Centre"), {
    status: 409,
    code: "HR-4201",
  });
});
jest.unstable_mockModule("../../src/services/approval/legacy.js", () => ({
  legacyDecision,
}));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
const {
  approveOffer,
  assertOfferApproved,
  getOfferApprovalPolicy,
  requiredStagesForOffer,
  setOfferApprovalPolicy,
  OFFER_APPROVAL_STAGES,
} = await import("../../src/services/offerApproval.service.js");

describe("Recruitment offer approvals", () => {
  // FR-09 residue — `offerApprovalRule.findMany` resolves to [] by default so
  // every pre-existing expectation in this file describes an UNCONFIGURED
  // tenant, which must keep resolving to the pre-policy triple.
  const db = () => ({
    offer: {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          id: 4,
          status: "DRAFT",
          approvalStatus: "PENDING",
        }),
      update: jest.fn().mockResolvedValue({}),
    },
    offerApproval: {
      upsert: jest
        .fn()
        .mockResolvedValue({ stage: "hiringManager", decision: "APPROVED" }),
      findMany: jest
        .fn()
        .mockResolvedValue(
          OFFER_APPROVAL_STAGES.map((stage) => ({
            stage,
            decision: "APPROVED",
          })),
        ),
    },
    offerApprovalRule: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
  });

  test("offer decisions route to the Approval Centre without writing a second ledger", async () => {
    const client = db();
    await expect(
      approveOffer({
        offerId: 4,
        stage: "finance",
        decision: "APPROVED",
        tenantId: "tenant-a",
        db: client,
      }),
    ).rejects.toMatchObject({ status: 409, code: "HR-4201" });
    expect(legacyDecision).toHaveBeenCalledWith("OFFER", 4);
    expect(client.offerApproval.upsert).not.toHaveBeenCalled();
    expect(client.offer.update).not.toHaveBeenCalled();
  });
  test("unapproved offers cannot be sent", async () => {
    await expect(
      assertOfferApproved({ offerId: 4, tenantId: "tenant-a", db: db() }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED" });
  });

  test("an unconfigured tenant resolves to the pre-policy triple", async () => {
    const client = db();
    const resolved = await requiredStagesForOffer({
      offerId: 4,
      tenantId: "tenant-a",
      db: client,
    });
    expect(resolved.source).toBe("DEFAULT");
    expect(resolved.steps.map((s) => s.stage)).toEqual(OFFER_APPROVAL_STAGES);
  });

  test("a configured policy narrows the required stages for THIS offer's amount", async () => {
    const client = db();
    client.offer.findFirst.mockResolvedValue({
      id: 4,
      status: "DRAFT",
      approvalStatus: "PENDING",
      salary: 90_000,
      currency: "USD",
    });
    client.offerApprovalRule.findMany.mockResolvedValue([
      {
        stepOrder: 1,
        stage: "hiringManager",
        role: null,
        minAmount: null,
        maxAmount: null,
        currency: null,
      },
      {
        stepOrder: 2,
        stage: "finance",
        role: null,
        minAmount: "150000",
        maxAmount: null,
        currency: "USD",
      },
    ]);

    const resolved = await requiredStagesForOffer({
      offerId: 4,
      tenantId: "tenant-a",
      db: client,
    });
    expect(resolved.source).toBe("TEMPLATE");
    expect(resolved.steps.map((s) => s.stage)).toEqual(["hiringManager"]);
  });

  test("assertOfferApproved RE-DERIVES the set: a policy change after the last decision blocks the send", async () => {
    const client = db();
    client.offer.findFirst.mockResolvedValue({
      id: 4,
      status: "DRAFT",
      approvalStatus: "APPROVED",
      salary: 400_000,
      currency: "USD",
    });
    // Stored status says APPROVED, but the policy now demands Finance, which
    // has no decision recorded. A status computed under the old policy must not
    // authorise a send under the new one.
    client.offerApprovalRule.findMany.mockResolvedValue([
      {
        stepOrder: 1,
        stage: "hiringManager",
        role: null,
        minAmount: null,
        maxAmount: null,
        currency: null,
      },
      {
        stepOrder: 2,
        stage: "finance",
        role: null,
        minAmount: 150_000,
        maxAmount: null,
        currency: null,
      },
    ]);
    client.offerApproval.findMany.mockResolvedValue([
      { stage: "hiringManager", decision: "APPROVED" },
    ]);

    await expect(
      assertOfferApproved({ offerId: 4, tenantId: "tenant-a", db: client }),
    ).rejects.toMatchObject({
      code: "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED",
      message: expect.stringContaining("finance"),
    });
  });

  test("assertOfferApproved passes when the re-derived set is satisfied", async () => {
    const client = db();
    client.offer.findFirst.mockResolvedValue({
      id: 4,
      status: "DRAFT",
      approvalStatus: "APPROVED",
      salary: 400_000,
      currency: "USD",
    });
    client.offerApprovalRule.findMany.mockResolvedValue([
      {
        stepOrder: 1,
        stage: "hiringManager",
        role: null,
        minAmount: null,
        maxAmount: null,
        currency: null,
      },
      {
        stepOrder: 2,
        stage: "finance",
        role: null,
        minAmount: 150_000,
        maxAmount: null,
        currency: null,
      },
    ]);
    client.offerApproval.findMany.mockResolvedValue([
      { stage: "hiringManager", decision: "APPROVED" },
      { stage: "finance", decision: "APPROVED" },
    ]);

    const result = await assertOfferApproved({
      offerId: 4,
      tenantId: "tenant-a",
      db: client,
    });
    expect(result.requiredStages).toEqual(["hiringManager", "finance"]);
  });

  test("getOfferApprovalPolicy reports the configuration and previews the resolved chain", async () => {
    const client = db();
    client.offerApprovalRule.findMany.mockResolvedValue([
      {
        stepOrder: 1,
        stage: "hiringManager",
        role: null,
        minAmount: null,
        maxAmount: null,
        currency: null,
      },
    ]);
    const unconfigured = await getOfferApprovalPolicy({
      tenantId: "tenant-a",
      db: client,
    });
    expect(unconfigured.configured).toBe(true);

    const empty = db();
    const none = await getOfferApprovalPolicy({
      tenantId: "tenant-a",
      db: empty,
    });
    expect(none.configured).toBe(false);
    expect(none.resolvedChain).toEqual(OFFER_APPROVAL_STAGES);
  });

  test("setOfferApprovalPolicy refuses an invalid policy before touching the database", async () => {
    const client = db();
    await expect(
      setOfferApprovalPolicy({
        tenantId: "tenant-a",
        rules: [{ stepOrder: 1, stage: "ceo" }],
        db: client,
      }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-POLICY-INVALID" });
    expect(client.offerApprovalRule.updateMany).not.toHaveBeenCalled();
    expect(client.offerApprovalRule.create).not.toHaveBeenCalled();
  });

  test("setOfferApprovalPolicy deactivates the old rules then creates the new ones", async () => {
    const tx = {
      offerApprovalRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValue([{ stepOrder: 1, stage: "hrHead" }]),
      },
    };
    const client = { ...db(), $transaction: jest.fn(async (fn) => fn(tx)) };

    const saved = await setOfferApprovalPolicy({
      tenantId: "tenant-a",
      rules: [{ stepOrder: 1, stage: "hrHead" }],
      createdById: 7,
      db: client,
    });
    expect(tx.offerApprovalRule.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", isActive: true },
      data: { isActive: false },
    });
    expect(tx.offerApprovalRule.create).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([{ stepOrder: 1, stage: "hrHead" }]);
  });
});
