// Candidate 360 (F-14): one read across the candidate's applications, cut to
// the caller's recruitment scope with the same predicates and masks the list
// endpoints use.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = {
  candidate: { findFirst: jest.fn() },
  application: { findMany: jest.fn() },
  offer: { findMany: jest.fn() },
  candidateConsent: { findMany: jest.fn() },
  candidateLegalHold: { findFirst: jest.fn() },
  aiInferenceRecord: { findMany: jest.fn() },
};
const findActiveDnc = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ findActiveDnc }));

const { getCandidate360 } = await import("../../../src/services/candidate-360.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORG = resolveRecruitmentScope({ isAdmin: true, roles: [] });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });

const CANDIDATE = {
  id: 77,
  firstName: "Zoe",
  lastName: "Khan",
  email: "zoe@example.com",
  phone: "+92 300 0000000",
  source: "Referral",
  location: "Lahore",
  status: "ACTIVE",
  notes: "Strong referral from the sales lead",
  consentStatus: "GRANTED",
  resumeMediaId: 500,
  retentionUntil: new Date("2027-06-01T00:00:00Z"),
  tags: [{ tag: { name: "B2B" } }],
  candidateSkills: [{ name: "Negotiation" }],
  talentPools: [{ id: 3, poolName: "Sales bench", addedAt: new Date("2026-06-01T00:00:00Z") }],
};
const APPLICATION = {
  id: 901,
  candidateId: 77,
  jobRequisitionId: 9,
  stage: "interview",
  status: "open",
  appliedAt: new Date("2026-06-10T00:00:00Z"),
  updatedAt: new Date("2026-06-20T00:00:00Z"),
  jobRequisition: { id: 9, title: "Sales Lead", status: "POSTED" },
  stageHistory: [
    { fromStage: "applied", toStage: "screening", reason: null, source: "recruiter", actorId: 5, createdAt: new Date("2026-06-12T00:00:00Z") },
    { fromStage: "screening", toStage: "interview", reason: null, source: "recruiter", actorId: 5, createdAt: new Date("2026-06-15T00:00:00Z") },
  ],
  screenings: [{ outcome: "ADVANCE", reasonCode: null, scoreOverall: 4.2, reviewedAt: new Date("2026-06-14T00:00:00Z") }],
  interviews: [
    {
      id: 351,
      applicationId: 901,
      interviewType: "TECHNICAL",
      status: "COMPLETED",
      scheduledAt: new Date("2026-06-22T10:00:00Z"),
      durationMinutes: 60,
      decision: null,
      scorecards: [
        { reviewerId: 8, overallScore: 4, recommendation: "HIRE", submittedAt: new Date("2026-06-22T12:00:00Z") },
        { reviewerId: 9, overallScore: 3, recommendation: "LEAN_HIRE", submittedAt: new Date("2026-06-22T13:00:00Z") },
        { reviewerId: 10, overallScore: 1, recommendation: null, submittedAt: null },
      ],
    },
  ],
};
const OFFER = {
  id: 371, applicationId: 901, candidateId: 77, jobRequisitionId: 9, status: "SENT",
  salary: "250000", currency: "PKR", compensation: { base: 250000 }, offerLetterMediaId: 600,
  sentAt: new Date("2026-06-25T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  db.candidate.findFirst.mockResolvedValue(CANDIDATE);
  db.application.findMany.mockResolvedValue([APPLICATION]);
  db.offer.findMany.mockResolvedValue([OFFER]);
  db.candidateConsent.findMany.mockResolvedValue([
    { id: 1, purpose: "PROCESSING", status: "GRANTED", policyVersion: "2026-01", source: "PORTAL", occurredAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  db.candidateLegalHold.findFirst.mockResolvedValue({ placedAt: new Date("2026-06-30T00:00:00Z"), reason: "Litigation" });
  db.aiInferenceRecord.findMany.mockResolvedValue([{ id: 4, kind: "RESUME_PARSE", status: "OK", confidence: 0.9 }]);
  findActiveDnc.mockResolvedValue({ reasonCode: "CANDIDATE_REQUEST", scope: "ALL", effectiveFrom: new Date("2026-07-01T00:00:00Z"), expiresAt: null });
});

describe("getCandidate360", () => {
  it("assembles every section for a recruiter, tenant-scoped", async () => {
    const view = await getCandidate360({ candidateId: "77", tenantId: TENANT, scope: ORG });

    expect(db.candidate.findFirst.mock.calls[0][0].where).toMatchObject({ id: 77, tenantId: TENANT });
    expect(db.application.findMany.mock.calls[0][0].where).toMatchObject({ candidateId: 77, tenantId: TENANT });
    expect(db.offer.findMany.mock.calls[0][0].where).toMatchObject({ candidateId: 77, tenantId: TENANT });

    expect(view.candidate).toMatchObject({ id: 77, name: "Zoe Khan", notes: "Strong referral from the sales lead", tags: ["B2B"], skills: ["Negotiation"] });
    expect(view.applications[0]).toMatchObject({
      id: 901,
      requisition: { id: 9, title: "Sales Lead" },
      screening: { outcome: "ADVANCE", scoreOverall: 4.2 },
    });
    expect(view.applications[0].stageHistory.map((h) => h.toStage)).toEqual(["screening", "interview"]);
    // Unsubmitted scorecards are drafts, not evidence.
    expect(view.applications[0].interviews[0].scorecards).toHaveLength(2);
    expect(view.applications[0].interviews[0].averageScore).toBe(3.5);
    expect(view.offers[0]).toMatchObject({ id: 371, salary: "250000" });
    expect(view.documents).toEqual([
      { type: "resume", mediaId: 500 },
      { type: "offer_letter", mediaId: 600, offerId: 371 },
    ]);
    expect(view.summary).toMatchObject({ applications: 1, activeApplications: 1, interviews: 1, offers: 1, averageInterviewScore: 3.5 });
    expect(view.privacy.consents).toHaveLength(1);
    expect(view.viewer).toEqual({ scope: "ORG", recruiter: true });
    expect(view.privacy.doNotContact).toMatchObject({ active: true, reasonCode: "CANDIDATE_REQUEST" });
    expect(view.privacy.legalHold).toMatchObject({ active: true, reason: "Litigation" });
    expect(view.aiRecords).toHaveLength(1);
  });

  it("cuts a hiring manager's view to their requisitions and masks notes, pay and privacy reasons", async () => {
    const view = await getCandidate360({ candidateId: 77, tenantId: TENANT, scope: MANAGER });

    expect(db.candidate.findFirst.mock.calls[0][0].where).toMatchObject({
      applications: { some: { jobRequisition: { requestedById: 42 } } },
    });
    expect(db.application.findMany.mock.calls[0][0].where.jobRequisition).toBeDefined();
    expect(db.offer.findMany.mock.calls[0][0].where).toMatchObject({
      application: { jobRequisition: { requestedById: 42 } },
    });
    expect(db.candidateConsent.findMany).not.toHaveBeenCalled();

    expect(view.candidate.notes).toBe("Strong referral from the sales lead"); // MANAGED may read notes
    expect(view.offers[0]).toMatchObject({ salary: null, currency: null, compensation: null, compensationRedacted: true });
    expect(view.privacy.consents).toBeUndefined();
    expect(view.viewer).toEqual({ scope: "MANAGED", recruiter: false });
    expect(view.privacy.retentionUntil).toBeUndefined();
    expect(view.privacy.doNotContact).toEqual({ active: true });
    expect(view.privacy.legalHold).toEqual({ active: true });
  });

  it("is not found for a scope that reads no candidates, before any query", async () => {
    await expect(getCandidate360({ candidateId: 77, tenantId: TENANT, scope: FINANCE })).rejects.toMatchObject({
      status: 404,
      code: "HR-RECRUITMENT-CANDIDATE-NOT-FOUND",
    });
    expect(db.candidate.findFirst).not.toHaveBeenCalled();
  });

  it("is not found when the candidate is outside the tenant or scope", async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    await expect(getCandidate360({ candidateId: 77, tenantId: TENANT, scope: ORG })).rejects.toMatchObject({ status: 404 });
    expect(db.application.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed id and a missing tenant", async () => {
    await expect(getCandidate360({ candidateId: "x", tenantId: TENANT, scope: ORG })).rejects.toMatchObject({ status: 400 });
    await expect(getCandidate360({ candidateId: 77, tenantId: null, scope: ORG })).rejects.toMatchObject({ status: 403 });
  });

  it("reports clear flags when there is no DNC entry or legal hold", async () => {
    findActiveDnc.mockResolvedValue(null);
    db.candidateLegalHold.findFirst.mockResolvedValue(null);
    const view = await getCandidate360({ candidateId: 77, tenantId: TENANT, scope: ORG });
    expect(view.privacy.doNotContact).toEqual({ active: false });
    expect(view.privacy.legalHold).toEqual({ active: false });
  });
});
