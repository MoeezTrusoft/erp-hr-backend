// src/services/test-item-stats.service.js
//
// Recruitment Phase 3b — the NIGHTLY ITEM STATISTICS job (03:30, flag
// onsiteTest). For every PUBLISHED item with scored responses in the window
// it writes one CandidateTestItemStat row per run date (unique itemId +
// period, so a re-run the same day overwrites rather than duplicates):
//
//   sampleSize       answered responses in the window whose session was scored
//                    (has a CandidateTestResult)
//   difficulty       proportion correct (scoreItemAnswer's `correct`, the same
//                    rule the session scorer uses; PARTIAL credit is not
//                    "correct" here)
//   discrimination   point-biserial correlation of item correctness with the
//                    session's total scorePct; null when either does not vary
//   distractorRates  { optionId: share of answered responses that picked it }
//                    for choice items (every option, the key included, so a
//                    reviewer sees the full picture); null for NUMERIC
//   avgTimeSec       mean time spent on the item
//
// Flags, only once the window holds at least 30 responses:
//   TOO_EASY            difficulty > 0.95
//   TOO_HARD            difficulty < 0.15
//   LOW_DISCRIMINATION  discrimination < 0.1
//   LEAKAGE_SUSPECTED   the correct rate rose by more than 0.25 against the
//                       previous window of the same length, which also needs
//                       at least 30 responses. Consecutive nightly windows
//                       overlap almost entirely, so the comparison is with the
//                       window before this one, not with yesterday's row.
// hr.recruitment.test_item_flagged.v1 is emitted only for flags the item did
// not already carry (previous run or an earlier run today), so re-running a
// night does not repeat the event.
//
// The answer key is decrypted (by the C4 extension) inside this job only and
// never logged. Cross-tenant scan under SYSTEM, per-item work under the
// item's tenant, per-item error isolation.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { scoreItemAnswer } from "../lib/test-scoring.util.js";
import { ITEM_STATUS, decodeAnswerKey } from "../lib/test-item.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { TEST_ITEM_EVENTS, testItemEvent } from "./test-item.service.js";

const log = logger.child({ component: "test-item-stats" });

export const STAT_THRESHOLDS = Object.freeze({
    minSample: 30,
    tooEasy: 0.95,
    tooHard: 0.15,
    lowDiscrimination: 0.1,
    leakageJump: 0.25,
});
export const STAT_FLAGS = Object.freeze({
    TOO_EASY: "TOO_EASY",
    TOO_HARD: "TOO_HARD",
    LOW_DISCRIMINATION: "LOW_DISCRIMINATION",
    LEAKAGE_SUSPECTED: "LEAKAGE_SUSPECTED",
});

const DAY_MS = 86_400_000;
const round = (value, places = 4) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Point-biserial correlation of a 0/1 variable with a continuous one:
 * (M1 - M0) / s * sqrt(p * q), s the population standard deviation of x.
 * @returns {number|null} null when either variable is constant
 */
export function pointBiserial(correct, totals) {
    const n = totals.length;
    if (!n || correct.length !== n) return null;
    const p = correct.filter(Boolean).length / n;
    if (p === 0 || p === 1) return null;
    const m = mean(totals);
    const s = Math.sqrt(totals.reduce((acc, x) => acc + (x - m) ** 2, 0) / n);
    if (!(s > 0)) return null;
    const m1 = mean(totals.filter((_, i) => correct[i]));
    const m0 = mean(totals.filter((_, i) => !correct[i]));
    return ((m1 - m0) / s) * Math.sqrt(p * (1 - p));
}

function selectedOptionIds(type, answer) {
    if (type === "MULTI") return Array.isArray(answer?.optionIds) ? [...new Set(answer.optionIds.map(String))] : [];
    return answer?.optionId !== undefined && answer?.optionId !== null ? [String(answer.optionId)] : [];
}

/**
 * The statistics of one item over its samples.
 * @param {{ type: string, options?: Array<{ id: string }>|null, answerKey: object, scoringRule?: object|null }} item  key decrypted
 * @param {Array<{ answer: object|null, timeSpentSec?: number, totalScorePct: number }>} samples
 */
export function computeItemStatistics(item, samples) {
    const answered = samples.filter((s) => scoreItemAnswer(item, s.answer).answered);
    const n = answered.length;
    if (!n) return { sampleSize: 0, difficulty: null, discrimination: null, distractorRates: null, avgTimeSec: null };
    const correct = answered.map((s) => scoreItemAnswer(item, s.answer).correct);
    const totals = answered.map((s) => Number(s.totalScorePct) || 0);
    let distractorRates = null;
    if (item.type !== "NUMERIC" && Array.isArray(item.options)) {
        const counts = Object.fromEntries(item.options.map((o) => [String(o.id), 0]));
        for (const s of answered) {
            for (const id of selectedOptionIds(item.type, s.answer)) if (id in counts) counts[id] += 1;
        }
        distractorRates = Object.fromEntries(Object.entries(counts).map(([id, c]) => [id, round(c / n)]));
    }
    return {
        sampleSize: n,
        difficulty: round(correct.filter(Boolean).length / n),
        discrimination: round(pointBiserial(correct, totals)),
        distractorRates,
        avgTimeSec: round(mean(answered.map((s) => Math.max(Number(s.timeSpentSec) || 0, 0))), 1),
    };
}

/**
 * The review flags for one item's statistics.
 * @param {{ sampleSize: number, difficulty: number|null, discrimination: number|null }} stats
 * @param {{ sampleSize: number, difficulty: number|null }|null} previous  the window before
 */
