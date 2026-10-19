// tests/unit/interviewScorecardLock.test.js
//
// Phase 3.4 (remainder) — a SUBMITTED interview scorecard is locked.
//
// The pipeline prerequisites (evidence before a decisive outcome) were enforced,
// but the evidence itself stayed freely re-writable: a reviewer could rewrite a
// rating after the hiring decision and leave no trace. These tests pin the three
// outcomes of the rule — first submit writes, an identical resubmit is a no-op,
// a changed payload is refused unless an amendment reason is supplied — plus the
// fact that the amendment trail is APPENDED and the original submittedAt kept.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
  interviewScorecard: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/mcp/context.js", () => {
  const store = { value: undefined };
  const mcpCtx = {
    run: (ctx, fn) => {
      const previous = store.value;
      store.value = ctx;
      try {
        return fn();
      } finally {
        store.value = previous;
      }
    },
    getStore: () => store.value,
  };
  return { mcpCtx, mcpRequestContext: mcpCtx };
});

const { upsertInterviewScorecard, scorecardPayloadChanged } = await import(
  "../../src/services/interview-scorecard.service.js"
);

const TENANT = "tenant-a";

const STORED_SUBMITTED = {
  id: 5,
  interviewId: 3,
  reviewerId: 7,
  scores: { technicalSkills: 4, problemSolving: 3, communication: 5, cultureFit: 4 },
  overallScore: 4,
  recommendation: "HIRE",
  notes: "Solid backend depth",
  submittedAt: new Date("2026-09-18T10:00:00.000Z"),
  tenantId: TENANT,
};

const CHANGED = {
  scores: { technicalSkills: 2, problemSolving: 3, communication: 5, cultureFit: 4 },
  overallScore: 3.5,
  recommendation: "REJECTED",
  notes: "Revisited after the system-design round",
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.interviewScorecard.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  prisma.interviewScorecard.update.mockImplementation(async ({ where, data }) => ({
    id: where.id,
    ...STORED_SUBMITTED,
    ...data,
  }));
});

describe("scorecardPayloadChanged", () => {
  it("treats a re-sent identical payload as unchanged (key order and refreshed timestamp do not count)", () => {
    expect(
      scorecardPayloadChanged(STORED_SUBMITTED, {
        notes: "Solid backend depth",
        recommendation: "HIRE",
        overallScore: 4,
        scores: { cultureFit: 4, communication: 5, problemSolving: 3, technicalSkills: 4 },
        submittedAt: new Date("2026-09-20T09:00:00.000Z"),
      })
    ).toBe(false);
  });

  it("detects a changed rating, a changed recommendation and a changed note", () => {
    expect(scorecardPayloadChanged(STORED_SUBMITTED, { ...STORED_SUBMITTED, overallScore: 4.5 })).toBe(true);
    expect(scorecardPayloadChanged(STORED_SUBMITTED, { ...STORED_SUBMITTED, recommendation: "HOLD" })).toBe(true);
    expect(scorecardPayloadChanged(STORED_SUBMITTED, { ...STORED_SUBMITTED, notes: "changed" })).toBe(true);
    expect(
      scorecardPayloadChanged(STORED_SUBMITTED, {
        ...STORED_SUBMITTED,
        scores: { ...STORED_SUBMITTED.scores, cultureFit: 1 },
      })
    ).toBe(true);
  });
});

