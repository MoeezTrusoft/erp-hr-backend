import { beforeEach, describe, expect, it, jest } from "@jest/globals";
const db = { application: { findMany: jest.fn() } };
const tx = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
const transaction = jest.fn();
const refresh = jest.fn(),
  knockout = jest.fn();
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({ tenantTransaction: transaction }));
jest.unstable_mockModule("../../src/lib/requestContext.js", () => ({
  runWithRequestContext: (_context, run) => run(),
}));
jest.unstable_mockModule("../../src/services/applicationFitScore.service.js", () => ({
  refreshFitScore: refresh,
}));
jest.unstable_mockModule("../../src/services/applicationAutoDisposition.service.js", () => ({
  applyAutomaticKnockout: knockout,
}));
const { runApplicationScoring } =
  await import("../../src/services/applicationScoringWorker.service.js");
beforeEach(() => {
  jest.resetAllMocks();
  db.application.findMany.mockResolvedValue([
    { id: 1, candidateId: 2, tenantId: "b50ca1f8-bdef-43fa-9198-35710b1b5953" },
  ]);
  tx.$queryRaw.mockResolvedValue([{ id: 1 }]);
  tx.$executeRaw.mockResolvedValue(1);
  refresh.mockResolvedValue({ score: 42 });
  knockout.mockResolvedValue(null);
  transaction.mockImplementation((_db, run) => run(tx));
});
describe("application scoring committed outcomes", () => {
  it("does not count a scored row when commit fails after the callback returned", async () => {
    transaction.mockImplementationOnce(async (_db, run) => {
      await run(tx);
      throw new Error("simulated commit failure");
    });
    expect(await runApplicationScoring()).toEqual({ scored: 0, failed: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it("counts a committed score but not a skipped locked candidate", async () => {
    expect(await runApplicationScoring()).toEqual({ scored: 1, failed: 0 });
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await runApplicationScoring()).toEqual({ scored: 0, failed: 0 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
