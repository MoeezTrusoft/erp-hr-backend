// tests/unit/applicationAccessEnforcement.test.js
//
// Phase 1.4 (remainder) — the MCP application tools used to reach prisma
// directly:
//
//   prisma.application.findUnique({ where: { id } })   // hr_application_get
//   prisma.application.delete({ where: { id } })       // hr_application_delete
//
// Neither carried a tenant predicate, so ANY caller with the hr:recruitment
// grant could read — or delete — another tenant's application, and with the
// `include` on the GET that meant the candidate's PII, their interviews and the
// offer. Both now go through applicationService, tenant-scoped and row-scoped.
//
// These tests assert the WHERE clauses actually issued (not just the helper) so
// a future refactor back to a bare findUnique fails here.
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

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/application-workflow.service.js", () => ({
  transitionApplicationStage: jest.fn(),
}));

const { getApplication, deleteApplication, listApplications } = await import(
  "../../src/services/application.service.js"
);
const { resolveRecruitmentScope, applicationScopeWhere } = await import(
  "../../src/lib/recruitment-access.util.js"
);

const TENANT = "tenant-a";
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 5 });
const INTERVIEWER = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 9 });
const HR_ADMIN = resolveRecruitmentScope({ roles: ["HR_ADMIN"], employeeId: 1 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 2 });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.count.mockResolvedValue(0);
  prisma.businessUnit.findMany.mockResolvedValue([]);
  prisma.application.delete.mockResolvedValue({ id: 42 });
});

describe("getApplication — tenant + row scoped", () => {
  it("pins BOTH the tenant and the caller's record scope", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    await getApplication({ id: 42, tenantId: TENANT, scope: MANAGER });

    const { where } = prisma.application.findFirst.mock.calls[0][0];
    expect(where).toMatchObject({
      id: 42,
      tenantId: TENANT,
      jobRequisition: { OR: [{ requestedById: 5 }, { approvedById: 5 }] },
    });
  });

  it("never issues a bare findUnique-style id-only read", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    await getApplication({ id: 42, tenantId: TENANT, scope: HR_ADMIN });

    const { where } = prisma.application.findFirst.mock.calls[0][0];
    expect(where.tenantId).toBe(TENANT);
    expect(where.id).toBe(42);
  });

  it("keeps the include that made the leak serious (candidate + interviews + offer)", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    await getApplication({ id: 42, tenantId: TENANT });

    expect(prisma.application.findFirst.mock.calls[0][0].include).toMatchObject({
      candidate: true,
      interviews: true,
      offer: true,
    });
  });

  it("rejects a non-numeric id without touching the database", async () => {
    await expect(getApplication({ id: "not-an-id", tenantId: TENANT })).resolves.toBeNull();
    expect(prisma.application.findFirst).not.toHaveBeenCalled();
  });

  it("denies a finance reviewer with an unsatisfiable predicate", async () => {
    await getApplication({ id: 42, tenantId: TENANT, scope: FINANCE });

    expect(prisma.application.findFirst.mock.calls[0][0].where).toMatchObject({ id: { in: [] } });
  });

  it("lets an interviewer reach only applications they sit on a panel for", async () => {
    await getApplication({ id: 42, tenantId: TENANT, scope: INTERVIEWER });

    expect(prisma.application.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: TENANT,
      interviews: { some: { interviewers: { some: { employeeId: 9 } } } },
    });
  });

  it("a cross-tenant id reads as null (not found), so the caller learns nothing", async () => {
    prisma.application.findFirst.mockResolvedValue(null);

    await expect(getApplication({ id: 7, tenantId: TENANT, scope: HR_ADMIN })).resolves.toBeNull();
  });
});

describe("deleteApplication — refuses anything the caller does not own", () => {
  it("does NOT delete when the scoped lookup finds nothing", async () => {
    prisma.application.findFirst.mockResolvedValue(null);

    await expect(
      deleteApplication({ id: 42, tenantId: TENANT, scope: MANAGER })
    ).resolves.toBeNull();
    expect(prisma.application.delete).not.toHaveBeenCalled();
  });

  it("issues a tenant + scope predicate before deleting anything", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    await deleteApplication({ id: 42, tenantId: TENANT, scope: MANAGER });

    expect(prisma.application.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 42,
      tenantId: TENANT,
      jobRequisition: { OR: [{ requestedById: 5 }, { approvedById: 5 }] },
    });
  });

  it("deletes only the verified row, by its own id", async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 42 });
    await expect(
      deleteApplication({ id: 42, tenantId: TENANT, scope: HR_ADMIN })
    ).resolves.toBe(42);

    expect(prisma.application.delete).toHaveBeenCalledTimes(1);
    expect(prisma.application.delete.mock.calls[0][0]).toEqual({ where: { id: 42 } });
  });
});

describe("listApplications — tenant + scope predicates", () => {
  it("scopes both the page query and the count", async () => {
    await listApplications({ tenantId: TENANT, scope: MANAGER, page: 1, limit: 20 });

    const expected = {
      tenantId: TENANT,
      jobRequisition: { OR: [{ requestedById: 5 }, { approvedById: 5 }] },
    };
    expect(prisma.application.findMany.mock.calls[0][0].where).toMatchObject(expected);
    expect(prisma.application.count.mock.calls[0][0].where).toMatchObject(expected);
  });

  it("stays tenant-only for internal callers that pass no scope", async () => {
    await listApplications({ tenantId: TENANT });

    expect(prisma.application.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
  });

  it("returns an empty page rather than another tenant's rows when the tenant is absent", async () => {
    await listApplications({ tenantId: null });

    const { where } = prisma.application.findMany.mock.calls[0][0];
    expect(where.tenantId).toBeNull();
  });
});

describe("applicationScopeWhere — scope matrix", () => {
  it("is empty for the organisation-wide scope", () => {
    expect(applicationScopeWhere(HR_ADMIN)).toEqual({});
  });

  it("matches nothing for finance and agency scopes", () => {
    expect(applicationScopeWhere(FINANCE)).toEqual({ id: { in: [] } });
  });

  it("reaches a manager's own requisitions through the jobRequisition relation", () => {
    expect(applicationScopeWhere(MANAGER)).toEqual({
      jobRequisition: { OR: [{ requestedById: 5 }, { approvedById: 5 }] },
    });
  });
});