export function flagsFor(stats, previous = null, t = STAT_THRESHOLDS) {
    if (!stats || stats.sampleSize < t.minSample || stats.difficulty === null) return [];
    const flags = [];
    if (stats.difficulty > t.tooEasy) flags.push(STAT_FLAGS.TOO_EASY);
    if (stats.difficulty < t.tooHard) flags.push(STAT_FLAGS.TOO_HARD);
    if (stats.discrimination !== null && stats.discrimination < t.lowDiscrimination) flags.push(STAT_FLAGS.LOW_DISCRIMINATION);
    if (previous && previous.sampleSize >= t.minSample && previous.difficulty !== null && stats.difficulty - previous.difficulty > t.leakageJump) {
        flags.push(STAT_FLAGS.LEAKAGE_SUSPECTED);
    }
    return flags;
}

// Scored samples for one item since `from`: answered responses joined to the
// session's total score (sessions without a result are not scored yet).
async function loadSamples(tenantId, itemId, from, to) {
    const responses = await prisma.candidateTestResponse.findMany({
        where: withTenant(tenantId, { itemId, answeredAt: { gte: from, lte: to } }),
        select: { sessionId: true, answer: true, timeSpentSec: true, answeredAt: true },
    });
    if (!responses.length) return [];
    const sessionIds = [...new Set(responses.map((r) => r.sessionId))];
    const results = await prisma.candidateTestResult.findMany({
        where: withTenant(tenantId, { sessionId: { in: sessionIds } }),
        select: { sessionId: true, scorePct: true },
    });
    const scoreBySession = new Map(results.map((r) => [r.sessionId, r.scorePct]));
    return responses
        .filter((r) => scoreBySession.has(r.sessionId))
        .map((r) => ({ answer: r.answer, timeSpentSec: r.timeSpentSec, answeredAt: r.answeredAt, totalScorePct: scoreBySession.get(r.sessionId) }));
}

async function computeOneItem({ tenantId, itemId, at, from, prevFrom, period }) {
    const item = await prisma.candidateTestItem.findFirst({
        where: withTenant(tenantId, { id: itemId, status: ITEM_STATUS.PUBLISHED }),
        select: { id: true, tenantId: true, itemCode: true, version: true, type: true, options: true, scoringRule: true, answerKey: true },
    });
    if (!item) return "skipped";
    const answerKey = decodeAnswerKey(item.answerKey);
    if (!answerKey) throw new Error("answer key unreadable");
    const scored = { type: item.type, options: item.options, scoringRule: item.scoringRule, answerKey };

    const samples = await loadSamples(tenantId, item.id, prevFrom, at);
    const current = samples.filter((s) => new Date(s.answeredAt).getTime() >= from.getTime());
    const stats = computeItemStatistics(scored, current);
    if (!stats.sampleSize) return "skipped";
    const previous = computeItemStatistics(scored, samples.filter((s) => new Date(s.answeredAt).getTime() < from.getTime()));
    const flags = flagsFor(stats, previous);

    const earlier = await prisma.candidateTestItemStat.findMany({
        where: withTenant(tenantId, { itemId: item.id, period: { lte: period } }),
        select: { period: true, flags: true },
        orderBy: { period: "desc" },
        take: 2,
    });
    // Baseline: an earlier run today (a re-run) and the latest earlier night.
    const baseline = [earlier.find((r) => r.period === period), earlier.find((r) => r.period < period)].filter(Boolean);
    const known = new Set(baseline.flatMap((row) => row.flags ?? []));
    const newFlags = flags.filter((f) => !known.has(f));

    await tenantTransaction(
        prisma,
        async (tx) => {
            const data = { ...stats, distractorRates: stats.distractorRates ?? undefined, flags, computedAt: at };
            await tx.candidateTestItemStat.upsert({
                where: { itemId_period: { itemId: item.id, period } },
                create: { tenantId, itemId: item.id, period, ...data },
                update: data,
            });
            if (newFlags.length) {
                await enqueueHrDomainEvent(tx, testItemEvent(TEST_ITEM_EVENTS.FLAGGED, item, { flags: newFlags, period }));
            }
        },
        { tenantId },
    );
    return newFlags.length ? "flagged" : "computed";
}

/**
 * Compute the nightly statistics for published items, across tenants.
 * @param {{ now?: Date, windowDays?: number, limit?: number }} opts
 */
export async function runTestItemStatsJob({ now = new Date(), windowDays = 90, limit = 2000 } = {}) {
    if (!isRecruitmentFlagEnabled("onsiteTest")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const days = Math.min(Math.max(Number(windowDays) || 90, 1), 365);
    const from = new Date(at.getTime() - days * DAY_MS);
    const prevFrom = new Date(at.getTime() - 2 * days * DAY_MS);
    const period = at.toISOString().slice(0, 10);
    const take = Math.min(Math.max(Number(limit) || 2000, 1), 10000);
    const summary = { period, windowDays: days, scanned: 0, computed: 0, flagged: 0, skipped: 0, errors: 0 };

    const items = await mcpCtx.run({ system: true }, async () =>
        await prisma.candidateTestItem.findMany({
            where: { status: ITEM_STATUS.PUBLISHED },
            select: { id: true, tenantId: true },
            orderBy: [{ id: "asc" }],
            take,
        }),
    );
    summary.scanned = items.length;
    for (const row of items) {
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
                await computeOneItem({ tenantId: row.tenantId, itemId: row.id, at, from, prevFrom, period }),
            );
            summary[outcome] += 1;
            if (outcome === "flagged") summary.computed += 1;
        } catch (err) {
            summary.errors += 1;
            log.warn({ itemId: row.id, errMessage: err?.message }, "test item stats: item failed");
        }
    }
    if (summary.scanned) log.info(summary, "test item stats run");
    return summary;
}

export default { runTestItemStatsJob, computeItemStatistics, flagsFor, pointBiserial };
