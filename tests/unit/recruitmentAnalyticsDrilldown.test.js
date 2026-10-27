// tests/unit/recruitmentAnalyticsDrilldown.test.js
//
// NFR-12 — reporting integrity, the "drill-down to the data behind metrics"
// clause plus "preserve filters":
//
//   * the drill-down runs the SAME filter + fetch pipeline as the metric
//     payload (it consumes the shared normalizer/loader, and this suite pins
//     that a filtered drill-down returns exactly the filtered rows)
//   * an unknown metric is REFUSED, never silently answered with everything
//   * the filter echo is returned so the caller can see the window it got
//   * an unlimited bucket is truncated with `truncated: true` rather than
//     quietly returning a partial set as if it were complete
//   * dispositions resolve through the screening ledger (the actual evidence)
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
  application: { findMany: jest.fn() },
  applicationScreening: { findMany: jest.fn() },
  jobRequisition: { findMany: jest.fn() },
  offer: { findMany: jest.fn() },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/services/recruitment-cost.service.js", () => ({ getCostConfig: jest.fn(async () => ({ jobAds: 0, agencyFees: 0, tools: 0, other: 0, currency: "PKR" })) }));

const { drillDownRecruitmentMetric, normalizeAnalyticsFilters } = await import(
  "../../src/services/recruitment-analytics.service.js"
);

const app = (id, over = {}) => ({
  id,
  stage: "applied",
  appliedAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-10T00:00:00Z"),
  candidate: { id: 100 + id, source: "LinkedIn" },
  jobRequisition: { id: 7, title: "Backend Engineer", departmentId: 3 },
  interviews: [],
  offer: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.application.findMany.mockResolvedValue([
    app(1, { stage: "hired" }),
    app(2, { stage: "interview" }),
    app(3, { stage: "rejected" }),
  ]);
  prisma.applicationScreening.findMany.mockResolvedValue([{ applicationId: 3, outcome: "REJECT", reasonCode: "NOT_A_FIT" }]);
});

describe("NFR-12 — metric drill-down", () => {
  it("returns the applications behind totalHires with the facts the metric used", async () => {
    const result = await drillDownRecruitmentMetric("t-1", "totalHires");
    expect(result.unit).toBe("application");
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({ applicationId: 1, stage: "hired", source: "LinkedIn", requisitionId: 7 });
  });

  it("a funnel bucket is the stage slice, and the metric maps to requisitions for fill metrics", async () => {
    const funnel = await drillDownRecruitmentMetric("t-1", "funnel:interview");
    expect(funnel.rows.map((r) => r.applicationId)).toEqual([2]);

    const fill = await drillDownRecruitmentMetric("t-1", "timeToFillDays");
    expect(fill.unit).toBe("requisition");
    expect(fill.rows[0]).toMatchObject({ requisitionId: 7, applicationIds: [1, 2, 3] });
  });

  it("offer acceptance answers with the offers the canonical rate counts (F-35)", async () => {
    prisma.application.findMany.mockResolvedValueOnce([
      app(1, { offer: { id: 11, status: "ACCEPTED", respondedAt: new Date("2026-02-20T00:00:00Z") } }),
      app(2, { offer: { id: 12, status: "DECLINED", respondedAt: new Date("2026-02-21T00:00:00Z") } }),
      app(3, { offer: { id: 13, status: "SENT", respondedAt: null } }),
      app(4, { offer: { id: 14, status: "WITHDRAWN", respondedAt: null } }),
      app(5, { offer: { id: 15, status: "DRAFT", respondedAt: null } }),
      app(6),
    ]);
    const result = await drillDownRecruitmentMetric("t-1", "offerAcceptanceRate");
    expect(result.unit).toBe("offer");
    expect(result.rows.map((r) => [r.offerId, r.outcome])).toEqual([
      [11, "final"],
      [12, "final"],
      [13, "pending"],
    ]);
  });

  it("dispositions resolve through the screening ledger (the actual evidence)", async () => {
    const result = await drillDownRecruitmentMetric("t-1", "disposition:NOT_A_FIT");
    expect(prisma.applicationScreening.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reasonCode: "NOT_A_FIT" }) })
    );
    expect(result.rows.map((r) => r.applicationId)).toEqual([3]);
  });

  it("REFUSES an unknown metric rather than answering with everything", async () => {
    await expect(drillDownRecruitmentMetric("t-1", "definitelyNotAMetric")).rejects.toMatchObject({
      status: 400,
      code: "HR-RECRUITMENT-ANALYTICS-DRILLDOWN-INVALID",
    });
    await expect(drillDownRecruitmentMetric("t-1", "")).rejects.toMatchObject({ status: 400 });
    expect(prisma.application.findMany).not.toHaveBeenCalled();
  });

  it("preserves the filters in the payload AND narrows the rows (same window as the metric)", async () => {
    const result = await drillDownRecruitmentMetric("t-1", "funnel:interview", { stage: "interview", dateFrom: "2026-01-01" });
    expect(result.filters).toMatchObject({ stage: "interview", dateFrom: "2026-01-01T00:00:00.000Z" });
    // The stage filter is applied by the shared loader, not by the drill-down.
    expect(result.rows.map((r) => r.applicationId)).toEqual([2]);
  });

  it("truncates an oversized bucket and SAYS SO", async () => {
    prisma.application.findMany.mockResolvedValue(Array.from({ length: 5 }, (_, i) => app(i + 1, { stage: "hired" })));
    const result = await drillDownRecruitmentMetric("t-1", "totalHires", {}, { limit: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("unknown filter keys are refused by the shared normalizer (no silent no-op filter)", () => {
    expect(() => normalizeAnalyticsFilters({ nonsense: 1 })).toThrow(/Unsupported analytics filter/);
  });
});

describe("D-15 — the shared filter pipeline reads what it filters on", () => {
  it("selects the requisition id that the requisitionIds filter and drill-down read", async () => {
    const { loadFilteredApplications } = await import("../../src/services/recruitment-analytics.service.js");
    prisma.application.findMany.mockResolvedValueOnce([]);
    await loadFilteredApplications("t-1", {});
    const args = prisma.application.findMany.mock.calls.at(-1)[0];
    expect(args.select.jobRequisition.select).toMatchObject({ id: true });
    expect(args.where).toEqual({ tenantId: "t-1" });
  });

  it("refuses an unscoped read instead of reading every tenant", async () => {
    const { loadFilteredApplications } = await import("../../src/services/recruitment-analytics.service.js");
    await expect(loadFilteredApplications(undefined, {})).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });
});
