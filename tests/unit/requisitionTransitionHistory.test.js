// tests/unit/requisitionTransitionHistory.test.js
//
// Phase 2.1 — requisition transition history.
//
// Applications have had an append-only history since the workflow slice; a
// requisition had only RequisitionApproval, which records a DECISION and nothing
// else — so submit, post, reopen and close left no trace, and "who moved this,
// when, and why" was unanswerable for every transition except approve/reject.
//
// These tests pin the behaviour that matters: every legal state move writes
// exactly one attributed row, the row describes the status the move actually
// came from, a creation records its own origin, and a lost compare-and-set race
// records NOTHING (a history row for a transition nobody performed is worse than
// no row at all).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { approvalCentreDouble } from "./helpers/approval-centre-double.js";

const prisma = {
  jobRequisition: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  requisitionApproval: { create: jest.fn(), findMany: jest.fn(async () => []) },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  requisitionTransition: { create: jest.fn() },
  // Phase 4 — publication is per channel: it checks whether the channel is
  // already live before writing, and the close paths close postings in place.
  jobPosting: {
    create: jest.fn(),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
  businessUnit: { findMany: jest.fn() },
  // Phase 4 — the submit and publish paths also consult the hiring freeze; no
  // freeze is in effect in this suite, which is about the history rows written.
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  // The submitted event is routed to the requester's line manager.
  employee: { findFirst: jest.fn(async () => ({ managerId: 12 })) },
};

// Decisions answer HR-4201 from the HR Approval Centre; its submit opens review
// and (Phase 7) writes the submit's transition row in the same transaction: the
// double runs the REAL onSubmit (approval/adapters.js) on `prisma`.
const centre = approvalCentreDouble(prisma);
jest.unstable_mockModule("../../src/services/approval/legacy.js", () => ({
  legacyDecision: jest.fn(async () => {
    throw Object.assign(new Error("HR-4201: Open HR Approval Centre"), { status: 409, code: "HR-4201" });
  }),
  legacySubmit: centre.legacySubmit,
}));

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => undefined),
}));
// The interactive-transaction helper is a pass-through here: these tests are
// about WHAT is written, not about the GUC plumbing (that is asserted against a
// real database in the integration suites).
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));

const {
  approveRequisition,
  postRequisition,
  updateRequisition,
  createRequisition,
} = await import("../../src/services/requisition.service.js");
const {
  submitRequisition,
  rejectRequisition,
  closeRequisition,
} = await import("../../src/services/requisitionMgmt.service.js");

const TENANT = "11111111-1111-1111-1111-111111111111";

// Phase 2.2 — what a requisition must carry before it can be SUBMITTED. Spread
// into a fixture when holding back one field deliberately (the gate test below),
// so the fixture never fails for an unrelated missing field as well.
const SUBMITTABLE = {
  departmentId: 1,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  requestedById: 1,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
};

// The single history row this call wrote.
const historyRow = (nth = 0) => prisma.requisitionTransition.create.mock.calls[nth][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  centre.reset();
  prisma.requisitionTransition.create.mockResolvedValue({ id: 1 });
  prisma.requisitionApproval.create.mockResolvedValue({ id: 1 });
  prisma.jobPosting.create.mockResolvedValue({ id: 1 });
  prisma.jobPosting.findFirst.mockResolvedValue(null);
  prisma.jobPosting.updateMany.mockResolvedValue({ count: 0 });
  prisma.businessUnit.findMany.mockResolvedValue([]);
  prisma.jobRequisition.update.mockImplementation(async ({ where }) => ({ id: where.id, status: "POSTED" }));
  prisma.jobRequisition.count.mockResolvedValue(0);
  prisma.jobRequisition.findMany.mockResolvedValue([]);
});

