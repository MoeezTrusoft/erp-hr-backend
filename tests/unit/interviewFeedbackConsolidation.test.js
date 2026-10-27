// tests/unit/interviewFeedbackConsolidation.test.js
//
// Phase 3.4 (remainder) — hiring-manager consolidation + outstanding feedback.
//
// Two gaps were closed together and both are asserted here:
//
//   1. The panel's feedback existed only as N separate scorecards. Nothing showed
//      reviewers disagreeing about the SAME criterion, and nothing gave the hiring
//      manager one comparable view.
//   2. The outcome gate only asked "is there AT LEAST ONE scorecard?", so a
//      four-person panel was decidable by one reviewer with three silent, and the
//      outcome path reported nothing about who had not been heard from.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockLogAction = jest.fn(async () => undefined);

const prisma = {
  interview: {
    findFirst: jest.fn(),
    update: jest.fn(async () => ({ id: 1 })),
  },
  interviewScorecard: { count: jest.fn() },
  outboxEvent: { create: jest.fn(async () => ({ id: 1 })) },
  $transaction: jest.fn((fn) => fn(prisma)),
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
jest.unstable_mockModule("../../src/services/interview-scorecard.service.js", () => ({
  upsertInterviewScorecard: jest.fn(),
}));

const { consolidateInterviewFeedback, setInterviewOutcome } = await import(
  "../../src/services/interview-mgmt.service.js"
);

const TENANT = "22222222-2222-4222-8222-222222222222";

// A three-person panel: two have submitted (and disagree on problemSolving), one
// has not been heard from at all.
const panelInterview = {
  id: 33,
  status: "SCHEDULED",
  decision: null,
  durationMinutes: 60,
  interviewType: "PANEL",
  location: "Room 3",
  scheduledAt: new Date("2026-09-20T09:00:00.000Z"),
  notes: null,
  interviewers: [
    { status: "CONFIRMED", employee: { id: 8, employee_name: "Sara Malik" } },
    { status: "CONFIRMED", employee: { id: 15, employee_name: "Omar Raza" } },
    { status: "PENDING", employee: { id: 12, employee_name: "Bilal Ahmed" } },
  ],
  application: {
    candidate: { firstName: "Ayesha", lastName: "Khan" },
    jobRequisition: { title: "Senior Backend Engineer" },
  },
  scorecards: [
    {
      reviewerId: 8,
      reviewer: { id: 8, first_name: "Sara", last_name: "Malik" },
      scores: { technicalSkills: 5, problemSolving: 4, communication: 5, cultureFit: 5 },
      overallScore: 4.75,
      recommendation: "STRONG_HIRE",
      notes: "Strong on system design",
      submittedAt: new Date("2026-09-20T09:41:10.000Z"),
      amendmentLog: null,
      lastAmendedAt: null,
    },
    {
      reviewerId: 15,
      reviewer: { id: 15, first_name: "Omar", last_name: "Raza" },
      scores: { technicalSkills: 4, problemSolving: 2, communication: 5, cultureFit: 4 },
      overallScore: 3.75,
      recommendation: "HIRE",
      notes: "Weaker on trade-off reasoning",
      submittedAt: new Date("2026-09-20T09:12:44.000Z"),
      amendmentLog: [{ at: "2026-09-20T10:02:19.330Z", by: 15, reason: "corrected score" }],
      lastAmendedAt: new Date("2026-09-20T10:02:19.330Z"),
    },
    {
      reviewerId: 12,
      reviewer: { id: 12, first_name: "Bilal", last_name: "Ahmed" },
      scores: { technicalSkills: 1, problemSolving: 1, communication: 1, cultureFit: 1 },
      overallScore: 1,
      recommendation: "REJECTED",
      notes: "never finished the call",
      // Never submitted: a row, but not evidence.
      submittedAt: null,
      amendmentLog: null,
      lastAmendedAt: null,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.interview.findFirst.mockResolvedValue(panelInterview);
  prisma.interview.update.mockResolvedValue({ id: 33 });
});

describe("Phase 3.4 — hiring-manager consolidation", () => {
  it("consolidates only SUBMITTED scorecards — an unsubmitted row is not evidence", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.submittedCount).toBe(2);
    expect(out.reviewers.map((r) => r.reviewerId)).toEqual([8, 15]);
    // The unsubmitted reviewer's scorecard must not skew a single average.
    expect(out.criteria.technicalSkills.average).toBe(4.5);
    expect(out.criteria.technicalSkills.values).toHaveLength(2);
    expect(out.averageOverall).toBe(4.25);
  });

  it("attributes every criterion value to the reviewer who gave it", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.criteria.problemSolving.values).toEqual([
      { reviewerId: 8, reviewer: "Sara Malik", value: 4 },
      { reviewerId: 15, reviewer: "Omar Raza", value: 2 },
    ]);
  });

  it("surfaces disagreement on the same criterion without deciding anything", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.criteria.problemSolving).toMatchObject({ min: 2, max: 4, spread: 2 });
    expect(out.divergentCriteria).toEqual(["problemSolving"]);
    expect(out.advisory).toContain("problemSolving");
    // Reporting only: no field in this payload approves, rejects or blocks.
    expect(out).not.toHaveProperty("approved");
    expect(out).not.toHaveProperty("blocked");
  });

  it("does not flag a criterion the panel agreed on", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.criteria.communication.spread).toBe(0);
    expect(out.divergentCriteria).not.toContain("communication");
  });

  it("reports the panel members who have not submitted", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.feedback).toMatchObject({
      panelSize: 3,
      submittedCount: 2,
      outstandingCount: 1,
      allPanelHeard: false,
    });
    expect(out.feedback.outstanding).toEqual([
      { interviewerId: 12, name: "Bilal Ahmed", status: "PENDING" },
    ]);
  });

  it("shows a scorecard amended after submission rather than hiding it", async () => {
    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    const amended = out.reviewers.find((r) => r.reviewerId === 15);
    expect(amended.amendmentCount).toBe(1);
    expect(amended.amendedAt).toBeInstanceOf(Date);
    // The original submission time is preserved, so the lock is still visible.
    expect(amended.submittedAt).toBeInstanceOf(Date);
  });

  it("counts recommendations, including a reviewer who left one blank", async () => {
    prisma.interview.findFirst.mockResolvedValue({
      ...panelInterview,
      scorecards: [
        panelInterview.scorecards[0],
        { ...panelInterview.scorecards[1], recommendation: null },
      ],
    });

    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.recommendations).toEqual({ STRONG_HIRE: 1, UNSPECIFIED: 1 });
  });

  it("reports nulls — not zeros — when nothing has been scored yet", async () => {
    prisma.interview.findFirst.mockResolvedValue({ ...panelInterview, scorecards: [] });

    const out = await consolidateInterviewFeedback({ id: 33, tenantId: TENANT });

    expect(out.criteria.technicalSkills.average).toBeNull();
    expect(out.criteria.technicalSkills.spread).toBeNull();
    expect(out.averageOverall).toBeNull();
    expect(out.recommendations).toEqual({});
    expect(out.divergentCriteria).toEqual([]);
    expect(out.advisory).toBeNull();
    // An empty panel is not agreement — submittedCount says so.
    expect(out.feedback).toMatchObject({ panelSize: 3, submittedCount: 0, outstandingCount: 3 });
  });

  it("is tenant-scoped: a cross-tenant interview is not found", async () => {
    prisma.interview.findFirst.mockResolvedValue(null);

    await expect(consolidateInterviewFeedback({ id: 99, tenantId: TENANT })).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.interview.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
  });
});

