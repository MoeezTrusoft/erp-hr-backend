import { jest } from "@jest/globals";

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
const {
  approveOffer,
  assertOfferApproved,
  getOfferApprovalPolicy,
  requiredStagesForOffer,
  setOfferApprovalPolicy,
  OFFER_APPROVAL_STAGES,
} = await import("../../src/services/offer-approval.service.js");

describe("Recruitment offer approvals", () => {
  // FR-09 residue — `offerApprovalRule.findMany` resolves to [] by default so
  // every pre-existing expectation in this file describes an UNCONFIGURED
  // tenant, which must keep resolving to the pre-policy triple.
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
    offerApprovalRule: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
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

  test("an unconfigured tenant resolves to the pre-policy triple", async () => {
    const client = db();
    const resolved = await requiredStagesForOffer({ offerId: 4, tenantId: "tenant-a", db: client });
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
      { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
      { stepOrder: 2, stage: "finance", role: null, minAmount: "150000", maxAmount: null, currency: "USD" },
    ]);

    const resolved = await requiredStagesForOffer({ offerId: 4, tenantId: "tenant-a", db: client });
    expect(resolved.source).toBe("TEMPLATE");
    expect(resolved.steps.map((s) => s.stage)).toEqual(["hiringManager"]);
  });

  test("approveOffer reports the required set the decision was judged against", async () => {
    const client = db();
    client.offerApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
    ]);
    client.offerApproval.findMany.mockResolvedValue([{ stage: "hiringManager", decision: "APPROVED" }]);
    client.offer.findFirst.mockResolvedValue({ id: 4, status: "DRAFT", approvalStatus: "PENDING", salary: 10, currency: "USD" });

    const result = await approveOffer({
      offerId: 4,
      stage: "hiringManager",
      decision: "APPROVED",
      tenantId: "tenant-a",
      db: client,
    });
    expect(result.approvalStatus).toBe("APPROVED");
    expect(result.requiredStages).toEqual(["hiringManager"]);
    expect(result.requiredSource).toBe("TEMPLATE");
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
      { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
      { stepOrder: 2, stage: "finance", role: null, minAmount: 150_000, maxAmount: null, currency: null },
    ]);
    client.offerApproval.findMany.mockResolvedValue([{ stage: "hiringManager", decision: "APPROVED" }]);

    await expect(assertOfferApproved({ offerId: 4, tenantId: "tenant-a", db: client })).rejects.toMatchObject({
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
      { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
      { stepOrder: 2, stage: "finance", role: null, minAmount: 150_000, maxAmount: null, currency: null },
    ]);
    client.offerApproval.findMany.mockResolvedValue([
      { stage: "hiringManager", decision: "APPROVED" },
      { stage: "finance", decision: "APPROVED" },
    ]);

    const result = await assertOfferApproved({ offerId: 4, tenantId: "tenant-a", db: client });
    expect(result.requiredStages).toEqual(["hiringManager", "finance"]);
  });

  test("getOfferApprovalPolicy reports the configuration and previews the resolved chain", async () => {
    const client = db();
    client.offerApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
    ]);
    const unconfigured = await getOfferApprovalPolicy({ tenantId: "tenant-a", db: client });
    expect(unconfigured.configured).toBe(true);

    const empty = db();
    const none = await getOfferApprovalPolicy({ tenantId: "tenant-a", db: empty });
    expect(none.configured).toBe(false);
    expect(none.resolvedChain).toEqual(OFFER_APPROVAL_STAGES);
  });

  test("setOfferApprovalPolicy refuses an invalid policy before touching the database", async () => {
    const client = db();
    await expect(setOfferApprovalPolicy({
      tenantId: "tenant-a",
      rules: [{ stepOrder: 1, stage: "ceo" }],
      db: client,
    })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-POLICY-INVALID" });
    expect(client.offerApprovalRule.updateMany).not.toHaveBeenCalled();
    expect(client.offerApprovalRule.create).not.toHaveBeenCalled();
  });

  test("setOfferApprovalPolicy deactivates the old rules then creates the new ones", async () => {
    const tx = {
      offerApprovalRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([{ stepOrder: 1, stage: "hrHead" }]),
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
    // Phase 7 (B10) — the saved rules carry their author's display name.
    expect(saved).toEqual([{ stepOrder: 1, stage: "hrHead", createdByName: null }]);
  });

  // Recruitment Phase 7 (B10) — names next to the ids, one lookup per read.
  test("approveOffer and the policy read carry approverName / createdByName", async () => {
    const employees = [{ id: 31, first_name: "Sana", last_name: "Iqbal", employee_name: null }];
    const client = db();
    client.employee = { findMany: jest.fn().mockResolvedValue(employees) };
    client.offerApproval.upsert.mockResolvedValue({ stage: "hiringManager", decision: "APPROVED", approverId: 31 });
    const result = await approveOffer({ offerId: 4, stage: "hiringManager", decision: "APPROVED", approverId: 31, tenantId: "tenant-a", db: client });
    expect(result.approval).toMatchObject({ approverId: 31, approverName: "Sana Iqbal" });
    expect(client.employee.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [31] }, tenant_id: "tenant-a" },
      select: { id: true, first_name: true, last_name: true, employee_name: true },
    }));

    client.offerApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, stage: "hrHead", createdById: 31 },
      { stepOrder: 2, stage: "finance", createdById: 99 },
    ]);
    const policy = await getOfferApprovalPolicy({ tenantId: "tenant-a", db: client });
    expect(policy.rules.map((r) => [r.createdById, r.createdByName])).toEqual([[31, "Sana Iqbal"], [99, null]]);
    expect(client.employee.findMany).toHaveBeenCalledTimes(2);
  });
});
