// Phase 3b — the nightly item statistics: the maths on a known small dataset
// (difficulty, point-biserial, option rates, time), the flag thresholds and
// the minimum sample, leakage against the previous window, and the job (flag,
// tenant context, upsert per period, flagged event once, unscored sessions
// left out, per-item error isolation).
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createTestItemDb, createEventRecorder } from "./helpers/test-item.fake.js";

const { db, state } = createTestItemDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidateMatch.service.js", () => ({ loadAliasIndex: jest.fn(), requisitionSkillRequirements: jest.fn() }));

const { computeItemStatistics, flagsFor, pointBiserial, runTestItemStatsJob, STAT_THRESHOLDS } = await import("../../../src/services/test-item-stats.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T22:30:00.000Z");
const DAY = 86_400_000;
const SINGLE = { type: "SINGLE", options: [{ id: "a" }, { id: "b" }, { id: "c" }], answerKey: { optionIds: ["b"] } };

describe("statistics maths", () => {
    it("point-biserial on a known dataset", () => {
        // M1 = 70, M0 = 30, s = sqrt(500), p = 0.5 -> 40 / 22.3607 * 0.5
        expect(pointBiserial([true, true, false, false], [80, 60, 40, 20])).toBeCloseTo(0.894427, 5);
        expect(pointBiserial([true, true], [10, 20])).toBeNull(); // no variance in correctness
        expect(pointBiserial([true, false], [50, 50])).toBeNull(); // no variance in totals
    });

    it("difficulty, option rates and average time; unanswered responses are not counted", () => {
        const stats = computeItemStatistics(SINGLE, [
            { answer: { optionId: "b" }, timeSpentSec: 10, totalScorePct: 80 },
            { answer: { optionId: "b" }, timeSpentSec: 20, totalScorePct: 60 },
            { answer: { optionId: "a" }, timeSpentSec: 30, totalScorePct: 40 },
            { answer: { optionId: "c" }, timeSpentSec: 40, totalScorePct: 20 },
            { answer: null, timeSpentSec: 99, totalScorePct: 0 },
        ]);
        expect(stats).toEqual({
            sampleSize: 4,
            difficulty: 0.5,
            discrimination: 0.8944,
            distractorRates: { a: 0.25, b: 0.5, c: 0.25 },
            avgTimeSec: 25,
        });
    });

    it("MULTI counts every picked option; NUMERIC has no option rates", () => {
        const multi = { type: "MULTI", options: [{ id: "a" }, { id: "b" }, { id: "c" }], answerKey: { optionIds: ["a", "b"] }, scoringRule: { multi: "PARTIAL" } };
        const stats = computeItemStatistics(multi, [
            { answer: { optionIds: ["a", "b"] }, totalScorePct: 90 },
            { answer: { optionIds: ["a"] }, totalScorePct: 50 }, // partial credit is not "correct"
        ]);
        expect(stats.difficulty).toBe(0.5);
        expect(stats.distractorRates).toEqual({ a: 1, b: 0.5, c: 0 });
        const numeric = computeItemStatistics({ type: "NUMERIC", answerKey: { value: 10, tolerance: 1 } }, [{ answer: { value: 10.5 }, totalScorePct: 70 }]);
        expect(numeric).toMatchObject({ difficulty: 1, distractorRates: null, discrimination: null });
    });

    it("flags at the thresholds, only with the minimum sample", () => {
        const n = STAT_THRESHOLDS.minSample;
        expect(flagsFor({ sampleSize: n, difficulty: 0.96, discrimination: 0.3 })).toEqual(["TOO_EASY"]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.95, discrimination: 0.3 })).toEqual([]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.14, discrimination: 0.3 })).toEqual(["TOO_HARD"]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.15, discrimination: 0.1 })).toEqual([]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.5, discrimination: 0.09 })).toEqual(["LOW_DISCRIMINATION"]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.5, discrimination: null })).toEqual([]);
        expect(flagsFor({ sampleSize: n - 1, difficulty: 0.99, discrimination: 0 })).toEqual([]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.8, discrimination: 0.3 }, { sampleSize: n, difficulty: 0.54 })).toEqual(["LEAKAGE_SUSPECTED"]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.8, discrimination: 0.3 }, { sampleSize: n, difficulty: 0.55 })).toEqual([]);
        expect(flagsFor({ sampleSize: n, difficulty: 0.8, discrimination: 0.3 }, { sampleSize: n - 1, difficulty: 0.1 })).toEqual([]);
    });
});

// ── The job ──────────────────────────────────────────────────────────────────