describe("upsertInterviewScorecard — lock", () => {
  it("refuses to CHANGE a submitted scorecard without an amendment reason", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue(STORED_SUBMITTED);

    await expect(
      upsertInterviewScorecard({
        interviewId: 3,
        reviewerId: 7,
        data: CHANGED,
        tenantId: TENANT,
      })
    ).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SCORECARD-LOCKED" });

    expect(prisma.interviewScorecard.update).not.toHaveBeenCalled();
  });

  it("refuses a blank amendment reason too (whitespace is not a reason)", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue(STORED_SUBMITTED);

    await expect(
      upsertInterviewScorecard({
        interviewId: 3,
        reviewerId: 7,
        data: CHANGED,
        tenantId: TENANT,
        amendment: { reason: "   " },
      })
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-SCORECARD-LOCKED" });
  });

  it("returns the stored row untouched for an identical resubmit (retry / double-click)", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue(STORED_SUBMITTED);

    const result = await upsertInterviewScorecard({
      interviewId: 3,
      reviewerId: 7,
      data: {
        scores: { ...STORED_SUBMITTED.scores },
        overallScore: 4,
        recommendation: "HIRE",
        notes: "Solid backend depth",
        submittedAt: new Date(),
      },
      tenantId: TENANT,
    });

    expect(result).toBe(STORED_SUBMITTED);
    expect(prisma.interviewScorecard.update).not.toHaveBeenCalled();
  });

  it("allows the change through the amendment path and records why", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue(STORED_SUBMITTED);

    const result = await upsertInterviewScorecard({
      interviewId: 3,
      reviewerId: 7,
      data: CHANGED,
      tenantId: TENANT,
      amendment: { reason: "Rater attended the wrong candidate's session", by: 12 },
    });

    const { data } = prisma.interviewScorecard.update.mock.calls[0][0];
    expect(data.scores).toEqual(CHANGED.scores);
    expect(data.amendmentLog).toHaveLength(1);
    expect(data.amendmentLog[0]).toMatchObject({
      reason: "Rater attended the wrong candidate's session",
      by: 12,
    });
    // The trail keeps WHAT was replaced, not just that something changed.
    expect(data.amendmentLog[0].replaced).toMatchObject({
      overallScore: 4,
      recommendation: "HIRE",
      notes: "Solid backend depth",
      scores: { technicalSkills: 4 },
    });
    expect(data.lastAmendedAt).toBeInstanceOf(Date);
    // The original submit time is evidence and must survive the amendment.
    expect(data.submittedAt).toBeUndefined();
    expect(result.submittedAt).toEqual(STORED_SUBMITTED.submittedAt);
  });

  it("APPENDS to an existing amendment log rather than replacing it", async () => {
    const withHistory = {
      ...STORED_SUBMITTED,
      amendmentLog: [{ at: "2026-09-19T08:00:00.000Z", by: 3, reason: "typo in notes", replaced: {} }],
    };
    prisma.interviewScorecard.findUnique.mockResolvedValue(withHistory);

    await upsertInterviewScorecard({
      interviewId: 3,
      reviewerId: 7,
      data: CHANGED,
      tenantId: TENANT,
      amendment: { reason: "Second correction after the debrief" },
    });

    const { data } = prisma.interviewScorecard.update.mock.calls[0][0];
    expect(data.amendmentLog).toHaveLength(2);
    expect(data.amendmentLog[0].reason).toBe("typo in notes");
    expect(data.amendmentLog[1].reason).toBe("Second correction after the debrief");
  });

  it("writes a normal update while the scorecard is still UNsubmitted", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue({
      ...STORED_SUBMITTED,
      submittedAt: null,
    });

    await upsertInterviewScorecard({
      interviewId: 3,
      reviewerId: 7,
      data: CHANGED,
      tenantId: TENANT,
    });

    const { data } = prisma.interviewScorecard.update.mock.calls[0][0];
    expect(data.scores).toEqual(CHANGED.scores);
    expect(data.amendmentLog).toBeUndefined();
    expect(data.lastAmendedAt).toBeUndefined();
  });

  it("creates the first scorecard without any amendment bookkeeping", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue(null);

    await upsertInterviewScorecard({
      interviewId: 3,
      reviewerId: 7,
      data: { scores: CHANGED.scores, submittedAt: new Date() },
      tenantId: TENANT,
    });

    expect(prisma.interviewScorecard.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.interviewScorecard.create.mock.calls[0][0];
    expect(data.tenantId).toBe(TENANT);
    expect(data.amendmentLog).toBeUndefined();
  });

  it("never amends another tenant's scorecard, even with a reason", async () => {
    prisma.interviewScorecard.findUnique.mockResolvedValue({
      ...STORED_SUBMITTED,
      tenantId: "tenant-b",
    });

    await expect(
      upsertInterviewScorecard({
        interviewId: 3,
        reviewerId: 7,
        data: CHANGED,
        tenantId: TENANT,
        amendment: { reason: "trying to rewrite another tenant's evidence" },
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.interviewScorecard.update).not.toHaveBeenCalled();
  });
});
