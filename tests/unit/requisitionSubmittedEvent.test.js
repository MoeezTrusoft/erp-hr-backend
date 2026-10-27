// tests/unit/requisitionSubmittedEvent.test.js
//
// Phase 4 closure, reconciled with the HR Approval Centre:
// `hr.recruitment.requisition_submitted.v1` carries an audience. The centre
// reviews every requisition with one chain (initiator, line manager, HR,
// Management), so the first reviewer is always the requester's direct line
// manager. Every submit surface must route the event to that person, and the
// audience must not depend on which URL performed the submit. The recruitment
// approval matrix no longer decides who reviews, so it must not change routing.
//
// Phase 7: the event (and the transition row) is written INSIDE the centre's
// submit transaction by onSubmit (approval/adapters.js), not by the surface.
// legacy.js is mocked with a double that runs the REAL onSubmit on this
// suite's prisma double (tests/unit/helpers/approval-centre-double.js), so the
// routing below is the production routing, reached through each surface.
//
// Pinned here, per surface (management / generic PATCH / legacy /api/hr):
//   * the surface hands the centre its id, reason and transition source and
//     writes no transition / event of its own (exactly one of each per submit),
//   * the event is enqueued on the centre's transaction client,
//   * pendingApproverId is the requester's managerId and pendingStepOrder is 1,
//   * a requester with no line manager routes as null (no invented recipient),
//   * a configured matrix does not change the routing.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { approvalCentreDouble } from "./helpers/approval-centre-double.js";

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
  employee: { findFirst: jest.fn(async () => ({ managerId: 9 })) },
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

// The HR Approval Centre opens the review and, in the same transaction, writes
// the transition row and the routed event (the REAL onSubmit runs on `prisma`).
const centre = approvalCentreDouble(prisma);
jest.unstable_mockModule("../../src/services/approval/legacy.js", () => ({
  legacyDecision: jest.fn(async () => {
    throw Object.assign(new Error("HR-4201"), { status: 409, code: "HR-4201" });
  }),
  legacySubmit: centre.legacySubmit,
}));

const { enqueueHrDomainEvent } = await import("../../src/services/hrDomainEvent.service.js");
const { submitRequisition, updateRequisition } = await import("../../src/services/requisition.service.js");
const { submitRequisition: mgmtSubmit } = await import("../../src/services/requisitionMgmt.service.js");
const { submitRequisition: legacySubmit } = await import("../../src/services/hrContract.service.js");

const submittedEventOf = (nth = 0) => {
  const calls = enqueueHrDomainEvent.mock.calls.filter(([, args]) => args?.eventName === "hr.recruitment.requisition_submitted.v1");
  return calls[nth]?.[1] ?? null;
};
const submittedEventCalls = () =>
  enqueueHrDomainEvent.mock.calls.filter(([, args]) => args?.eventName === "hr.recruitment.requisition_submitted.v1");

// One submit = one centre call, one transition row, one routed event, all on
// the centre's transaction client: the surface wrote neither row itself.
const expectOneCentreSubmit = ({ id, reason, transitionSource, actorId, fromStatus = "DRAFT" }) => {
  expect(centre.legacySubmit).toHaveBeenCalledTimes(1);
  expect(centre.legacySubmit).toHaveBeenCalledWith("REQUISITION", id, reason ?? undefined, {
    requisition: { reason: reason ?? null, transitionSource },
  });
  // The only status move is the centre's flip.
  const flips = prisma.jobRequisition.update.mock.calls.filter(([arg]) => arg?.data && "status" in arg.data);
  expect(flips).toEqual([[{ where: { id }, data: { status: "PENDING_APPROVAL" } }]]);
  expect(prisma.requisitionTransition.create).toHaveBeenCalledTimes(1);
  expect(prisma.requisitionTransition.create.mock.calls[0][0].data).toMatchObject({
    requisitionId: id,
    tenantId: TENANT,
    fromStatus,
    toStatus: "PENDING_APPROVAL",
    reason: reason ?? null,
    actorId,
    source: transitionSource,
  });
  const events = submittedEventCalls();
  expect(events).toHaveLength(1);
  expect(events[0][0]).toBe(prisma);
};

