// tests/unit/recruitmentAccessEnforcement.test.js
//
// Phase 1.4 — the scope module is only worth anything if the predicate actually
// reaches the query. These tests assert the WHERE clauses the services issue and
// the masking they apply, so a future refactor cannot quietly drop either.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
  jobRequisition: { findFirst: jest.fn(), findMany: jest.fn() },
  interview: { findMany: jest.fn(), count: jest.fn() },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/services/interview-scorecard.service.js", () => ({
  upsertInterviewScorecard: jest.fn(),
}));

const { getAllRequisitions, getByIdRequisitions } = await import(
  "../../src/services/requisition.service.js"
);
const { listInterviews } = await import("../../src/services/interview.service.js");
const { resolveRecruitmentScope } = await import("../../src/lib/recruitmentAccess.js");

const TENANT = "tenant-a";

const whereOf = (mock) => mock.mock.calls[0][0].where;

beforeEach(() => {
  jest.clearAllMocks();
  prisma.jobRequisition.findMany.mockResolvedValue([]);
  prisma.jobRequisition.findFirst.mockResolvedValue({ id: 1 });
  prisma.interview.findMany.mockResolvedValue([]);
  prisma.interview.count.mockResolvedValue(0);
});

describe("requisition reads are narrowed by record scope", () => {
  it("adds no scope predicate for HR admin", async () => {
    await getAllRequisitions(TENANT, resolveRecruitmentScope({ roles: ["HR_ADMIN"], employeeId: 5 }));

    const where = whereOf(prisma.jobRequisition.findMany);
    expect(where.tenantId).toBe(TENANT);
    expect(where.OR).toBeUndefined();
  });

  it("restricts a hiring manager's list to their own requisitions", async () => {
    await getAllRequisitions(TENANT, resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 5 }));

    expect(whereOf(prisma.jobRequisition.findMany)).toMatchObject({
      tenantId: TENANT,
      OR: [{ requestedById: 5 }, { approvedById: 5 }],
    });
  });

  it("narrows a single requisition read the same way", async () => {
    await getByIdRequisitions(1, TENANT, resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 5 }));

    expect(whereOf(prisma.jobRequisition.findFirst)).toMatchObject({
      id: 1,
      tenantId: TENANT,
      OR: [{ requestedById: 5 }, { approvedById: 5 }],
    });
  });

  it("keeps the tenant-only read for internal callers that pass no scope", async () => {
    await getAllRequisitions(TENANT);

    const where = whereOf(prisma.jobRequisition.findMany);
    expect(where).toEqual({ tenantId: TENANT });
  });

  it("denies an interviewer's requisition reads with an unsatisfiable predicate", async () => {
    await getAllRequisitions(TENANT, resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 5 }));

    expect(whereOf(prisma.jobRequisition.findMany)).toMatchObject({ id: { in: [] } });
  });
});

describe("interview reads are narrowed and masked by record scope", () => {
  const interviewRow = {
    id: 3,
    notes: "Panel was lukewarm",
    application: { id: 9, candidate: { id: 7, firstName: "Ayesha", notes: "Referred by the CTO" } },
  };

  it("filters to the panels an interviewer sits on", async () => {
    await listInterviews({ tenantId: TENANT, scope: resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 5 }) });

    expect(whereOf(prisma.interview.findMany)).toMatchObject({
      tenantId: TENANT,
      interviewers: { some: { employeeId: 5 } },
    });
  });

  it("lets a manager see their own panels AND their requisitions' interviews", async () => {
    await listInterviews({ tenantId: TENANT, scope: resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 5 }) });

    expect(whereOf(prisma.interview.findMany)).toMatchObject({
      OR: [
        { interviewers: { some: { employeeId: 5 } } },
        { application: { jobRequisition: { requestedById: 5 } } },
      ],
    });
  });

  it("masks interviewer notes — and the nested candidate's notes — for an interviewer", async () => {
    prisma.interview.findMany.mockResolvedValue([interviewRow]);

    const result = await listInterviews({
      tenantId: TENANT,
      scope: resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 5 }),
    });

    expect(result.items[0].notes).toBeNull();
    expect(result.items[0].notesRedacted).toBe(true);
    // The nested relation is the easy leak: masking the interview alone is not enough.
    expect(result.items[0].application.candidate.notes).toBeNull();
    expect(result.items[0].application.candidate.firstName).toBe("Ayesha");
  });

  it("leaves notes intact for HR admin and for unscoped internal callers", async () => {
    prisma.interview.findMany.mockResolvedValue([interviewRow]);

    const asAdmin = await listInterviews({
      tenantId: TENANT,
      scope: resolveRecruitmentScope({ roles: ["HR_ADMIN"], employeeId: 5 }),
    });
    expect(asAdmin.items[0].notes).toBe("Panel was lukewarm");

    const unscoped = await listInterviews({ tenantId: TENANT });
    expect(unscoped.items[0].notes).toBe("Panel was lukewarm");
  });
});
