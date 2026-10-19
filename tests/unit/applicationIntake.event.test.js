// tests/unit/applicationIntake.event.test.js
//
// D-09 — application_created used to be emitted only by the public portal, so
// a recruiter-created application (or one moved in from the talent pool)
// arrived silently. Pinned: the recruiter intake emits the event in its
// transaction, with the hiring manager routed from the requisition, and
// records which path created the application.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const requisition = { id: 4, tenantId: TENANT, status: "POSTED", requestedById: 21, postings: [{ channel: "CAREER_SITE", isActive: true }] };
const prisma = {
  jobRequisition: { findFirst: jest.fn(async () => requisition) },
  application: {
    create: jest.fn(async ({ data }) => ({ id: 30, ...data, jobRequisition: requisition, candidate: { id: data.candidateId } })),
  },
  applicationStageHistory: { create: jest.fn(async () => ({ id: 1 })) },
};
const enqueueHrDomainEvent = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(prisma)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));

const { createApplication } = await import("../../src/services/applicationService.js");

describe("recruiter application intake", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits application_created, routed to the requisition's hiring manager", async () => {
    await createApplication({ candidateId: "5", jobRequisitionId: "4", tenantId: TENANT, createdById: 9 });

    const [, event] = enqueueHrDomainEvent.mock.calls[0];
    expect(event.eventName).toBe("hr.recruitment.application_created.v1");
    expect(event.tenantId).toBe(TENANT);
    expect(event.payload).toMatchObject({ applicationId: "30", candidateId: "5", jobRequisitionId: "4", requestedById: "21" });
  });

  it("records the intake path on the initial stage-history row", async () => {
    await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, createdById: 9, source: "talent-pool" });

    expect(prisma.applicationStageHistory.create.mock.calls[0][0].data).toMatchObject({ source: "talent-pool", toStage: "applied" });
  });

  it("refuses a requisition that is not accepting applications, and emits nothing", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValueOnce({ ...requisition, status: "CLOSED" });

    await expect(createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-APPLICATIONS-CLOSED" });
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
  });
});
