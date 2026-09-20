// tests/unit/requisitionWorkflow.service.test.js
//
// Phase 3.2 — the requisition approval chain must be enforced, not advisory.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockLogAction = jest.fn(async () => undefined);

// One shared double: a DRAFT requisition that is not yet in the caller's
// tenant scope would be null (cross-tenant), which the 404 tests rely on.
const prisma = {
  jobRequisition: {
    findFirst: jest.fn(),
    update: jest.fn(async () => ({ id: 1 })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    create: jest.fn(async () => ({ id: 1 })),
  },
  requisitionApproval: { create: jest.fn(async () => ({ id: 1 })) },
  jobPosting: { create: jest.fn(async () => ({ id: 1 })) },
  outboxEvent: { create: jest.fn(async () => ({ id: 1 })) },
  // Approval/posting now run in a tenant transaction (decision + approval row +
  // outbox event commit together), so the double must hand back the same client.
  $transaction: jest.fn((fn) => fn(prisma)),
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
}));

const {
  assertRequisitionTransition,
  canTransitionRequisition,
} = await import("../../src/services/requisitionWorkflow.service.js");
const { approveRequisition, createRequisition, postRequisition } = await import(
  "../../src/services/requisition.service.js"
);

describe("Requisition state machine (Phase 3.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1, status: "PENDING_APPROVAL" });
  });

  it("allows only legal transitions", () => {
    expect(canTransitionRequisition("DRAFT", "PENDING_APPROVAL")).toBe(true);
    expect(canTransitionRequisition("PENDING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransitionRequisition("APPROVED", "POSTED")).toBe(true);
    expect(canTransitionRequisition("REJECTED", "DRAFT")).toBe(true);
    expect(canTransitionRequisition("CLOSED", "APPROVED")).toBe(false);
    expect(canTransitionRequisition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransitionRequisition("DRAFT", "POSTED")).toBe(false);
  });

  it("refuses to re-decide an already-decided requisition", () => {
    expect(() => assertRequisitionTransition("APPROVED", "APPROVED")).toThrow(/already APPROVED/);
    try {
      assertRequisitionTransition("APPROVED", "APPROVED");
    } catch (error) {
      expect(error.code).toBe("HR-RECRUITMENT-REQUISITION-NOOP");
    }
  });

  it("requires a reason to reject a requisition", () => {
    expect(() => assertRequisitionTransition("PENDING_APPROVAL", "REJECTED"))
      .toThrow(/requires a reason/);
    expect(() => assertRequisitionTransition("PENDING_APPROVAL", "REJECTED", { comments: "Budget frozen" }))
      .not.toThrow();
  });

  it("blocks approving a requisition that was never submitted", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1, status: "DRAFT" });

    await expect(approveRequisition(1, "APPROVED", null, 5, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID" });
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
  });

  it("approves a submitted requisition and records the decision", async () => {
    await approveRequisition(1, "APPROVED", "Headcount approved", 5, "tenant-a");

    expect(prisma.requisitionApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", approverId: 5 }) }),
    );
    expect(prisma.jobRequisition.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", approvedById: 5 }) }),
    );
  });

  it("emits the decision event inside the same transaction", async () => {
    const TENANT = "55555555-5555-4555-8555-555555555555";
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1, status: "PENDING_APPROVAL", tenantId: TENANT });
    prisma.jobRequisition.update.mockResolvedValue({ id: 1, status: "APPROVED", tenantId: TENANT });

    await approveRequisition(1, "APPROVED", "Headcount approved", 5, TENANT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.create).toHaveBeenCalledTimes(1);
    // The outbox row is { tenantId, eventName, aggregateType, aggregateId, payload }
    // where `payload` is the validated envelope.
    const written = prisma.outboxEvent.create.mock.calls[0][0].data;
    expect(written.eventName).toBe("hr.recruitment.requisition_decided.v1");
    expect(written.tenantId).toBe(TENANT);
    expect(written.payload.payload).toMatchObject({ decision: "APPROVED", reason: "Headcount approved" });
  });

  it("blocks a decision raced by a concurrent one, inside the transaction", async () => {
    // Pre-read says PENDING_APPROVAL, the in-transaction read says already decided.
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ id: 1, status: "PENDING_APPROVAL" })
      .mockResolvedValueOnce({ id: 1, status: "APPROVED" });

    await expect(approveRequisition(1, "APPROVED", "again", 5, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-NOOP" });
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
  });

  it("requires an approver identity", async () => {
    await expect(approveRequisition(1, "APPROVED", null, undefined, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-APPROVER-REQUIRED" });
  });

  it("refuses to create a requisition outside DRAFT", async () => {
    await expect(createRequisition({ title: "Backend Engineer", status: "APPROVED" }, 5, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-INITIAL-STATUS" });
    expect(prisma.jobRequisition.create).not.toHaveBeenCalled();
  });

  it("only publishes an APPROVED requisition", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1, status: "PENDING_APPROVAL" });

    await expect(postRequisition(1, "https://jobs.example.com/1", 5, "tenant-a"))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID" });
    expect(prisma.jobPosting.create).not.toHaveBeenCalled();
  });

  it("publishes and emits the posted event atomically", async () => {
    const TENANT = "55555555-5555-4555-8555-555555555555";
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1, status: "APPROVED", tenantId: TENANT });
    prisma.jobRequisition.update.mockResolvedValue({ id: 1, status: "POSTED", tenantId: TENANT });

    await postRequisition(1, "https://jobs.example.com/1", 5, TENANT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.jobPosting.create).toHaveBeenCalled();
    const written = prisma.outboxEvent.create.mock.calls[0][0].data;
    expect(written.eventName).toBe("hr.recruitment.requisition_posted.v1");
    expect(written.payload.payload).toMatchObject({ requisitionId: "1", externalUrl: "https://jobs.example.com/1" });
  });
});
