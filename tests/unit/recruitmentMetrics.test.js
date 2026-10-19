// tests/unit/recruitmentMetrics.test.js
//
// Phase 12 / decision record §6 — the FROZEN canonical KPI definitions:
//
//   * every definition is pinned to the decision-record wording
//   * Time to Fill vs Time to FIRST Fill are separate numbers, never merged
//   * withdrawals are reported separately, never folded into conversion
//   * offer acceptance shows Declined/Expired separately, never hidden
//   * source effectiveness publishes formulas only — no composite score
//   * the payload carries a version block; a definition change must bump it

import { describe, it, expect } from "@jest/globals";

import {
    METRICS_VERSION,
    metricsVersionBlock,
    finalApprovalAt,
    acceptedOfferTimes,
    timeToFillForRequisition,
    aggregateTimeToFill,
    timeToHireForApplication,
    aggregateTimeToHire,
    timeInStageForApplication,
    slaAging,
    STAGE_ORDER,
    stageFunnel,
    offerAcceptance,
    sourceEffectiveness,
} from "../../src/lib/recruitmentMetrics.js";

const d = (s) => new Date(s);

describe("metrics version block (§6 freeze)", () => {
    it("pins a version and the definition strings", () => {
        expect(METRICS_VERSION).toBe(1);
        const block = metricsVersionBlock();
        expect(block.version).toBe(1);
        expect(Object.keys(block.definitions)).toEqual(
            expect.arrayContaining([
                "timeToFillDays", "timeToFirstFillDays", "timeToHireDays", "timeInStage",
                "slaAging", "stageConversion", "dropOff", "offerAcceptanceRate", "sourceEffectiveness",
            ]),
        );
    });
});

