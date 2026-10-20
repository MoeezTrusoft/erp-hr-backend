// F-35 — the recruitment dashboard carries the canonical metric block and, with
// HR_RECRUITMENT_CANONICAL_DASHBOARD on, reports its headline numbers by the
// same definitions as the recruitment analytics tool.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const findMany = jest.fn();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({
  default: { jobRequisition: { findMany } },
}));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn() }));

const { getRecruitmentDashboard } = await import("../../../src/services/analyticsService.js");
const { openPositions } = await import("../../../src/lib/recruitmentMetrics.js");

const at = (iso) => new Date(iso);
// Two seats on one posted requisition, one filled; one requisition still
// awaiting approval; one closed requisition filled 10 days after approval.
const ROWS = [
  {
    id: 1, status: "POSTED", openings: 2, updatedAt: at("2026-07-01T00:00:00Z"),
    transitions: [{ fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", createdAt: at("2026-07-01T00:00:00Z") }],
    approvals: [], postings: [], position: { title: "Sales Lead" },
    offers: [
      { status: "ACCEPTED", respondedAt: at("2026-07-21T00:00:00Z") },
      { status: "DECLINED", respondedAt: at("2026-07-15T00:00:00Z") },
      { status: "WITHDRAWN", respondedAt: null },
    ],
    applications: [{ stage: "hired", interviews: [{}] }, { stage: "rejected", interviews: [] }],
  },
  { id: 2, status: "PENDING_APPROVAL", openings: 1, updatedAt: at("2026-07-02T00:00:00Z"), transitions: [], approvals: [], postings: [], offers: [], applications: [] },
  {
    id: 3, status: "CLOSED", openings: 1, updatedAt: at("2026-07-03T00:00:00Z"),
    transitions: [{ fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", createdAt: at("2026-07-03T00:00:00Z") }],
    approvals: [], postings: [], position: { title: "Accountant" },
    offers: [{ status: "ACCEPTED", respondedAt: at("2026-07-13T00:00:00Z") }],
    applications: [{ stage: "hired", interviews: [{}] }],
  },
];

const ENV = ["HR_RECRUITMENT_CANONICAL_DASHBOARD", "HR_RECRUITMENT_CANONICAL_ANALYTICS"];
const saved = {};
beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  findMany.mockReset();
  findMany.mockResolvedValue(ROWS);
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const run = () => getRecruitmentDashboard({ tenantId: TENANT, timeframe: "current_quarter", userRole: "HR_ADMIN" });

describe("canonical open positions", () => {
  it("counts unfilled seats on approved or posted requisitions only", () => {
    expect(openPositions(ROWS)).toEqual({ openRequisitions: 1, openings: 2, filled: 1, openPositions: 1 });
  });
});

describe("recruitment dashboard", () => {
  it("scopes the query by the verified tenant", async () => {
    await run();
    expect(findMany.mock.calls[0][0].where.tenantId).toBe(TENANT);
    expect(findMany.mock.calls[0][0].include.transitions).toBeDefined();
  });

  it("keeps the legacy headline by default and adds the canonical block beside it", async () => {
    delete process.env.HR_RECRUITMENT_CANONICAL_DASHBOARD;
    const result = await run();
    expect(result.definitions).toBe("legacy");
    // Legacy: requisitions in POSTED, APPROVED or PENDING_APPROVAL.
    expect(result.openPositions).toBe(2);
    expect(result.canonicalMetrics.openPositions.openPositions).toBe(1);
    // Canonical acceptance: 2 accepted of 3 final outcomes; WITHDRAWN is not an outcome.
    expect(result.canonicalMetrics.offerAcceptance).toMatchObject({ ACCEPTED: 2, DECLINED: 1, acceptanceRatePct: 67 });
    // Only requisition 3 filled every opening: 10 days from approval.
    expect(result.canonicalMetrics.timeToFill).toMatchObject({ meanTimeToFillDays: 10, requisitionsFilled: 1 });
    expect(result.canonicalMetrics.version).toBe(1);
  });

  it("reports the headline by the canonical definitions with the flag on", async () => {
    process.env.HR_RECRUITMENT_CANONICAL_DASHBOARD = "true";
    const result = await run();
    expect(result.definitions).toBe("canonical");
    expect(result.openPositions).toBe(1);
    expect(result.recruitmentFunnel.offerAcceptanceRate).toBe(67);
    expect(result.timeToFill).toMatchObject({ avgDays: 10, medianDays: 10, count: 1, definition: "canonical" });
    expect(result.stageCounts.approved).toBe(0);
  });

  it("omits the canonical block when canonical analytics is off", async () => {
    process.env.HR_RECRUITMENT_CANONICAL_ANALYTICS = "false";
    process.env.HR_RECRUITMENT_CANONICAL_DASHBOARD = "true";
    const result = await run();
    expect(result.canonicalMetrics).toBeUndefined();
    expect(result.definitions).toBe("legacy");
    expect(result.openPositions).toBe(2);
  });
});
