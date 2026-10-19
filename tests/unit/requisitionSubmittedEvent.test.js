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

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
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

const { enqueueHrDomainEvent } = await import("../../src/services/hrDomainEvent.service.js");
const { submitRequisition, updateRequisition } = await import("../../src/services/requisition.service.js");
const { submitRequisition: mgmtSubmit } = await import("../../src/services/requisitionMgmt.service.js");
const { submitRequisition: legacySubmit } = await import("../../src/services/hrContract.service.js");

const submittedEventOf = (nth = 0) => {
  const calls = enqueueHrDomainEvent.mock.calls.filter(([, args]) => args?.eventName === "hr.recruitment.requisition_submitted.v1");
  return calls[nth]?.[1] ?? null;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.requisitionApprovalRule.findMany.mockResolvedValue([]);
});

describe("Phase 4 closure — requisition_submitted carries approver routing on every submit surface", () => {
  it("management submit routes to the first pending step's pinned approver", async () => {
    prisma.requisitionApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 2, role: "HR_MANAGER", approverId: 31, isActive: true },
      { stepOrder: 1, role: "DEPARTMENT_HEAD", approverId: 9, isActive: true },
    ]);
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    prisma.jobRequisition.update.mockResolvedValue({ ...row, status: "PENDING_APPROVAL" });

    await mgmtSubmit(5, TENANT, 7);

    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload).toMatchObject({
      requisitionId: "5",
      status: "PENDING_APPROVAL",
      requestedById: "1",
      pendingApproverId: "9", // step 1, NOT the rule array's order
      pendingStepOrder: 1,
    });
    expect(ev.tenantId).toBe(TENANT);
    expect(ev.actorId).toBe(7);
  });

  it("generic PATCH submit (status flip in one call) emits the same routed event", async () => {
    prisma.requisitionApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, role: "HR_MANAGER", approverId: 31, isActive: true },
    ]);
    const existing = { id: 8, title: "QA Lead", status: "DRAFT", tenantId: TENANT, version: 3, ...SUBMITTABLE };
    // pre-read, then the post-flip re-read the emit uses
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, status: "PENDING_APPROVAL" });
    prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });

    await updateRequisition(8, { status: "PENDING_APPROVAL" }, 6, TENANT);

    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload.pendingApproverId).toBe("31");
    expect(ev.payload.pendingStepOrder).toBe(1);
    expect(ev.actorId).toBe(6);
  });

  it("legacy /api/hr submit emits the same routed event — the audience does not depend on the URL", async () => {
    prisma.requisitionApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, role: "HR_MANAGER", approverId: 31, isActive: true },
    ]);
    const row = { id: 12, title: "Ops Analyst", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    prisma.jobRequisition.update.mockResolvedValue({ ...row, status: "PENDING_APPROVAL" });

    await legacySubmit(12, TENANT, 4, "please review");

    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload.pendingApproverId).toBe("31");
    expect(ev.payload.pendingStepOrder).toBe(1);
  });

  it("a tenant with no configured rules still emits, with null routing (un-stepped decision)", async () => {
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    prisma.jobRequisition.update.mockResolvedValue({ ...row, status: "PENDING_APPROVAL" });

    await mgmtSubmit(5, TENANT, 7);

    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload.pendingApproverId).toBeNull();
    expect(ev.payload.pendingStepOrder).toBeNull();
  });

  it("a first step that names only a role routes as null — no invented recipient", async () => {
    prisma.requisitionApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, role: "HR_MANAGER", approverId: null, isActive: true },
    ]);
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    prisma.jobRequisition.update.mockResolvedValue({ ...row, status: "PENDING_APPROVAL" });

    await mgmtSubmit(5, TENANT, 7);

    expect(submittedEventOf().payload.pendingApproverId).toBeNull();
  });

  it("a refusal at the gate emits nothing — no audience for a submit that never happened", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "POSTED", tenantId: TENANT });

    await expect(mgmtSubmit(5, TENANT, 7)).rejects.toMatchObject({
      code: "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID",
    });
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
  });
});