describe("Time to Fill / Time to First Fill (§6 rows 1–2)", () => {
    it("final approval = the LAST APPROVED transition (multi-step chains)", () => {
        const t = finalApprovalAt([
            { fromStatus: "DRAFT", toStatus: "PENDING_APPROVAL", createdAt: d("2026-01-01") },
            { fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", createdAt: d("2026-01-05") },
            { fromStatus: "APPROVED", toStatus: "APPROVED", createdAt: d("2026-01-10") },
        ]);
        expect(t).toEqual(d("2026-01-10"));
    });

    it("falls back to the first POSTED transition for legacy rows, else null", () => {
        expect(finalApprovalAt([{ fromStatus: "APPROVED", toStatus: "POSTED", createdAt: d("2026-01-03") }])).toEqual(d("2026-01-03"));
        expect(finalApprovalAt([])).toBeNull();
    });

    it("per-opening fill dates are preserved; overall fill = all openings filled", () => {
        const r = timeToFillForRequisition(
            [{ toStatus: "APPROVED", createdAt: d("2026-01-01") }],
            [
                { status: "ACCEPTED", respondedAt: d("2026-01-11") },
                { status: "ACCEPTED", respondedAt: d("2026-01-21") },
            ],
            2,
        );
        expect(r.filled).toBe(2);
        expect(r.perOpeningFillDates).toEqual([d("2026-01-11"), d("2026-01-21")]);
        expect(r.timeToFirstFillDays).toBe(10);
        expect(r.timeToFillDays).toBe(20);
    });

    it("a partially filled multi-opening requisition has NO overall fill yet — but first fill exists", () => {
        const r = timeToFillForRequisition(
            [{ toStatus: "APPROVED", createdAt: d("2026-01-01") }],
            [{ status: "ACCEPTED", respondedAt: d("2026-01-11") }],
            2,
        );
        expect(r.timeToFillDays).toBeNull();
        expect(r.timeToFirstFillDays).toBe(10);
        expect(r.filled).toBe(1);
    });

    it("aggregation keeps the two clocks SEPARATE", () => {
        const agg = aggregateTimeToFill([
            { timeToFillDays: 20, timeToFirstFillDays: 10 },
            { timeToFillDays: 40, timeToFirstFillDays: 15 },
            { timeToFillDays: null, timeToFirstFillDays: 5 }, // still open overall
        ]);
        expect(agg.meanTimeToFillDays).toBe(30);
        expect(agg.meanTimeToFirstFillDays).toBe(10);
        expect(agg.requisitionsFilled).toBe(2);
        expect(agg.requisitionsWithFirstFill).toBe(3);
    });

    it("acceptedOfferTimes orders by acceptance and ignores non-accepted", () => {
        expect(acceptedOfferTimes([
            { status: "DECLINED", respondedAt: d("2026-01-30") },
            { status: "ACCEPTED", respondedAt: d("2026-01-12") },
            { status: "SENT", respondedAt: null },
            { status: "ACCEPTED", respondedAt: d("2026-01-02") },
        ])).toEqual([d("2026-01-02"), d("2026-01-12")]);
    });
});

describe("Time to Hire (§6 row 3)", () => {
    it("appliedAt → accepted offer respondedAt", () => {
        expect(
            timeToHireForApplication({ appliedAt: d("2026-01-01"), offer: { status: "ACCEPTED", respondedAt: d("2026-01-11") } }),
        ).toBe(10);
    });

    it("a hire without an accepted offer is excluded (null), not counted as zero", () => {
        expect(timeToHireForApplication({ appliedAt: d("2026-01-01"), offer: { status: "SENT", respondedAt: null } })).toBeNull();
        expect(timeToHireForApplication({ appliedAt: d("2026-01-01"), offer: null })).toBeNull();
    });

    it("aggregate reports mean and median", () => {
        expect(aggregateTimeToHire([10, 20, 30, null])).toEqual({
            meanTimeToHireDays: 20,
            medianTimeToHireDays: 20,
            hiresMeasured: 3,
        });
    });
});

describe("Time in Stage (§6 row 4)", () => {
    it("first stage entered at appliedAt; current stage runs to now", () => {
        const rows = timeInStageForApplication(
            [
                { fromStage: "applied", toStage: "screening", createdAt: d("2026-01-04") },
                { fromStage: "screening", toStage: "interview", createdAt: d("2026-01-09") },
            ],
            "interview",
            d("2026-01-01"),
            d("2026-01-19"),
        );
        expect(rows).toEqual([
            { stage: "applied", daysInStage: 3, isCurrent: false },
            { stage: "screening", daysInStage: 5, isCurrent: false },
            { stage: "interview", daysInStage: 10, isCurrent: true },
        ]);
    });

    it("no history → the current stage entered at appliedAt", () => {
        const rows = timeInStageForApplication([], "applied", d("2026-01-01"), d("2026-01-06"));
        expect(rows).toEqual([{ stage: "applied", daysInStage: 5, isCurrent: true }]);
    });
});

describe("SLA aging (§6 row 5)", () => {
    it("breach = days in stage beyond the configured SLA", () => {
        expect(slaAging("interview", 12, { interview: 7 })).toEqual({
            stage: "interview", daysInStage: 12, slaDays: 7, agingDays: 5, breached: true,
        });
        expect(slaAging("interview", 5, { interview: 7 }).breached).toBe(false);
    });

    it("an unconfigured stage reports null, never a guess", () => {
        expect(slaAging("offer", 3, { interview: 7 })).toMatchObject({ slaDays: null, agingDays: null, breached: false });
        expect(slaAging("offer", 3, {})).toMatchObject({ slaDays: null, breached: false });
    });
});

describe("Stage Conversion & Drop-off (§6 rows 6–7)", () => {
    it("STAGE_ORDER is the canonical advancement path", () => {
        expect(STAGE_ORDER).toEqual(["applied", "screening", "interview", "offer", "hired"]);
    });

    const apps = [
        // enters applied → screening → interview (still there)
        {
            applicationId: 1, currentStage: "interview", appliedAt: d("2026-01-01"), history: [
                { fromStage: "applied", toStage: "screening", createdAt: d("2026-01-02") },
                { fromStage: "screening", toStage: "interview", createdAt: d("2026-01-03") },
            ], dispositionReasonCode: null,
        },
        // enters applied → screening → rejected (drop-off, coded)
        {
            applicationId: 2, currentStage: "rejected", appliedAt: d("2026-01-01"), history: [
                { fromStage: "applied", toStage: "screening", createdAt: d("2026-01-02") },
                { fromStage: "screening", toStage: "rejected", createdAt: d("2026-01-03") },
            ], dispositionReasonCode: "SKILLS_MISMATCH",
        },
        // enters applied → screening → withdrawn (reported separately)
        {
            applicationId: 3, currentStage: "withdrawn", appliedAt: d("2026-01-01"), history: [
                { fromStage: "applied", toStage: "screening", createdAt: d("2026-01-02") },
                { fromStage: "screening", toStage: "withdrawn", createdAt: d("2026-01-03") },
            ], dispositionReasonCode: "CANDIDATE_REQUEST",
        },
        // applied only, no history yet
        { applicationId: 4, currentStage: "applied", appliedAt: d("2026-01-01"), history: [], dispositionReasonCode: null },
    ];

    it("entered counts the from-side of the first transition (applied at appliedAt)", () => {
        const f = stageFunnel(apps);
        expect(f.find((s) => s.stage === "applied").entered).toBe(4);
        expect(f.find((s) => s.stage === "screening").entered).toBe(3);
    });

    it("conversion counts advancement; withdrawals are SEPARATE", () => {
        const f = stageFunnel(apps);
        const applied = f.find((s) => s.stage === "applied");
        expect(applied.advanced).toBe(3);
        expect(applied.conversionPct).toBe(75);
        expect(applied.withdrew).toBe(0);
        const screening = f.find((s) => s.stage === "screening");
        expect(screening.advanced).toBe(1);
        expect(screening.dropped).toBe(1);
        expect(screening.withdrew).toBe(1);
        expect(screening.conversionPct).toBe(33);
        expect(screening.dropOffPct).toBe(33);
    });

    it("drop-off is classified by the §4.2 disposition code", () => {
        const f = stageFunnel(apps);
        expect(f.find((s) => s.stage === "screening").dropOffByDisposition).toEqual({ SKILLS_MISMATCH: 1 });
    });

    it("an uncoded drop-off reports UNCODED rather than vanishing", () => {
        const f = stageFunnel([
            {
                applicationId: 9, currentStage: "rejected", appliedAt: d("2026-01-01"), history: [
                    { fromStage: "applied", toStage: "rejected", createdAt: d("2026-01-02") },
                ], dispositionReasonCode: null,
            },
        ]);
        expect(f.find((s) => s.stage === "applied").dropOffByDisposition).toEqual({ UNCODED: 1 });
    });
});

describe("Offer Acceptance (§6 row 8)", () => {
    it("accepted ÷ final outcomes; DECLINED and EXPIRED shown separately", () => {
        const r = offerAcceptance([
            { status: "ACCEPTED" }, { status: "ACCEPTED" }, { status: "ACCEPTED" },
            { status: "DECLINED" },
            { status: "EXPIRED" },
            { status: "SENT" },
        ]);
        expect(r).toMatchObject({
            ACCEPTED: 3, DECLINED: 1, EXPIRED: 1, SENT: 1,
            finalOutcomes: 5,
            acceptanceRatePct: 60,
            declineRatePct: 20,
            expiryRatePct: 20,
            pending: 1,
        });
    });

    it("in-flight offers never count as refusals", () => {
        const r = offerAcceptance([{ status: "SENT" }, { status: "SENT" }]);
        expect(r.finalOutcomes).toBe(0);
        expect(r.acceptanceRatePct).toBeNull();
        expect(r.pending).toBe(2);
    });
});

describe("Source Effectiveness (§6 row 9)", () => {
    it("publishes only formula-backed figures — no composite score", () => {
        const rows = sourceEffectiveness([
            { source: "Referral", applicationId: 1, enteredInterview: true, isHire: true, timeToHireDays: 20 },
            { source: "Referral", applicationId: 2, enteredInterview: true, isHire: false, timeToHireDays: null },
            { source: "Job board", applicationId: 3, enteredInterview: false, isHire: false, timeToHireDays: null },
        ]);
        expect(rows).toEqual([
            expect.objectContaining({
                source: "Referral", applications: 2, qualified: 2, hires: 1,
                qualificationRatePct: 100, hireRatePct: 50, medianTimeToHireDays: 20,
            }),
            expect.objectContaining({
                source: "Job board", applications: 1, qualified: 0, hires: 0,
                qualificationRatePct: 0, hireRatePct: 0, medianTimeToHireDays: null,
            }),
        ]);
        for (const row of rows) expect(row.score).toBeUndefined();
    });
});