beforeEach(() => {
  jest.clearAllMocks();
  centre.reset();
  prisma.requisitionApprovalRule.findMany.mockResolvedValue([]);
  prisma.employee.findFirst.mockResolvedValue({ managerId: 9 });
});

describe("requisition_submitted routes to the requester's line manager on every submit surface", () => {
  it("management submit routes to the line manager, at stage 1", async () => {
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    centre.arm({ tenantId: TENANT, actorId: 7, row });

    await mgmtSubmit(5, TENANT, 7);

    expectOneCentreSubmit({ id: 5, transitionSource: "requisition.submit", actorId: 7 });
    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload).toMatchObject({
      requisitionId: "5",
      status: "PENDING_APPROVAL",
      requestedById: "1",
      pendingApproverId: "9",
      pendingStepOrder: 1,
    });
    expect(ev.tenantId).toBe(TENANT);
    expect(ev.actorId).toBe(7);
    // The manager was looked up for the requester, inside the tenant.
    expect(prisma.employee.findFirst.mock.calls[0][0].where).toMatchObject({ id: 1, tenant_id: TENANT });
  });

  it("generic PATCH submit (status flip in one call) emits the same routed event", async () => {
    const existing = { id: 8, title: "QA Lead", status: "DRAFT", tenantId: TENANT, version: 3, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ ...existing, status: "PENDING_APPROVAL" });
    prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });
    // The centre loads the requisition as the PATCH left it: still DRAFT, the
    // flip is the centre's own.
    centre.arm({ tenantId: TENANT, actorId: 6, row: existing });

    await updateRequisition(8, { status: "PENDING_APPROVAL" }, 6, TENANT);

    expectOneCentreSubmit({ id: 8, transitionSource: "requisition.update", actorId: 6 });
    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload.pendingApproverId).toBe("9");
    expect(ev.payload.pendingStepOrder).toBe(1);
    expect(ev.actorId).toBe(6);
  });

  it("legacy /api/hr submit emits the same routed event — the audience does not depend on the URL", async () => {
    const row = { id: 12, title: "Ops Analyst", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    centre.arm({ tenantId: TENANT, actorId: 4, row });

    await legacySubmit(12, TENANT, 4, "please review");

    expectOneCentreSubmit({ id: 12, reason: "please review", transitionSource: "requisition.legacy", actorId: 4 });
    const ev = submittedEventOf();
    expect(ev).not.toBeNull();
    expect(ev.payload.pendingApproverId).toBe("9");
    expect(ev.payload.pendingStepOrder).toBe(1);
    expect(ev.actorId).toBe(4);
  });

  it("a configured recruitment matrix does not change the routing", async () => {
    prisma.requisitionApprovalRule.findMany.mockResolvedValue([
      { stepOrder: 1, role: "HR_MANAGER", approverId: 31, isActive: true },
    ]);
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    centre.arm({ tenantId: TENANT, actorId: 7, row });

    await mgmtSubmit(5, TENANT, 7);

    expectOneCentreSubmit({ id: 5, transitionSource: "requisition.submit", actorId: 7 });
    expect(submittedEventOf().payload.pendingApproverId).toBe("9");
    expect(submittedEventOf().payload.pendingStepOrder).toBe(1);
  });

  it("a requester with no line manager routes as null — no invented recipient", async () => {
    prisma.employee.findFirst.mockResolvedValue({ managerId: null });
    const row = { id: 5, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT, ...SUBMITTABLE };
    prisma.jobRequisition.findFirst.mockResolvedValue(row);
    centre.arm({ tenantId: TENANT, actorId: 7, row });

    await mgmtSubmit(5, TENANT, 7);

    expectOneCentreSubmit({ id: 5, transitionSource: "requisition.submit", actorId: 7 });
    const ev = submittedEventOf();
    expect(ev.payload.pendingApproverId).toBeNull();
    expect(ev.payload.pendingStepOrder).toBeNull();
  });

  it("a refusal at the gate emits nothing — no audience for a submit that never happened", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "POSTED", tenantId: TENANT });

    centre.arm({ tenantId: TENANT, actorId: 7, row: { id: 5, status: "POSTED", tenantId: TENANT } });

    await expect(mgmtSubmit(5, TENANT, 7)).rejects.toMatchObject({
      code: "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID",
    });
    // Refused before the centre: no review opened, no row, no event.
    expect(centre.legacySubmit).not.toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
  });
});
