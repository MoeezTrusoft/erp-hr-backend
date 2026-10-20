// tests/unit/services/recruitment-analytics.no-illustrative.test.js
//
// Recruitment Phase 5 exit gate: "analytics answers carry no illustrative
// figures". With no data every metric is null with a reason (or a zero
// count), never a sample number; cost per hire is actual spend only; and the
// three added metrics (time to start, recruiter workload, cost per hire) answer
// the drill-down with the rows the payload's number was computed over.
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const prisma = {
    application: { findMany: jest.fn() },
    applicationScreening: { findMany: jest.fn(async () => []) },
    jobRequisition: { findMany: jest.fn() },
    employee: { findMany: jest.fn(async () => []) },
    internalReferral: { findMany: jest.fn(async () => []) },
};
const getCostConfig = jest.fn(async () => null);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/services/recruitmentCost.service.js", () => ({ getCostConfig }));

const analytics = await import("../../../src/services/recruitmentAnalytics.service.js");
const { computeRecruitmentAnalytics, drillDownRecruitmentMetric } = analytics;

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00Z");
const day = (s) => new Date(`${s}T00:00:00Z`);

const savedEnv = {};
const ENV_KEYS = ["HR_RECRUITMENT_CANONICAL_ANALYTICS", "HR_RECRUITMENT_STAGE_SLA_DAYS"];
beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.HR_RECRUITMENT_CANONICAL_ANALYTICS = "true";
    delete process.env.HR_RECRUITMENT_STAGE_SLA_DAYS;
    prisma.application.findMany.mockResolvedValue([]);
    prisma.jobRequisition.findMany.mockResolvedValue([]);
    getCostConfig.mockResolvedValue(null);
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

/** Every number in the answer, with its path, skipping the version stamps. */
function numbersIn(value, path = "") {
    if (typeof value === "number") return [[path, value]];
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([k, v]) =>
        k === "version" || k === "definitionVersions" ? [] : numbersIn(v, path ? `${path}.${k}` : k),
    );
}

// Two hires on requisition 7 (recruiter 70), one with a completed handoff.
const hiredApp = (id, over = {}) => ({
    id,
    stage: "hired",
    appliedAt: day("2026-08-01"),
    updatedAt: day("2026-09-30"),
    candidate: { id: 100 + id, source: "LinkedIn" },
    jobRequisition: { id: 7, title: "Backend Engineer", departmentId: 3 },
    interviews: [{ id: 900 + id }],
    offer: {
        id: 50 + id,
        status: "ACCEPTED",
        respondedAt: day("2026-09-01"),
        sentAt: day("2026-08-25"),
        startDate: day("2026-09-15"),
        handoff: { status: "COMPLETED", employeeId: 300 + id },
    },
    ...over,
});
const requisition = {
    id: 7,
    status: "POSTED",
    recruiterId: 70,
    openings: 2,
    transitions: [{ fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", createdAt: day("2026-07-20") }],
    applications: [
        {
            id: 1, stage: "hired", appliedAt: day("2026-08-01"), candidate: { source: "LinkedIn" },
            offer: { status: "ACCEPTED", respondedAt: day("2026-09-01") }, stageHistory: [], screenings: [],
            interviews: [{ id: 1, scheduledAt: day("2026-10-01"), status: "COMPLETED" }],
        },
        {
            id: 3, stage: "interview", appliedAt: day("2026-10-01"), candidate: { source: "LinkedIn" },
            offer: null, stageHistory: [], screenings: [], interviews: [{ id: 2, scheduledAt: day("2026-10-10"), status: "SCHEDULED" }],
        },
    ],
};

describe("exit gate — no illustrative figures", () => {
    it("drops the sample cost model entirely", () => {
        expect(analytics.ILLUSTRATIVE_COST_BREAKDOWN).toBeUndefined();
    });

    it("an empty tenant answers null with reasons, and no number but a zero count", async () => {
        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(JSON.stringify(res)).not.toMatch(/illustrative/i);
        expect(res).not.toHaveProperty("illustrativeCostData");

        expect(res.timeToHireDays).toBeNull();
        expect(res.offerAcceptanceRatePct).toBeNull();
        expect(res.costPerHire).toMatchObject({ value: null, reason: "NO_COST_CONFIG", totalCost: null });
        expect(res.costBreakdown).toBeNull();
        expect(res.reasons).toEqual({
            timeToHireDays: "NO_HIRES",
            offerAcceptanceRatePct: "NO_OFFERS_EXTENDED",
            costPerHire: "NO_COST_CONFIG",
            costBreakdown: "NO_COST_CONFIG",
        });

        const c = res.canonicalMetrics;
        expect(c.version).toBe(1);
        expect(c.slaAging).toMatchObject({ configured: false, breached: null, reason: "SLA_NOT_CONFIGURED" });
        expect(c.timeToStart).toMatchObject({ meanTimeToStartDays: null, reason: "NO_STARTS" });
        expect(c.costPerHire).toMatchObject({ value: null, reason: "NO_COST_CONFIG" });
        expect(c.recruiterWorkload.recruiters).toEqual([]);

        const nonZero = numbersIn(res).filter(([, n]) => n !== 0);
        expect(nonZero).toEqual([]);
    });

    it("a canonical failure reports unavailable with a reason, not zeros", async () => {
        prisma.jobRequisition.findMany.mockRejectedValue(new Error("db down"));
        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(res.canonicalMetrics).toEqual({ version: null, unavailable: true, reasonCode: "COMPUTATION_FAILED" });
    });

    it("a hire without an accepted offer has no time to hire and no hire date (no updatedAt stand-in)", async () => {
        prisma.application.findMany.mockResolvedValue([hiredApp(1, { offer: null })]);
        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(res.totalHires).toBe(1);
        expect(res.timeToHireDays).toBeNull();
        expect(res.reasons.timeToHireDays).toBe("NO_ACCEPTED_OFFERS");
        expect(res.metrics).toEqual([{ hireDate: null, role: "Backend Engineer", department: 3 }]);
    });
});

describe("cost per hire — actual spend", () => {
    it("uses the cost configuration plus paid referral bonuses, divided by hires", async () => {
        prisma.application.findMany.mockResolvedValue([hiredApp(1), hiredApp(2)]);
        getCostConfig.mockResolvedValue({ id: 4, period: "all", currency: "PKR", agencyFees: "60000", jobAds: "10000", tools: "50000", other: "0" });
        prisma.internalReferral.findMany.mockResolvedValue([{ id: 8, applicationId: 2, bonusAmount: "20000.00", bonusCurrency: "PKR" }]);

        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(prisma.internalReferral.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: TENANT, bonusStatus: "PAID" } }),
        );
        expect(res.costPerHire).toEqual({ value: 45000, totalCost: 90000, currency: "PKR", hires: 2, period: "all", reason: null });
        expect(res.costBreakdown).toEqual({ agencyFees: 60000, jobAds: 10000, referralBonusesPaid: 20000, other: 0, currency: "PKR" });
        expect(res.canonicalMetrics.costPerHire).toMatchObject({ value: 45000, referralBonusesCount: 1 });

        const drill = await drillDownRecruitmentMetric(TENANT, "costPerHire", {}, { now: NOW });
        expect(drill).toMatchObject({ unit: "hire", total: 2, value: 45000, reason: null });
        expect(drill.components).toMatchObject({ costConfigId: 4, referralBonuses: [{ referralId: 8, applicationId: 2, amount: 20000 }] });
    });

    it("is null with a reason under a filter (all-time costs cannot be sliced)", async () => {
        prisma.application.findMany.mockResolvedValue([hiredApp(1)]);
        getCostConfig.mockResolvedValue({ id: 4, currency: "PKR", agencyFees: 1 });
        const res = await computeRecruitmentAnalytics(TENANT, { departmentId: 3 }, { now: NOW });
        expect(res.costPerHire).toMatchObject({ value: null, reason: "COST_NOT_ATTRIBUTABLE_TO_FILTER" });
        expect(getCostConfig).not.toHaveBeenCalled();

        const drill = await drillDownRecruitmentMetric(TENANT, "costPerHire", { departmentId: 3 }, { now: NOW });
        expect(drill).toMatchObject({ value: null, reason: "COST_NOT_ATTRIBUTABLE_TO_FILTER", total: 0, filters: { departmentId: 3 } });
    });
});

