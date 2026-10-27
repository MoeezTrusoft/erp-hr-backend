import { jest, describe, it, expect, beforeEach } from "@jest/globals";
const prisma = {
  application: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
  },
  businessUnit: { findMany: jest.fn() },
};
let ctx;
const context = (role = "HR_ADMIN", employeeId = 1) => ({
  actorVerified: true,
  user: { tenantId: "tenant-a", employeeId, roles: [role] },
  permissions: [
    "hr.recruitment.read",
    "hr.recruitment.update",
    "hr.recruitment.delete",
  ],
});
jest.unstable_mockModule("../../src/config/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/mcp/context.js", () => ({
  getCtx: () => ctx,
}));
jest.unstable_mockModule("../../src/services/separation/base.js", () => ({
  actor: async () => ({ id: ctx.user.employeeId }),
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({
  logAction: jest.fn(async () => {}),
}));
jest.unstable_mockModule(
  "../../src/services/applicationWorkflow.service.js",
  () => ({ transitionApplicationStage: jest.fn() }),
);
const {
  getApplication,
  deleteApplication,
  listApplications,
  updateApplicationStage,
  createApplication,
} = await import("../../src/services/applicationService.js");
const { resolveRecruitmentScope, applicationScopeWhere } =
  await import("../../src/lib/recruitmentAccess.js");
const tenantId = "tenant-a",
  owned = {
    jobRequisition: {
      OR: [{ requestedById: 5 }, { approvedById: 5 }, { recruiterId: 5 }],
    },
  };
beforeEach(() => {
  jest.clearAllMocks();
  ctx = context();
  prisma.application.findFirst.mockResolvedValue(null);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.count.mockResolvedValue(0);
  prisma.businessUnit.findMany.mockResolvedValue([]);
  prisma.application.delete.mockResolvedValue({ id: 42 });
});
describe("application read ownership and sensitive fields", () => {
  it("uses the verified manager scope even if the caller supplies an unrestricted scope", async () => {
    ctx = context("HIRING_MANAGER", 5);
    prisma.application.findFirst.mockResolvedValue({
      id: 42,
      candidate: { id: 2, notes: "private" },
      interviews: [{ id: 3, notes: "private panel notes" }],
      offer: {
        salary: 400,
        compensation: { baseSalary: 400 },
        offerLetterMediaId: 9,
        notes: "private offer",
      },
    });
    const row = await getApplication({
      id: 42,
      tenantId,
      scope: { unrestricted: true },
    });
    expect(prisma.application.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 42,
      tenantId,
      ...owned,
    });
    expect(row.candidate.notes).toBeNull();
    expect(row.interviews[0].notes).toBeNull();
    expect(row.offer.salary).toBeNull();
    expect(row.offer.compensation).toBeNull();
    expect(row.offer.offerLetterMediaId).toBeNull();
    expect(row.offer.notes).toBeNull();
  });
  it("retains authorized recruiter notes and pins tenant on every lookup", async () => {
    prisma.application.findFirst.mockResolvedValue({
      id: 42,
      candidate: { notes: "review" },
    });
    const row = await getApplication({ id: 42, tenantId });
    expect(row.candidate.notes).toBe("review");
    expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
      id: 42,
      tenantId,
    });
  });
  it("returns null for an unknown application and does not query invalid ids", async () => {
    expect(await getApplication({ id: 42, tenantId })).toBeNull();
    prisma.application.findFirst.mockClear();
    expect(await getApplication({ id: "bad", tenantId })).toBeNull();
    expect(prisma.application.findFirst).not.toHaveBeenCalled();
  });
  it("limits interviewers to assigned panels and never returns their offers", async () => {
    ctx = context("INTERVIEWER", 9);
    prisma.application.findFirst.mockResolvedValue({
      id: 42,
      candidate: { notes: "private" },
      offer: { salary: 500 },
    });
    const row = await getApplication({ id: 42, tenantId });
    expect(
      prisma.application.findFirst.mock.calls[0][0].where.interviews,
    ).toEqual({ some: { interviewers: { some: { employeeId: 9 } } } });
    expect(
      prisma.application.findFirst.mock.calls[0][0].include.interviews.where
        .interviewers,
    ).toEqual({ some: { employeeId: 9 } });
    expect(row.offer).toBeNull();
  });
  it.each(["FINANCE", "UNKNOWN", "AGENCY"])(
    "denies %s general application access",
    async (role) => {
      ctx = context(role);
      await expect(getApplication({ id: 42, tenantId })).rejects.toMatchObject({
        status: 403,
      });
      expect(prisma.application.findFirst).not.toHaveBeenCalled();
    },
  );
  it("denies unverified identities and tenant substitutions", async () => {
    ctx.actorVerified = false;
    await expect(getApplication({ id: 42, tenantId })).rejects.toMatchObject({
      status: 403,
    });
    ctx = context();
    await expect(
      getApplication({ id: 42, tenantId: "other" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
describe("application mutations", () => {
  it("rejects manager creation and spoofed creator identities before any write", async () => {
    ctx = context("HIRING_MANAGER", 5);
    ctx.permissions.push("hr.recruitment.create");
    await expect(
      createApplication({
        tenantId,
        candidateId: 2,
        jobRequisitionId: 3,
        createdById: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("managers cannot delete applications or confirm pipeline stages", async () => {
    ctx = context("HIRING_MANAGER", 5);
    await expect(deleteApplication({ id: 42, tenantId })).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      updateApplicationStage({ id: 42, tenantId, stage: "screening" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.application.delete).not.toHaveBeenCalled();
  });
  it("deletes only an owned row found with the verified tenant", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    expect(await deleteApplication({ id: 42, tenantId })).toBe(42);
    expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
      id: 42,
      tenantId,
    });
    expect(prisma.application.delete).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });
  it("does not delete an absent or out-of-tenant row", async () => {
    expect(await deleteApplication({ id: 42, tenantId })).toBeNull();
    expect(prisma.application.delete).not.toHaveBeenCalled();
  });
});
describe("application lists", () => {
  it("uses owned requisitions, bounded pagination and masked notes", async () => {
    ctx = context("HIRING_MANAGER", 5);
    prisma.application.findMany.mockResolvedValue([
      { id: 42, candidate: { notes: "internal" } },
    ]);
    prisma.application.count.mockResolvedValue(1);
    const page = await listApplications({ tenantId, page: -5, limit: 500 });
    expect(page.page).toBe(1);
    expect(page.limit).toBe(100);
    expect(page.items[0].candidate.notes).toBeNull();
    expect(prisma.application.findMany.mock.calls[0][0].where).toEqual({
      tenantId,
      ...owned,
    });
  });
  it("does not let a supplied scope override the verified actor", async () => {
    ctx = context("INTERVIEWER", 9);
    await listApplications({ tenantId, scope: { unrestricted: true } });
    expect(
      prisma.application.findMany.mock.calls[0][0].where.interviews,
    ).toEqual({ some: { interviewers: { some: { employeeId: 9 } } } });
  });
  it("keeps the pure role matrix closed", () => {
    expect(
      applicationScopeWhere(
        resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 5 }),
      ),
    ).toEqual(owned);
    for (const roles of [["FINANCE"], ["AGENCY"], ["UNKNOWN"]])
      expect(
        applicationScopeWhere(
          resolveRecruitmentScope({ roles, employeeId: 1 }),
        ),
      ).toEqual({ id: { in: [] } });
  });
});
