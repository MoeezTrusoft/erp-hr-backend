// The recruitment list reads behind hr://recruitment/* return what a list
// needs and no more: names (not full Employee rows) on requisitions, no parsed
// resume on embedded candidates, candidate notes masked on applications, and
// an interviewer sees only their own scorecard until consolidation.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = {
  jobRequisition: { findMany: jest.fn(async () => []) },
  candidate: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  application: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  interview: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  offer: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  businessUnit: { findMany: jest.fn(async () => []) },
};
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));

const { getAllRequisitions, REQUISITION_LIST_LIMIT } = await import("../../../src/services/requisition.service.js");
const { listCandidates } = await import("../../../src/services/candidateService.js");
const { listApplications } = await import("../../../src/services/applicationService.js");
const { listInterviews } = await import("../../../src/services/interview.service.js");
const { listOffers } = await import("../../../src/services/offer.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORG = resolveRecruitmentScope({ isAdmin: true, roles: [] });
const INTERVIEWER = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 8 });

beforeEach(() => jest.clearAllMocks());

describe("requisition list", () => {
  it("selects the people on a requisition by name only, and is bounded", async () => {
    await getAllRequisitions(TENANT, ORG);
    const args = db.jobRequisition.findMany.mock.calls[0][0];
    for (const relation of ["requestedBy", "approvedBy", "employee"]) {
      expect(args.include[relation].select).toBeDefined();
      expect(args.include[relation].select).not.toHaveProperty("nationality_id_no");
      expect(args.include[relation].select).not.toHaveProperty("date_of_birth");
      expect(args.include[relation].select).toMatchObject({ first_name: true, last_name: true });
    }
    expect(args.take).toBe(REQUISITION_LIST_LIMIT);
  });
});

describe("parsed resume stays on the candidate detail read", () => {
  it("is omitted from the candidate list", async () => {
    await listCandidates({ tenantId: TENANT, scope: ORG });
    expect(db.candidate.findMany.mock.calls[0][0].omit).toEqual({ parsedResume: true });
  });

  it("is omitted from candidates embedded in applications, interviews and offers", async () => {
    await listApplications({ tenantId: TENANT, scope: ORG });
    await listInterviews({ tenantId: TENANT, scope: ORG });
    await listOffers({ tenantId: TENANT, scope: ORG });
    expect(db.application.findMany.mock.calls[0][0].include.candidate).toEqual({ omit: { parsedResume: true } });
    expect(db.interview.findMany.mock.calls[0][0].include.application.include.candidate).toEqual({
      omit: { parsedResume: true },
    });
    expect(db.offer.findMany.mock.calls[0][0].include.candidate).toEqual({ omit: { parsedResume: true } });
  });
});

describe("application list masking", () => {
  it("masks the embedded candidate's internal notes for an interviewer", async () => {
    db.application.findMany.mockResolvedValueOnce([
      { id: 1, candidate: { id: 2, notes: "recruiter only" }, jobRequisition: { id: 3 } },
    ]);
    const { items } = await listApplications({ tenantId: TENANT, scope: INTERVIEWER });
    expect(items[0].candidate).toMatchObject({ notes: null, notesRedacted: true });
  });

  it("leaves a recruiter's view unmasked", async () => {
    db.application.findMany.mockResolvedValueOnce([
      { id: 1, candidate: { id: 2, notes: "recruiter only" }, jobRequisition: { id: 3 } },
    ]);
    const { items } = await listApplications({ tenantId: TENANT, scope: ORG });
    expect(items[0].candidate.notes).toBe("recruiter only");
  });
});

describe("independent scoring on the interview list", () => {
  const PANEL = [
    { id: 351, application: {}, scorecards: [{ reviewerId: 8, overallScore: 4 }, { reviewerId: 9, overallScore: 2 }] },
  ];

  it("shows an interviewer only their own scorecard", async () => {
    db.interview.findMany.mockResolvedValueOnce(PANEL);
    const { items } = await listInterviews({ tenantId: TENANT, scope: INTERVIEWER });
    expect(items[0].scorecards).toEqual([{ reviewerId: 8, overallScore: 4 }]);
  });

  it("shows a recruiter the whole panel", async () => {
    db.interview.findMany.mockResolvedValueOnce(PANEL);
    const { items } = await listInterviews({ tenantId: TENANT, scope: ORG });
    expect(items[0].scorecards).toHaveLength(2);
  });
});