describe("Phase 3.4 — the outcome gate requires SUBMITTED evidence", () => {
  it("counts only submitted scorecards", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(1);

    await setInterviewOutcome({ interviewId: 33, decision: "NEXT_ROUND", tenantId: TENANT, actorId: 5 });

    expect(prisma.interviewScorecard.count.mock.calls[0][0].where).toMatchObject({
      interviewId: 33,
      submittedAt: { not: null },
    });
  });

  it("stamps the outcome with who has not been heard from, without blocking", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(2);

    await setInterviewOutcome({ interviewId: 33, decision: "NEXT_ROUND", tenantId: TENANT, actorId: 5 });

    const { data } = prisma.interview.update.mock.calls[0][0];
    expect(data.decision).toBe("NEXT_ROUND");
    expect(data.notes).toContain("Outstanding panel feedback (1): Bilal Ahmed");
  });

  it("says nothing about outstanding feedback when the whole panel has submitted", async () => {
    // Every panel member has submitted: drop the silent third member as well, so
    // this case really is "the whole panel was heard".
    prisma.interview.findFirst.mockResolvedValue({
      ...panelInterview,
      interviewers: panelInterview.interviewers.filter((i) => i.employee.id !== 12),
      scorecards: panelInterview.scorecards.filter((c) => c.submittedAt),
    });
    prisma.interviewScorecard.count.mockResolvedValue(2);

    await setInterviewOutcome({ interviewId: 33, decision: "NEXT_ROUND", tenantId: TENANT, actorId: 5 });

    const { data } = prisma.interview.update.mock.calls[0][0];
    expect(data.notes).not.toContain("Outstanding panel feedback");
  });
});