describe("time to start and recruiter workload — payload and drill-down agree", () => {
    beforeEach(() => {
        prisma.application.findMany.mockResolvedValue([
            hiredApp(1),
            // Handoff not completed yet: counted as awaiting, not measured.
            hiredApp(2, { offer: { ...hiredApp(2).offer, handoff: { status: "FAILED", employeeId: null } } }),
        ]);
        prisma.jobRequisition.findMany.mockResolvedValue([requisition]);
        prisma.employee.findMany.mockResolvedValue([{ id: 301, hire_date: day("2026-09-22"), joining_date: null }]);
    });

    it("time to start reads the provisioned employee's hire date", async () => {
        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(prisma.employee.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: [301] }, tenant_id: TENANT } }),
        );
        expect(res.canonicalMetrics.timeToStart).toEqual({
            meanTimeToStartDays: 21, medianTimeToStartDays: 21, startsMeasured: 1, upcomingStarts: 0, unknownStarts: 0, awaitingHandoff: 1,
        });

        const drill = await drillDownRecruitmentMetric(TENANT, "timeToStartDays", {}, { now: NOW });
        expect(drill.unit).toBe("hire");
        expect(drill.rows).toEqual([
            expect.objectContaining({ applicationId: 1, offerId: 51, employeeId: 301, startSource: "EMPLOYEE", timeToStartDays: 21, status: "STARTED" }),
        ]);
    });

    it("workload counts the recruiter's open requisitions, active applications and interviews this period", async () => {
        const res = await computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        const workload = res.canonicalMetrics.recruiterWorkload;
        expect(workload.period).toEqual({ from: "2026-09-20T10:00:00.000Z", to: "2026-10-20T10:00:00.000Z" });
        expect(workload.recruiters).toEqual([
            { recruiterId: 70, openRequisitions: 1, activeApplications: 1, interviewsThisPeriod: 2, requisitionIds: [7] },
        ]);

        const drill = await drillDownRecruitmentMetric(TENANT, "recruiterWorkload", { dateFrom: "2026-10-05" }, { now: NOW });
        expect(drill).toMatchObject({ unit: "recruiter", period: { from: "2026-10-05T00:00:00.000Z" } });
        expect(drill.rows[0]).toMatchObject({ recruiterId: 70, interviewsThisPeriod: 1 });
    });
});
