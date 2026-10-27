import { jest } from "@jest/globals";

const enqueueHrDomainEvent = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent,
}));
const logAction = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));

const { transitionApplicationStage, canTransitionApplicationStage } =
  await import("../../src/services/applicationWorkflow.service.js");

describe("Recruitment application workflow", () => {
  const makeDb = ({ stage = "applied", interviews = [], offers = [] } = {}) => {
    const application = { id: 7, tenantId: "tenant-a", stage, version: 1 };
    return {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 7 }]),
      application: {
        findFirst: jest.fn().mockResolvedValue(application),
        update: jest.fn().mockResolvedValue({ ...application, stage: "screening" }),
      },
      interview: {
        findFirst: jest.fn().mockResolvedValue(interviews[0] ?? null),
      },
      offer: { findFirst: jest.fn().mockResolvedValue(offers[0] ?? null) },
      applicationStageHistory: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };
  };

  test("allows a valid forward transition and records history", async () => {
    const db = makeDb();
    const result = await transitionApplicationStage({
      id: 7,
      tenantId: "tenant-a",
      targetStage: "SCREENING",
      actorId: 12,
      db,
    });

    expect(result.changed).toBe(true);
    expect(db.$queryRawUnsafe).toHaveBeenCalled();
    expect(enqueueHrDomainEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        eventName: "hr.recruitment.application_stage_changed.v1",
      }),
    );
    expect(db.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          stage: "screening",
          status: "open",
          version: { increment: 1 },
        }),
      }),
    );
    expect(db.applicationStageHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStage: "applied",
          toStage: "screening",
          actorId: 12,
        }),
      }),
    );
  });

  test("agency screening is refused until a recruiter accepts the owned submission", async () => {
    const db = makeDb();
    db.application.findFirst.mockResolvedValue({
      id: 7,
      tenantId: "tenant-a",
      stage: "applied",
      version: 1,
      agencySubmissionId: "11111111-1111-4111-8111-111111111111",
    });
    db.agencySubmission = { findFirst: jest.fn().mockResolvedValue(null) };
    await expect(
      transitionApplicationStage({
        id: 7,
        tenantId: "tenant-a",
        targetStage: "screening",
        actorId: 12,
        db,
      }),
    ).rejects.toMatchObject({ code: "HR-5306" });
    expect(db.application.update).not.toHaveBeenCalled();
    db.agencySubmission.findFirst.mockResolvedValue({ state: "ACCEPTED" });
    await expect(
      transitionApplicationStage({
        id: 7,
        tenantId: "tenant-a",
        targetStage: "screening",
        actorId: 12,
        db,
      }),
    ).resolves.toMatchObject({ changed: true });
    expect(db.agencySubmission.findFirst).toHaveBeenLastCalledWith({
      where: {
        tenantId: "tenant-a",
        id: "11111111-1111-4111-8111-111111111111",
        state: "ACCEPTED",
      },
    });
  });

  test("rejects illegal transitions and missing disposition reasons", async () => {
    await expect(
      transitionApplicationStage({
        id: 7,
        tenantId: "tenant-a",
        targetStage: "hired",
        db: makeDb(),
      }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-TRANSITION-INVALID" });

    await expect(
      transitionApplicationStage({
        id: 7,
        tenantId: "tenant-a",
        targetStage: "rejected",
        db: makeDb(),
      }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-REASON-REQUIRED" });
  });

  test("exposes the transition matrix for callers", () => {
    expect(canTransitionApplicationStage("applied", "screening")).toBe(true);
    expect(canTransitionApplicationStage("screening", "applied")).toBe(false);
    expect(canTransitionApplicationStage("hired", "screening")).toBe(false);
  });
});
