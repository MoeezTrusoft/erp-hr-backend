// tests/unit/talentPoolMoveToPipeline.test.js
//
// D-09 — moving a pool member into a requisition used to call
// prisma.application.create directly, skipping the eligibility gate, the stage
// history and the application_created event. It now goes through the
// recruiter intake, which owns all three.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const prisma = { application: { findFirst: jest.fn(), create: jest.fn() } };
const createApplication = jest.fn(async (args) => ({ id: 31, ...args }));

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/services/applicationService.js", () => ({ createApplication }));

const { moveToPipeline } = await import("../../src/services/talentPoolMgmt.service.js");

describe("talent pool move to pipeline", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates the application through the gated recruiter intake", async () => {
    prisma.application.findFirst.mockResolvedValue(null);

    const result = await moveToPipeline({ candidateId: "5", jobRequisitionId: "4", tenantId: TENANT, addedById: 9 });

    expect(result.created).toBe(true);
    expect(createApplication).toHaveBeenCalledWith({
      candidateId: 5,
      jobRequisitionId: 4,
      tenantId: TENANT,
      createdById: 9,
      source: "talent-pool",
    });
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it("returns the existing application instead of creating a second one", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 12 });

    const result = await moveToPipeline({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT });

    expect(result).toEqual({ created: false, application: { id: 12 } });
    expect(createApplication).not.toHaveBeenCalled();
  });
});
