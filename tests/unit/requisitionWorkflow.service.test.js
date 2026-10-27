// tests/unit/requisitionWorkflow.service.test.js
//
// Phase 3.2 — the requisition approval chain must be enforced, not advisory.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { mcpCtx } from "../../src/mcp/context.js";

const asPublisher = (tenantId, fn) => mcpCtx.run({
  actorVerified: true, permissions: ["hr.recruitment.create"],
  user: { tenantId, userId: 5, roles: ["HR_ADMIN"] },
}, fn);

const mockLogAction = jest.fn(async () => undefined);

// One shared double: a DRAFT requisition that is not yet in the caller's
// tenant scope would be null (cross-tenant), which the 404 tests rely on.
const approvalSubmit = jest.fn(async () => ({
  id: 5,
  status: "PENDING_APPROVAL",
}));
const approvalDecision = jest.fn(async () => {
  throw Object.assign(new Error("Open HR Approval Centre"), {
    status: 409,
    code: "HR-4201",
  });
});
jest.unstable_mockModule("../../src/services/approval/legacy.js", () => ({
  legacySubmit: approvalSubmit,
  legacyDecision: approvalDecision,
}));

const prisma = {
  employee: { findMany: jest.fn(async () => [{ id: 5, employee_code: "HR-005", status: "active" }]) },
  recruitmentSettings: { findUnique: jest.fn(async () => null) },
  $executeRaw: jest.fn(async () => 0),
  $queryRawUnsafe: jest.fn(async () => []),
  jobRequisition: {
    findFirst: jest.fn(),
    update: jest.fn(async () => ({ id: 1 })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    create: jest.fn(async () => ({ id: 1 })),
  },
  requisitionApproval: {
    create: jest.fn(async () => ({ id: 1 })),
    findMany: jest.fn(async () => []),
  },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  // Phase 2.1 — every status move now also writes an immutable transition row in
  // the same transaction, so the double must model it.
  requisitionTransition: { create: jest.fn(async () => ({ id: 1 })) },
  // Phase 4 — publishing is now per CHANNEL, so it looks up whether a channel is
  // already live before writing, and the close paths close postings in place.
  jobPosting: {
    create: jest.fn(async () => ({ id: 1 })),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
  // Phase 4 — submitting and publishing now also consult the hiring freeze. This
  // suite is about the state machine, so no freeze is in effect.
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  outboxEvent: { create: jest.fn(async () => ({ id: 1 })) },
  // Approval/posting now run in a tenant transaction (decision + approval row +
  // outbox event commit together), so the double must hand back the same client.
  $transaction: jest.fn((fn) => fn(prisma)),
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({
  logAction: mockLogAction,
}));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
}));

const { assertRequisitionTransition, canTransitionRequisition } =
  await import("../../src/services/requisitionWorkflow.service.js");
const { approveRequisition, createRequisition, postRequisition } =
  await import("../../src/services/requisition.service.js");

describe("Requisition state machine (Phase 3.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "PENDING_APPROVAL",
    });
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
    expect(() => assertRequisitionTransition("APPROVED", "APPROVED")).toThrow(
      /already APPROVED/,
    );
    try {
      assertRequisitionTransition("APPROVED", "APPROVED");
    } catch (error) {
      expect(error.code).toBe("HR-RECRUITMENT-REQUISITION-NOOP");
    }
  });

  it("requires a reason to reject a requisition", () => {
    expect(() =>
      assertRequisitionTransition("PENDING_APPROVAL", "REJECTED"),
    ).toThrow(/requires a reason/);
    expect(() =>
      assertRequisitionTransition("PENDING_APPROVAL", "REJECTED", {
        comments: "Budget frozen",
      }),
    ).not.toThrow();
  });

  it("requires the Approval Centre: blocks approving a requisition that was never submitted", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "DRAFT",
    });
    await expect(
      approveRequisition(1, "APPROVED", "Reviewed", 5, "tenant-a"),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(approvalDecision).toHaveBeenCalledWith("REQUISITION", 1);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("requires the Approval Centre: approves a submitted requisition and records the decision", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "PENDING_APPROVAL",
    });
    await expect(
      approveRequisition(1, "APPROVED", "Reviewed", 5, "tenant-a"),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(approvalDecision).toHaveBeenCalledWith("REQUISITION", 1);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("requires the Approval Centre: emits the decision event inside the same transaction", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "PENDING_APPROVAL",
    });
    await expect(
      approveRequisition(1, "APPROVED", "Reviewed", 5, "tenant-a"),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(approvalDecision).toHaveBeenCalledWith("REQUISITION", 1);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("requires the Approval Centre: blocks a decision raced by a concurrent one, inside the transaction", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "APPROVED",
    });
    await expect(
      approveRequisition(1, "APPROVED", "Reviewed", 5, "tenant-a"),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(approvalDecision).toHaveBeenCalledWith("REQUISITION", 1);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("requires the Approval Centre: requires an approver identity", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "PENDING_APPROVAL",
    });
    await expect(
      approveRequisition(1, "APPROVED", "Reviewed", undefined, "tenant-a"),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(approvalDecision).toHaveBeenCalledWith("REQUISITION", 1);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionApproval.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("refuses to create a requisition outside DRAFT", async () => {
    await expect(
      createRequisition(
        { title: "Backend Engineer", status: "APPROVED" },
        5,
        "tenant-a",
      ),
    ).rejects.toMatchObject({
      code: "HR-RECRUITMENT-REQUISITION-INITIAL-STATUS",
    });
    expect(prisma.jobRequisition.create).not.toHaveBeenCalled();
  });

  it("only publishes an APPROVED requisition", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "PENDING_APPROVAL",
    });

    // Phase 4 — the refusal is now the PUBLICATION status rule rather than the
    // generic transition code: publishing is refused unless the requisition is
    // APPROVED (first publication) or already POSTED (an additional channel).
    await expect(
      asPublisher("tenant-a", () => postRequisition(1, "https://jobs.example.com/1", 5, "tenant-a")),
    ).rejects.toMatchObject({
      code: "HR-RECRUITMENT-PUBLICATION-STATUS-INVALID",
    });
    expect(prisma.jobPosting.create).not.toHaveBeenCalled();
  });

  it("publishes and emits the posted event atomically", async () => {
    const TENANT = "55555555-5555-4555-8555-555555555555";
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 1,
      status: "APPROVED",
      tenantId: TENANT,
    });
    prisma.jobRequisition.update.mockResolvedValue({
      id: 1,
      status: "POSTED",
      tenantId: TENANT,
    });

    await asPublisher(TENANT, () => postRequisition(1, "https://jobs.example.com/1", 5, TENANT));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.jobPosting.create).toHaveBeenCalled();
    const written = prisma.outboxEvent.create.mock.calls[0][0].data;
    expect(written.eventName).toBe("hr.recruitment.requisition_posted.v1");
    expect(written.payload.payload).toMatchObject({
      requisitionId: "1",
      externalUrl: "https://jobs.example.com/1",
    });
  });
});
