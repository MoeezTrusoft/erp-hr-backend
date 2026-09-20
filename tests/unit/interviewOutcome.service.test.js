// tests/unit/interviewOutcome.service.test.js
//
// Phase 3.4 — a decisive interview outcome gates the OFFER prerequisite in the
// application workflow, so it must carry evidence (a submitted scorecard) or an
// explicit, recorded override.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockLogAction = jest.fn(async () => undefined);

const prisma = {
  interview: {
    findFirst: jest.fn(),
    update: jest.fn(async () => ({ id: 1 })),
  },
  interviewScorecard: { count: jest.fn() },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
// getInterviewManaged is the service's own read-back shaper; it is exercised
// elsewhere, so it is stubbed here to keep this suite focused on the rules.
jest.unstable_mockModule("../../src/services/interview-scorecard.service.js", () => ({
  upsertInterviewScorecard: jest.fn(),
}));

const { setInterviewOutcome } = await import("../../src/services/interviewMgmt.service.js");

describe("Interview outcome rules (Phase 3.4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.interview.findFirst.mockResolvedValue({ id: 1, notes: null });
    prisma.interview.update.mockResolvedValue({ id: 1 });
  });

  it("refuses a decisive outcome with no submitted scorecard", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(0);

    await expect(setInterviewOutcome({ interviewId: 1, decision: "NEXT_ROUND", tenantId: "t" }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-INTERVIEW-FEEDBACK-REQUIRED" });
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it("records a decisive outcome once a scorecard exists", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(1);

    await setInterviewOutcome({ interviewId: 1, decision: "NEXT_ROUND", tenantId: "t", actorId: 12 });

    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decision: "NEXT_ROUND", status: "COMPLETED" }),
      }),
    );
    expect(mockLogAction).toHaveBeenCalledTimes(1);
  });

  it("requires a recorded override to decide without a scorecard", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(0);

    await setInterviewOutcome({
      interviewId: 1,
      decision: "REJECTED",
      reason: "Failed core technical criteria",
      overrideReason: "Panel feedback captured offline",
      tenantId: "t",
    });

    const { data } = prisma.interview.update.mock.calls[0][0];
    expect(data.status).toBe("COMPLETED");
    expect(data.notes).toContain("Failed core technical criteria");
    expect(data.notes).toContain("Overridden without scorecard: Panel feedback captured offline");
  });

  it("always requires a reason for a rejection", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(3);

    await expect(setInterviewOutcome({ interviewId: 1, decision: "REJECTED", tenantId: "t" }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-INTERVIEW-REASON-REQUIRED" });
  });

  it("allows HOLD without evidence — it is an interim state, not a decision", async () => {
    prisma.interviewScorecard.count.mockResolvedValue(0);

    await setInterviewOutcome({ interviewId: 1, decision: "HOLD", tenantId: "t" });

    expect(prisma.interviewScorecard.count).not.toHaveBeenCalled();
    expect(prisma.interview.update).toHaveBeenCalled();
  });

  it("rejects an unknown decision and a cross-tenant id", async () => {
    await expect(setInterviewOutcome({ interviewId: 1, decision: "PASS", tenantId: "t" }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-INTERVIEW-DECISION-INVALID" });

    prisma.interview.findFirst.mockResolvedValue(null);
    await expect(setInterviewOutcome({ interviewId: 99, decision: "HOLD", tenantId: "t" }))
      .rejects.toMatchObject({ status: 404 });
  });
});
