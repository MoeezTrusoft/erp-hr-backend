// tests/unit/recruitmentMetrics.phase5.test.js
//
// Phase 5 additions to the canonical definitions: time to start, recruiter
// workload and cost per hire (actual spend only), each at definition version 1,
// with the v1 definitions untouched.
import { describe, it, expect } from "@jest/globals";

import {
    METRICS_VERSION,
    NULL_REASONS,
    aggregateTimeToStart,
    costPerHire,
    metricsVersionBlock,
    recruiterWorkload,
    timeToStartForHire,
} from "../../src/lib/recruitment-metrics.util.js";

const d = (s) => new Date(s);
const NOW = d("2026-10-20T10:00:00Z");

describe("versioning", () => {
    it("keeps METRICS_VERSION 1 and versions every definition", () => {
        expect(METRICS_VERSION).toBe(1);
        const block = metricsVersionBlock();
        expect(block.version).toBe(1);
        for (const key of ["timeToStartDays", "recruiterWorkload", "costPerHire"]) {
            expect(typeof block.definitions[key]).toBe("string");
            expect(block.definitionVersions[key]).toBe(1);
        }
        expect(Object.keys(block.definitionVersions).sort()).toEqual(Object.keys(block.definitions).sort());
        expect(Object.values(block.definitionVersions).every((v) => v === 1)).toBe(true);
    });
});

describe("time to start", () => {
    it("measures acceptance → employee start in whole UTC days", () => {
        expect(timeToStartForHire({ acceptedAt: d("2026-09-01T15:00:00Z"), employeeStartAt: d("2026-09-15T00:00:00Z") }, NOW)).toMatchObject({
            startSource: "EMPLOYEE", timeToStartDays: 14, status: "STARTED",
        });
    });

    it("ignores an adopted employee's older hire date and falls back to the offer's start", () => {
        expect(
            timeToStartForHire({ acceptedAt: d("2026-09-01"), employeeStartAt: d("2020-01-01"), offerStartAt: d("2026-09-08") }, NOW),
        ).toMatchObject({ startSource: "OFFER", timeToStartDays: 7, status: "STARTED" });
    });

    it("an upcoming start is not measured; nothing usable is UNKNOWN", () => {
        expect(timeToStartForHire({ acceptedAt: d("2026-10-10"), offerStartAt: d("2026-11-01") }, NOW)).toMatchObject({
            status: "UPCOMING", timeToStartDays: null,
        });
        expect(timeToStartForHire({ acceptedAt: d("2026-10-10") }, NOW).status).toBe("UNKNOWN");
        expect(timeToStartForHire({ acceptedAt: null, offerStartAt: d("2026-10-11") }, NOW).status).toBe("UNKNOWN");
    });

    it("aggregates the started hires only", () => {
        const agg = aggregateTimeToStart([
            { status: "STARTED", timeToStartDays: 10 },
            { status: "STARTED", timeToStartDays: 20 },
            { status: "STARTED", timeToStartDays: 31 },
            { status: "UPCOMING", timeToStartDays: null },
            { status: "UNKNOWN", timeToStartDays: null },
        ]);
        expect(agg).toEqual({ meanTimeToStartDays: 20.3, medianTimeToStartDays: 20, startsMeasured: 3, upcomingStarts: 1, unknownStarts: 1 });
        expect(aggregateTimeToStart([]).meanTimeToStartDays).toBeNull();
    });
});

describe("recruiter workload", () => {
    const period = { from: d("2026-09-20"), to: NOW };
    it("counts open requisitions, active applications on them and interviews in the period", () => {
        const rows = recruiterWorkload(
            [
                {
                    id: 1, status: "POSTED", recruiterId: 7,
                    applications: [
                        { id: 11, stage: "applied", interviews: [] },
                        { id: 12, stage: "interview", interviews: [{ id: 1, scheduledAt: d("2026-10-01"), status: "COMPLETED" }, { id: 2, scheduledAt: d("2026-10-02"), status: "CANCELLED" }] },
                        { id: 13, stage: "rejected", interviews: [{ id: 3, scheduledAt: d("2026-08-01"), status: "COMPLETED" }] },
                        { id: 14, stage: "on_hold", interviews: [] },
                    ],
                },
                { id: 2, status: "APPROVED", recruiterId: 7, applications: [] },
                // Closed, but an interview in the period still counts as workload.
                { id: 3, status: "CLOSED", recruiterId: 8, applications: [{ id: 31, stage: "applied", interviews: [{ id: 4, scheduledAt: d("2026-10-05"), status: "SCHEDULED" }] }] },
                // Closed and quiet: not workload.
                { id: 4, status: "CLOSED", recruiterId: 9, applications: [{ id: 41, stage: "applied", interviews: [] }] },
                { id: 5, status: "POSTED", recruiterId: null, applications: [{ id: 51, stage: "screening", interviews: [] }] },
            ],
            period,
        );
        expect(rows).toEqual([
            { recruiterId: 7, openRequisitions: 2, activeApplications: 2, interviewsThisPeriod: 1, requisitionIds: [1, 2] },
            { recruiterId: 8, openRequisitions: 0, activeApplications: 0, interviewsThisPeriod: 1, requisitionIds: [3] },
            { recruiterId: null, openRequisitions: 1, activeApplications: 1, interviewsThisPeriod: 0, requisitionIds: [5] },
        ]);
    });
});

describe("cost per hire (actual spend only)", () => {
    it("is null with a reason without a cost configuration — never a sample figure", () => {
        expect(costPerHire({ config: null, hires: 4 })).toMatchObject({ value: null, reason: NULL_REASONS.NO_COST_CONFIG, totalCost: null, breakdown: null });
    });

    it("adds agency fees, job board spend, paid referral bonuses and other; tools are not in it", () => {
        const res = costPerHire({
            config: { agencyFees: "100000.0000", jobAds: { toString: () => "20000" }, tools: 99999, other: 5000, currency: "PKR", period: "all" },
            paidReferralBonuses: [{ amount: "25000.00", currency: "PKR" }, { amount: 15000, currency: null }],
            hires: 4,
        });
        expect(res).toMatchObject({
            value: 41250,
            reason: null,
            totalCost: 165000,
            currency: "PKR",
            hires: 4,
            breakdown: { agencyFees: 100000, jobAds: 20000, referralBonusesPaid: 40000, other: 5000 },
        });
    });

    it("is null with a reason with no hires or a bonus in another currency", () => {
        expect(costPerHire({ config: { agencyFees: 10, currency: "PKR" }, hires: 0 })).toMatchObject({ value: null, reason: NULL_REASONS.NO_HIRES, totalCost: 10 });
        expect(
            costPerHire({ config: { agencyFees: 10, currency: "PKR" }, paidReferralBonuses: [{ amount: 5, currency: "USD" }], hires: 1 }),
        ).toMatchObject({ value: null, reason: NULL_REASONS.MIXED_CURRENCY, totalCost: null });
    });
});
