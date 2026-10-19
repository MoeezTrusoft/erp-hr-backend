import { jest } from "@jest/globals";

const logAction = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));

const { transitionApplicationStage, canTransitionApplicationStage } =
  await import("../../src/services/applicationWorkflow.service.js");

describe("Recruitment application workflow", () => {
  const makeDb = ({ stage = "applied", interviews = [], offers = [] } = {}) => {
    const application = { id: 7, tenantId: "tenant-a", stage };
    return {
      application: {
        findFirst: jest.fn().mockResolvedValue(application),
        update: jest.fn().mockResolvedValue({ ...application, stage: "screening" }),
      },
      interview: { findFirst: jest.fn().mockResolvedValue(interviews[0] ?? null) },
      offer: { findFirst: jest.fn().mockResolvedValue(offers[0] ?? null) },
      applicationStageHistory: { create: jest.fn().mockResolvedValue({ id: 1 }) },
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
    expect(db.application.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: { stage: "screening" },
    }));
    expect(db.applicationStageHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fromStage: "applied", toStage: "screening", actorId: 12 }),
    }));
  });

  test("rejects illegal transitions and missing disposition reasons", async () => {
    await expect(transitionApplicationStage({
      id: 7,
      tenantId: "tenant-a",
      targetStage: "hired",
      db: makeDb(),
    })).rejects.toMatchObject({ code: "HR-RECRUITMENT-TRANSITION-INVALID" });

    await expect(transitionApplicationStage({
      id: 7,
      tenantId: "tenant-a",
      targetStage: "rejected",
      db: makeDb(),
    })).rejects.toMatchObject({ code: "HR-RECRUITMENT-REASON-REQUIRED" });
  });

  test("exposes the transition matrix for callers", () => {
    expect(canTransitionApplicationStage("applied", "screening")).toBe(true);
    expect(canTransitionApplicationStage("screening", "applied")).toBe(false);
    expect(canTransitionApplicationStage("hired", "screening")).toBe(false);
  });
});
