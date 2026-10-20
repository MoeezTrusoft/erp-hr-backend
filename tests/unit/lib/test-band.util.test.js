// Recruitment Phase 3b (stream I) — the pure sitting rules: the server clock
// (deadline, pauses, extension cap), section scoring with negative marking
// and partial credit, every band, auto-release and the percentile.
import { describe, it, expect } from "@jest/globals";

import {
    assignBand,
    deadlineFrom,
    effectiveDeadline,
    extendDeadline,
    isPastDeadline,
    percentileRank,
    remainingSeconds,
    scoreSession,
    shouldAutoRelease,
    sittingSeconds,
    timeTakenSeconds,
} from "../../../src/lib/test-band.util.js";

const T0 = new Date("2026-10-20T05:00:00.000Z");
const at = (min, sec = 0) => new Date(T0.getTime() + min * 60000 + sec * 1000);
const KEY_A = { optionIds: ["a"] };

const blueprint = (over = {}) => ({
    passMarkPct: 60,
    borderlineBandPct: 10,
    integrityFlagThreshold: 2,
    sections: [
        { key: "domain", label: "Domain", competencyKey: "DOMAIN" },
        { key: "safety", label: "Safety", competencyKey: "SAFETY", mustPass: true, sectionPassMarkPct: 50 },
    ],
    ...over,
});

// 8 domain items and 2 safety items, all keyed "a".
const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ itemId: i + 1, sectionKey: "domain", type: "SINGLE", answerKey: KEY_A })),
    { itemId: 9, sectionKey: "safety", type: "SINGLE", answerKey: KEY_A },
    { itemId: 10, sectionKey: "safety", type: "SINGLE", answerKey: KEY_A },
];
const responses = (rightIds, wrongIds = []) => [
    ...rightIds.map((itemId) => ({ itemId, answer: { optionId: "a" } })),
    ...wrongIds.map((itemId) => ({ itemId, answer: { optionId: "b" } })),
];

describe("the clock", () => {
    it("fixes the deadline at duration x (1 + extra time)", () => {
        expect(sittingSeconds(30, 0)).toBe(1800);
        expect(sittingSeconds(30, 50)).toBe(2700);
        expect(deadlineFrom(T0, 30, 20)).toEqual(at(36));
    });

    it("adds banked and running pauses on top of the deadline", () => {
        const session = { startedAt: T0, deadlineAt: at(30), pausedTotalSec: 300, pausedAt: null };
        expect(effectiveDeadline(session, at(10))).toEqual(at(35));
        expect(remainingSeconds(session, at(10), 30)).toBe(25 * 60);
        const paused = { ...session, pausedAt: at(10) };
        expect(remainingSeconds(paused, at(20), 30)).toBe(25 * 60); // frozen while paused
        expect(isPastDeadline(paused, at(50))).toBe(false); // never while paused
        expect(isPastDeadline(session, at(34, 59))).toBe(false);
        expect(isPastDeadline(session, at(35))).toBe(true);
        expect(timeTakenSeconds(session, at(20))).toBe(15 * 60);
    });

    it("gives the whole sitting before the clock starts", () => {
        expect(remainingSeconds({ startedAt: null, extraTimePct: 10 }, at(5), 30)).toBe(1980);
    });

    it("caps an extension at duration x (1 + maxExtraTimePct)", () => {
        const base = { startedAt: T0, deadlineAt: at(30), durationMin: 30, maxExtraTimePct: 50 };
        expect(extendDeadline({ ...base, minutes: 15 })).toEqual({ ok: true, deadlineAt: at(45) });
        expect(extendDeadline({ ...base, minutes: 16 })).toMatchObject({ ok: false, maxDeadlineAt: at(45) });
    });
});

