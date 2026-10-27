// tests/unit/requisitionSubmittedEvent.test.js
//
// Phase 4 closure — `hr.recruitment.requisition_submitted.v1` finally carries an
// audience. The hub deliberately left this event unmapped while the approval
// chain did not exist (the payload had a requester but no approver, so the only
// person who could be notified was the person who already knew). With Phase 4
// shipped, every submit surface must emit the event THROUGH the same chain
// resolution the decision path uses, so the notified approver can never disagree
// with the gate that later judges their decision — and the audience must not
// depend on which URL performed the submit.
//
// Pinned here, per surface (management / generic PATCH / legacy /api/hr):
//   * the event fires inside the submit transaction,
//   * pendingApproverId/pendingStepOrder are resolved from the tenant's rule
//     matrix by the REAL resolver (rules mocked at prisma, not the resolver),
//   * no configured rules → the event still fires with null routing (the
//     un-stepped single decision has no pre-known actor),
//   * a first step that names only a role routes as null (the hub must not be
//     handed an invented recipient).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";

const SUBMITTABLE = {
  departmentId: 1,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  requestedById: 1,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
};

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
  jobRequisition: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  },
  requisitionApproval: { create: jest.fn(), findMany: jest.fn(async () => []) },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  requisitionTransition: { create: jest.fn(async () => ({ id: 1 })) },
  jobPosting: {
    create: jest.fn(),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
  businessUnit: { findMany: jest.fn(async () => []) },
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({
  logAction: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  createRbacSystemAccount: jest.fn(async () => null),
  getUserByEmployeeId: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
  listRoles: jest.fn(async () => []),
  getDepartmentById: jest.fn(async () => null),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));
// THE assertion seam: the outbox enqueue is spied, everything around it (chain
// resolution, builder shape) runs for real.
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => undefined),
}));

const { enqueueHrDomainEvent } =
  await import("../../src/services/hrDomainEvent.service.js");
const { updateRequisition } =
  await import("../../src/services/requisition.service.js");
const { submitRequisition: mgmtSubmit } =
  await import("../../src/services/requisitionMgmt.service.js");
const { submitRequisition: legacySubmit } =
  await import("../../src/services/hrContract.service.js");
const { emitRequisitionSubmittedEvent } =
  await import("../../src/services/requisitionApprovalChain.service.js");
beforeEach(() => {
  jest.clearAllMocks();
  prisma.requisitionApprovalRule.findMany.mockResolvedValue([]);
});
describe("Central submission and approver-routed events", () => {
  it.each([
    ["management", () => mgmtSubmit(5, TENANT, 7)],
    ["legacy HR API", () => legacySubmit(5, TENANT, 7, "please review")],
  ])(
    "%s delegates submission and leaves event ownership to the Approval Centre",
    async (_name, call) => {
      await call();
      expect(approvalSubmit.mock.calls[0].slice(0,2)).toEqual(["REQUISITION",5]);
      if(_name==="legacy HR API") expect(approvalSubmit.mock.calls[0][2]).toBe("please review");
      expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
      expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    },
  );
  it("generic PATCH cannot publish a submission event without a central request", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 5,
      status: "DRAFT",
      ...SUBMITTABLE,
    });
    await expect(
      updateRequisition(5, { status: "PENDING_APPROVAL" }, 7, TENANT),
    ).rejects.toMatchObject({ code: "HR-4201" });
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
    expect(prisma.jobRequisition.updateMany).not.toHaveBeenCalled();
  });
  it("routes a frozen first step to its pinned approver", async () => {
    await emitRequisitionSubmittedEvent(prisma, {
      tenantId: TENANT,
      actorId: 7,
      requisition: {
        id: 5,
        tenantId: TENANT,
        status: "PENDING_APPROVAL",
        ...SUBMITTABLE,
        approvalChainSnapshot: [
          { stepOrder: 1, role: "HIRING_MANAGER", approverId: 9 },
          { stepOrder: 2, role: "HR_HEAD", approverId: 31 },
        ],
      },
    });
    expect(enqueueHrDomainEvent).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 7,
        payload: expect.objectContaining({
          requisitionId: "5",
          pendingApproverId: "9",
          pendingStepOrder: 1,
        }),
      }),
    );
    expect(prisma.requisitionApprovalRule.findMany).not.toHaveBeenCalled();
  });
  it("a role-assigned step does not invent a recipient id", async () => {
    await emitRequisitionSubmittedEvent(prisma, {
      tenantId: TENANT,
      requisition: {
        id: 5,
        tenantId: TENANT,
        status: "PENDING_APPROVAL",
        ...SUBMITTABLE,
        approvalChainSnapshot: [
          { stepOrder: 1, role: "HIRING_MANAGER", approverId: null },
        ],
      },
    });
    expect(
      enqueueHrDomainEvent.mock.calls[0][1].payload.pendingApproverId,
    ).toBeNull();
  });
  it("a central validation refusal produces no duplicate submit event", async () => {
    approvalSubmit.mockRejectedValueOnce(
      Object.assign(new Error("Request is not a draft"), { status: 409 }),
    );
    await expect(mgmtSubmit(5, TENANT, 7)).rejects.toMatchObject({
      status: 409,
    });
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
  });
});