let seq = 1;
function seedItem({ id, tenantId = TENANT, status = "PUBLISHED", answerKey = JSON.stringify({ optionIds: ["b"] }) }) {
    state.items.push({ id, tenantId, itemCode: `TI-X-${id}`, version: 1, status, type: "SINGLE", options: [{ id: "a", text: "1" }, { id: "b", text: "2" }], scoringRule: null, answerKey });
}
// `correct` of `n` responses answered `daysAgo` before NOW; the correct ones
// come from the stronger sessions so discrimination is positive.
function seedResponses(itemId, { n, correct, daysAgo = 1, tenantId = TENANT, scored = true }) {
    for (let i = 0; i < n; i += 1) {
        const sessionId = seq++;
        const right = i < correct;
        state.responses.push({ id: seq++, tenantId, sessionId, itemId, itemVersion: 1, answer: { optionId: right ? "b" : "a" }, timeSpentSec: 30, answeredAt: new Date(NOW.getTime() - daysAgo * DAY) });
        if (scored) state.results.push({ id: seq++, tenantId, sessionId, scorePct: right ? 70 + (i % 5) : 40 + (i % 5) });
    }
}

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    events.length = 0;
    db.contextLog.length = 0;
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("runTestItemStatsJob", () => {
    it("does nothing when onsiteTest is off", async () => {
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        expect(await runTestItemStatsJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.contextLog).toHaveLength(0);
    });

    it("writes one row per item and period, under the item's tenant, and flags a too-easy item once", async () => {
        seedItem({ id: 1 });
        seedResponses(1, { n: 40, correct: 39 });
        seedResponses(1, { n: 5, correct: 0, scored: false }); // sessions not scored yet
        seedItem({ id: 2, tenantId: OTHER });
        seedResponses(2, { n: 10, correct: 5, tenantId: OTHER });
        seedItem({ id: 3, status: "DRAFT" });
        seedResponses(3, { n: 40, correct: 40 });

        const summary = await runTestItemStatsJob({ now: NOW });
        expect(summary).toMatchObject({ period: "2026-10-20", scanned: 2, computed: 2, flagged: 1, errors: 0 });
        const row = state.stats.find((s) => s.itemId === 1);
        expect(row).toMatchObject({ tenantId: TENANT, period: "2026-10-20", sampleSize: 40, difficulty: 0.975, flags: ["TOO_EASY"], distractorRates: { a: 0.025, b: 0.975 }, avgTimeSec: 30 });
        expect(row.discrimination).toBeGreaterThan(0.1);
        expect(state.stats.find((s) => s.itemId === 2)).toMatchObject({ tenantId: OTHER, sampleSize: 10, flags: [] });
        expect(events).toEqual([expect.objectContaining({
            eventName: "hr.recruitment.test_item_flagged.v1",
            tenantId: TENANT,
            aggregateId: 1,
            payload: { itemId: "1", itemCode: "TI-X-1", version: 1, flags: ["TOO_EASY"], period: "2026-10-20" },
        })]);
        // Item work ran in its tenant's context; only the scan ran as SYSTEM.
        expect(db.contextLog.filter((q) => q.system).map((q) => q.model)).toEqual(["candidateTestItem"]);
        expect(db.contextLog.filter((q) => q.model === "candidateTestResponse").map((q) => q.tenantId).sort()).toEqual([TENANT, OTHER].sort());

        const again = await runTestItemStatsJob({ now: NOW });
        expect(again).toMatchObject({ computed: 2, flagged: 0 });
        expect(state.stats).toHaveLength(2);
        expect(events).toHaveLength(1);
    });

    it("emits again only for a flag the item did not carry the night before", async () => {
        seedItem({ id: 1 });
        seedResponses(1, { n: 40, correct: 39 });
        state.stats.push({ id: 900, tenantId: TENANT, itemId: 1, period: "2026-10-19", sampleSize: 40, difficulty: 0.97, flags: ["TOO_EASY"] });
        await runTestItemStatsJob({ now: NOW });
        expect(events).toHaveLength(0);
        expect(state.stats.find((s) => s.period === "2026-10-20").flags).toEqual(["TOO_EASY"]);
    });

    it("needs 30 responses before flagging", async () => {
        seedItem({ id: 1 });
        seedResponses(1, { n: 29, correct: 29 });
        await runTestItemStatsJob({ now: NOW });
        expect(state.stats[0]).toMatchObject({ sampleSize: 29, difficulty: 1, flags: [] });
        expect(events).toHaveLength(0);
    });

    it("suspects leakage when the correct rate jumps against the previous window", async () => {
        seedItem({ id: 1 });
        seedResponses(1, { n: 40, correct: 20, daysAgo: 100 }); // previous 90-day window: 0.5
        seedResponses(1, { n: 40, correct: 32, daysAgo: 5 }); // this window: 0.8
        await runTestItemStatsJob({ now: NOW, windowDays: 90 });
        expect(state.stats[0]).toMatchObject({ sampleSize: 40, difficulty: 0.8, flags: ["LEAKAGE_SUSPECTED"] });
        expect(events[0].payload.flags).toEqual(["LEAKAGE_SUSPECTED"]);
    });

    it("skips items without responses in the window and isolates a failing item", async () => {
        seedItem({ id: 1 });
        seedResponses(1, { n: 5, correct: 2, daysAgo: 200 });
        seedItem({ id: 2, answerKey: "not json" });
        seedResponses(2, { n: 5, correct: 2 });
        seedItem({ id: 3 });
        seedResponses(3, { n: 5, correct: 2 });
        const summary = await runTestItemStatsJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 3, skipped: 1, errors: 1, computed: 1 });
        expect(state.stats.map((s) => s.itemId)).toEqual([3]);
    });
});