describe("scoreSession and the bands", () => {
    it("PASSED at or above the pass mark with must-pass passed", () => {
        const out = scoreSession({ items, responses: responses([1, 2, 3, 4, 5, 9]), blueprint: blueprint() });
        expect(out).toMatchObject({ rawScore: 6, maxScore: 10, scorePct: 60, band: "PASSED", mustPassFailed: false, answeredCount: 6, correctCount: 6 });
        expect(out.sectionScores).toEqual([
            expect.objectContaining({ key: "domain", scorePct: 62.5, passMarkPct: 60, passed: true, mustPass: false }),
            expect.objectContaining({ key: "safety", scorePct: 50, passMarkPct: 50, passed: true, mustPass: true }),
        ]);
    });

    it("BORDERLINE inside the band below the pass mark", () => {
        expect(scoreSession({ items, responses: responses([1, 2, 3, 4, 9]), blueprint: blueprint() }).band).toBe("BORDERLINE");
    });

    it("FAILED below the band", () => {
        expect(scoreSession({ items, responses: responses([1, 2, 3, 9]), blueprint: blueprint() })).toMatchObject({ scorePct: 40, band: "FAILED" });
    });

    it("FAILED when a must-pass section fails, whatever the total", () => {
        const out = scoreSession({ items, responses: responses([1, 2, 3, 4, 5, 6, 7, 8]), blueprint: blueprint() });
        expect(out).toMatchObject({ scorePct: 80, mustPassFailed: true, band: "FAILED" });
    });

    it("REVIEW above the integrity threshold, whatever the score", () => {
        const all = responses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(scoreSession({ items, responses: all, blueprint: blueprint(), integrityFlagCount: 2 }).band).toBe("PASSED");
        expect(scoreSession({ items, responses: all, blueprint: blueprint(), integrityFlagCount: 3 }).band).toBe("REVIEW");
        expect(assignBand({ scorePct: 0, integrityFlagCount: 1, blueprint: blueprint({ integrityFlagThreshold: 0 }) })).toBe("REVIEW");
    });

    it("INCOMPLETE for a sitting with nothing to score", () => {
        expect(assignBand({ scorePct: 100, incomplete: true, blueprint: blueprint() })).toBe("INCOMPLETE");
    });

    it("deducts for wrong answers only when negative marking is on, never for blanks, never below 0", () => {
        const rs = responses([1, 2, 3, 4, 5, 6, 9, 10], [7]);
        expect(scoreSession({ items, responses: rs, blueprint: blueprint() }).rawScore).toBe(8);
        expect(scoreSession({ items, responses: rs, blueprint: blueprint({ negativeMarking: true }) }).rawScore).toBe(7.75);
        expect(scoreSession({ items, responses: rs, blueprint: blueprint({ negativeMarking: true, negativeMarkFraction: 1 }) }).rawScore).toBe(7);
        const allWrong = responses([], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(scoreSession({ items, responses: allWrong, blueprint: blueprint({ negativeMarking: true }) })).toMatchObject({ rawScore: 0, scorePct: 0 });
    });

    it("gives MULTI partial credit by the item's rule and ignores a flag-only save", () => {
        const multi = [{ itemId: 1, sectionKey: "domain", type: "MULTI", answerKey: { optionIds: ["a", "b"] }, scoringRule: { multi: "PARTIAL" } }];
        const out = scoreSession({ items: multi, responses: [{ itemId: 1, answer: { optionIds: ["a"] } }], blueprint: blueprint({ sections: [{ key: "domain" }] }) });
        expect(out).toMatchObject({ rawScore: 0.5, scorePct: 50 });
        const flagOnly = scoreSession({ items, responses: [{ itemId: 1, answer: {} }], blueprint: blueprint({ negativeMarking: true }) });
        expect(flagOnly).toMatchObject({ rawScore: 0, answeredCount: 0 });
    });
});

describe("auto-release and percentile", () => {
    it("auto-releases only below the hard floor, on a FAILED band, with no flag, when enabled", () => {
        const bp = blueprint({ autoReleaseBelowFloor: true, hardFloorPct: 30 });
        expect(shouldAutoRelease({ blueprint: bp, scorePct: 20, integrityFlagCount: 0, band: "FAILED" })).toBe(true);
        expect(shouldAutoRelease({ blueprint: bp, scorePct: 20, integrityFlagCount: 1, band: "FAILED" })).toBe(false);
        expect(shouldAutoRelease({ blueprint: bp, scorePct: 30, integrityFlagCount: 0, band: "FAILED" })).toBe(false);
        expect(shouldAutoRelease({ blueprint: bp, scorePct: 20, integrityFlagCount: 0, band: "REVIEW" })).toBe(false);
        expect(shouldAutoRelease({ blueprint: { ...bp, autoReleaseBelowFloor: false }, scorePct: 1, band: "FAILED" })).toBe(false);
        expect(shouldAutoRelease({ blueprint: { ...bp, hardFloorPct: null }, scorePct: 1, band: "FAILED" })).toBe(false);
    });

    it("ranks against the requisition's other scores", () => {
        expect(percentileRank(70, [])).toBeNull();
        expect(percentileRank(70, [50, 60, 80])).toBe(62.5);
        expect(percentileRank(90, [50, 60, 80])).toBe(87.5);
        expect(percentileRank(70, [70])).toBe(50);
    });
});
