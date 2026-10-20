// tests/unit/lib/recruitment-alerts.util.test.js
//
// Phase 5 — the pure alert rules: threshold validation, the rolling window and
// its periodStart key, and what one evaluation does to an existing alert.
import { describe, it, expect } from "@jest/globals";

import {
    ALERT_METRICS,
    alertWindow,
    isBreached,
    isRecruitingLeadTitle,
    mergeThresholds,
    normalizeAlertThresholdsInput,
    planAlertTransition,
    readStoredThresholds,
    watchedMetrics,
} from "../../../src/lib/recruitment-alerts.util.js";

describe("thresholds", () => {
    it("accepts the four keys within range, null clears, absent is untouched", () => {
        expect(normalizeAlertThresholdsInput({ timeToFillDays: 45, offerDeclineRatePct: "25.5", failedHandoffs: 0, slaBreaches: null })).toEqual({
            timeToFillDays: 45, offerDeclineRatePct: 25.5, failedHandoffs: 0, slaBreaches: null,
        });
        expect(normalizeAlertThresholdsInput({})).toEqual({});
    });

    it.each([
        [{ timeToFillDays: 0 }],
        [{ timeToFillDays: 400 }],
        [{ offerDeclineRatePct: 101 }],
        [{ slaBreaches: 1.5 }],
        [{ failedHandoffs: -1 }],
        [{ failedHandoffs: true }],
        [{ failedHandoffs: "" }],
        [{ other: 1 }],
    ])("refuses %j", (input) => {
        expect(() => normalizeAlertThresholdsInput(input)).toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-ALERTS-INVALID" }));
    });

    it("refuses a non-object", () => {
        expect(() => normalizeAlertThresholdsInput(null)).toThrow(/object/);
        expect(() => normalizeAlertThresholdsInput([1])).toThrow(/object/);
    });

    it("reads stored JSON tolerantly and merges a change", () => {
        expect(readStoredThresholds({ timeToFillDays: 30, slaBreaches: "x", junk: 1 })).toEqual({ timeToFillDays: 30 });
        expect(readStoredThresholds(null)).toEqual({});
        expect(mergeThresholds({ timeToFillDays: 30, failedHandoffs: 1 }, { failedHandoffs: null, slaBreaches: 2 })).toEqual({
            timeToFillDays: 30, slaBreaches: 2,
        });
        expect(watchedMetrics({ slaBreaches: 2, failedHandoffs: 0 })).toEqual(["SLA_BREACHES", "FAILED_HANDOFFS"]);
        expect(ALERT_METRICS).toEqual(["TIME_TO_FILL", "SLA_BREACHES", "OFFER_DECLINE_RATE", "FAILED_HANDOFFS"]);
    });
});

describe("window", () => {
    it("is the rolling 30 days ending now, keyed by the UTC day it starts on", () => {
        const w = alertWindow(new Date("2026-10-20T10:30:00Z"));
        expect(w.to.toISOString()).toBe("2026-10-20T10:30:00.000Z");
        expect(w.from.toISOString()).toBe("2026-09-20T10:30:00.000Z");
        expect(w.periodStart.toISOString()).toBe("2026-09-20T00:00:00.000Z");
        // Every hourly run on the same day keys new alerts the same way.
        expect(alertWindow(new Date("2026-10-20T23:00:00Z")).periodStart.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    });
});

describe("transition", () => {
    const OPEN = { id: 1, status: "OPEN" };
    it("breach is strictly above the threshold", () => {
        expect(isBreached(5, 5)).toBe(false);
        expect(isBreached(5.1, 5)).toBe(true);
        expect(isBreached(1, 0)).toBe(true);
        expect(isBreached(null, 0)).toBe(false);
    });

    it.each([
        ["no alert, breached → CREATE and announce", { value: 3, threshold: 1 }, { action: "CREATE", emit: true }],
        ["no alert, under → nothing", { value: 1, threshold: 1 }, { action: "NONE", emit: false }],
        ["no alert, no data → nothing", { value: null, threshold: 1 }, { action: "NONE", emit: false }],
        ["active, breached → TOUCH, no announcement", { active: OPEN, value: 3, threshold: 1 }, { action: "TOUCH", emit: false }],
        ["active, back under → RESOLVE", { active: OPEN, value: 0, threshold: 1 }, { action: "RESOLVE", emit: false }],
        ["active, no data → leave it", { active: OPEN, value: null, threshold: 1 }, { action: "NONE", emit: false }],
        ["resolved today, breached again → REOPEN and announce", { samePeriod: { id: 2, status: "RESOLVED" }, value: 3, threshold: 1 }, { action: "REOPEN", emit: true }],
    ])("%s", (_label, input, expected) => {
        expect(planAlertTransition(input)).toEqual(expected);
    });
});

describe("recruiting lead title", () => {
    it.each([
        ["Recruitment Lead", true],
        ["Head of Talent Acquisition", true],
        ["Recruiting Manager", true],
        ["Recruiter", false],
        ["Engineering Manager", false],
        [null, false],
    ])("%s → %s", (title, expected) => {
        expect(isRecruitingLeadTitle(title)).toBe(expected);
    });
});