describe("Phase 2.1 — requisition transition history", () => {
  it("records a creation with both sides equal to the born status", async () => {
    prisma.jobRequisition.create.mockResolvedValue({ id: 42, status: "DRAFT", departmentId: null });

    await createRequisition({ title: "Staff Nurse" }, 7, TENANT);

    expect(historyRow()).toMatchObject({
      requisitionId: 42,
      tenantId: TENANT,
      fromStatus: "DRAFT",
      toStatus: "DRAFT",
      reason: "initial requisition",
      actorId: 7,
      source: "requisition",
    });
  });

  it("records the submit transition, attributed to the caller", async () => {
    const row = {
      id: 5,
      title: "Backend Engineer",
      status: "DRAFT",
      approvals: [],
      transitions: [],
      ...SUBMITTABLE,
    };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "PENDING_APPROVAL" });
    // In production the centre's env.who is the verified caller: the same
    // employee the service receives as actorId.
    centre.arm({ tenantId: TENANT, actorId: 9, row });

    await submitRequisition(5, TENANT, 9);

    // The surface hands the centre its source; it writes neither the status
    // move nor the history row itself.
    expect(centre.legacySubmit).toHaveBeenCalledTimes(1);
    expect(centre.legacySubmit).toHaveBeenCalledWith("REQUISITION", 5, undefined, {
      requisition: { reason: null, transitionSource: "requisition.submit" },
    });
    // The PENDING_APPROVAL move is the HR Approval Centre's, opened by submit,
    // and the one history row is written in that same transaction.
    expect(prisma.jobRequisition.update.mock.calls).toEqual([
      [{ where: { id: 5 }, data: { status: "PENDING_APPROVAL" } }],
    ]);
    expect(prisma.requisitionTransition.create).toHaveBeenCalledTimes(1);
    expect(historyRow()).toMatchObject({
      requisitionId: 5,
      tenantId: TENANT,
      fromStatus: "DRAFT",
      toStatus: "PENDING_APPROVAL",
      reason: null,
      actorId: 9,
      source: "requisition.submit",
    });
  });

  it("records the close transition", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 5,
      status: "POSTED",
      departmentId: null,
      approvals: [],
      transitions: [],
    });
    prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "CLOSED" });

    // Phase 4 / §2.4a — closing a PUBLISHED requisition owes a reason.
    await closeRequisition(5, TENANT, 9, "Opening filled");

    expect(historyRow()).toMatchObject({
      fromStatus: "POSTED",
      toStatus: "CLOSED",
      reason: "Opening filled",
      actorId: 9,
      source: "requisition.close",
    });
  });

  it("leaves rejection and approval history to the HR Approval Centre's final decision", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "PENDING_APPROVAL" });

    await expect(rejectRequisition(5, TENANT, { comments: "No headcount", approverId: 3 }))
      .rejects.toMatchObject({ code: "HR-4201" });
    await expect(approveRequisition(5, "APPROVED", undefined, 3, TENANT))
      .rejects.toMatchObject({ code: "HR-4201" });
    // The centre's Management decision writes this history (covered in
    // requisitionWorkflow.service.test.js); a refused legacy call writes none.
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("records a publication, which previously left no trace at all", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "APPROVED" });
    prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "POSTED" });

    await postRequisition(5, "https://jobs.example/1", 4, TENANT);

    expect(historyRow()).toMatchObject({
      fromStatus: "APPROVED",
      toStatus: "POSTED",
      actorId: 4,
      source: "requisition.post",
    });
  });

  it("records a status move made by the generic update", async () => {
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ id: 5, status: "REJECTED" })
      .mockResolvedValueOnce({ id: 5, status: "DRAFT" });
    prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });

    await updateRequisition(5, { status: "DRAFT" }, 6, TENANT);

    expect(historyRow()).toMatchObject({
      fromStatus: "REJECTED",
      toStatus: "DRAFT",
      actorId: 6,
      source: "requisition.update",
    });
  });

  it("writes no history when the compare-and-set matched no row", async () => {
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ id: 5, status: "REJECTED" })
      // The post-conflict re-read used to build the 412 body.
      .mockResolvedValueOnce({ id: 5, status: "REJECTED", version: 4 });
    prisma.jobRequisition.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateRequisition(5, { status: "DRAFT", expectedVersion: 2 }, 6, TENANT)).rejects.toThrow();

    // The move never happened, so no row may claim it did.
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("writes no history for an update that does not touch the status", async () => {
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ id: 5, status: "DRAFT" })
      .mockResolvedValueOnce({ id: 5, status: "DRAFT" });
    prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });

    await updateRequisition(5, { title: "Renamed" }, 6, TENANT);

    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("writes no history when the transition itself is refused", async () => {
    // POSTED → PENDING_APPROVAL is not a legal move; the guard must refuse
    // before either write is attempted.
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "POSTED" });

    await expect(submitRequisition(5, TENANT, 9)).rejects.toMatchObject({
      code: "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID",
    });
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
  });
});
