// src/lib/test-band.util.js
//
// Phase 3b — the pure rules of one on-site test sitting: the session and
// assessment vocabularies, the server-authoritative clock, section scoring,
// negative marking, the result band and the percentile. No DB, no I/O, so the
// kiosk endpoints, the proctor tools, the scorer and the minute job all decide
// identically (plan 7.3.4 to 7.3.6).
//
// The clock. deadlineAt is fixed on the server when the first real item is
// served: startedAt + duration x (1 + extraTimePct / 100). A pause never moves
// deadlineAt; the time spent paused is added on top (pausedTotalSec, plus the
// running pause while pausedAt is set), so remaining time freezes during a
// pause and resumes where it stopped. A recruiter's extension moves deadlineAt,
// capped so the sitting never exceeds duration x (1 + maxExtraTimePct / 100).
//
// The bands (plan table "Result"):
//   INCOMPLETE  voided, expired or abandoned (no scored attempt)
//   REVIEW      integrity flags above the blueprint threshold, whatever the score
//   FAILED      any must-pass section failed, or below the borderline band
//   PASSED      at or above the pass mark (all must-pass sections passed)
//   BORDERLINE  inside the band below the pass mark (must-pass passed)
import { isAnswerShapeValid, scoreItemAnswer } from "./test-scoring.util.js";

export const SESSION_STATUS = Object.freeze({
    ISSUED: "ISSUED",
    IN_PROGRESS: "IN_PROGRESS",
    PAUSED: "PAUSED",
    SUBMITTED: "SUBMITTED",
    EXPIRED: "EXPIRED",
    VOIDED: "VOIDED",
});

/** A session that still holds the interview's kiosk slot. */
export const LIVE_SESSION_STATUSES = Object.freeze([SESSION_STATUS.ISSUED, SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.PAUSED]);

/** Interview.assessmentStatus (CHECK interviews_assessmentStatus_check). */
export const ASSESSMENT_STATUS = Object.freeze({
    NOT_REQUIRED: "NOT_REQUIRED",
    REQUIRED: "REQUIRED",
    CHECKED_IN: "CHECKED_IN",
    IN_PROGRESS: "IN_PROGRESS",
    PASSED: "PASSED",
    BORDERLINE: "BORDERLINE",
    FAILED: "FAILED",
    REVIEW: "REVIEW",
    INCOMPLETE: "INCOMPLETE",
    RELEASED: "RELEASED",
    OVERRIDDEN: "OVERRIDDEN",
    WAIVED: "WAIVED",
});

export const RESULT_BAND = Object.freeze({
    PASSED: "PASSED",
    BORDERLINE: "BORDERLINE",
    FAILED: "FAILED",
    REVIEW: "REVIEW",
    INCOMPLETE: "INCOMPLETE",
});

/** Bands the interview cannot proceed on without a recruiter decision. */
export const DECISION_REQUIRED_BANDS = Object.freeze([RESULT_BAND.FAILED, RESULT_BAND.REVIEW, RESULT_BAND.INCOMPLETE]);

export const RESULT_DECISION = Object.freeze({
    PROCEED: "PROCEED",
    RELEASE: "RELEASE",
    OVERRIDE: "OVERRIDE",
    RETEST: "RETEST",
    WAIVE: "WAIVE",
});

export const INTEGRITY_TYPE = Object.freeze({
    FOCUS_LOST: "FOCUS_LOST",
    FULLSCREEN_EXIT: "FULLSCREEN_EXIT",
    NETWORK_LOSS: "NETWORK_LOSS",
    RAPID_ANSWER: "RAPID_ANSWER",
    DEVICE_CHANGE: "DEVICE_CHANGE",
    PROCTOR_PAUSE: "PROCTOR_PAUSE",
    PROCTOR_VOID: "PROCTOR_VOID",
});

// The candidate-side signals that count as integrity flags. Proctor actions
// (pause, void) are on the timeline but are not the candidate's flags.
export const FLAG_INTEGRITY_TYPES = Object.freeze([
    INTEGRITY_TYPE.FOCUS_LOST,
    INTEGRITY_TYPE.FULLSCREEN_EXIT,
    INTEGRITY_TYPE.NETWORK_LOSS,
    INTEGRITY_TYPE.RAPID_ANSWER,
    INTEGRITY_TYPE.DEVICE_CHANGE,
]);

// What a kiosk may report itself; RAPID_ANSWER and DEVICE_CHANGE are computed
// by the server, so a kiosk cannot forge or suppress them.
export const KIOSK_INTEGRITY_TYPES = Object.freeze([
    INTEGRITY_TYPE.FOCUS_LOST,
    INTEGRITY_TYPE.FULLSCREEN_EXIT,
    INTEGRITY_TYPE.NETWORK_LOSS,
]);

export const DEFAULT_NEGATIVE_MARK_FRACTION = 0.25;

const SECOND = 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const time = (v) => (v == null ? null : new Date(v).getTime());

// ── The clock ────────────────────────────────────────────────────────────────

/** Seconds the candidate gets: duration x (1 + extra time). */
export function sittingSeconds(durationMin, extraTimePct = 0) {
    const minutes = Math.max(0, Number(durationMin) || 0);
    const extra = clamp(Number(extraTimePct) || 0, 0, 100);
    return Math.round(minutes * 60 * (1 + extra / 100));
}

/** The server deadline fixed when the clock starts. */
export function deadlineFrom(startedAt, durationMin, extraTimePct = 0) {
    return new Date(time(startedAt) + sittingSeconds(durationMin, extraTimePct) * SECOND);
}

/** Paused seconds so far, including a pause still running at `now`. */
export function pausedSecondsAt(session, now) {
    const banked = Math.max(0, Number(session?.pausedTotalSec) || 0);
    if (!session?.pausedAt) return banked;
    return banked + Math.max(0, Math.floor((time(now) - time(session.pausedAt)) / SECOND));
}

/** deadlineAt pushed out by the paused time; null until the clock starts. */
export function effectiveDeadline(session, now) {
    if (!session?.deadlineAt) return null;
    return new Date(time(session.deadlineAt) + pausedSecondsAt(session, now) * SECOND);
}

/**
 * Seconds left. Before the clock starts it is the whole sitting.
 * @param {object} session  { startedAt, deadlineAt, pausedAt, pausedTotalSec, extraTimePct }
 * @param {Date} now
 * @param {number} durationMin  the blueprint's duration
 */
export function remainingSeconds(session, now, durationMin) {
    if (!session?.startedAt || !session?.deadlineAt) return sittingSeconds(durationMin, session?.extraTimePct);
    const left = time(effectiveDeadline(session, now)) - time(now);
    return Math.max(0, Math.ceil(left / SECOND));
}

/** Has a running sitting passed its deadline? A paused one never has. */
export function isPastDeadline(session, now) {
    if (!session?.deadlineAt || session?.pausedAt) return false;
    return time(now) >= time(effectiveDeadline(session, now));
}

/** Seconds actually spent on the test (excluding pauses). */
export function timeTakenSeconds(session, endedAt) {
    if (!session?.startedAt) return null;
    const gross = Math.floor((time(endedAt) - time(session.startedAt)) / SECOND);
    return Math.max(0, gross - pausedSecondsAt(session, endedAt));
}

/**
 * Can a started sitting be extended by `minutes`? The whole sitting (deadline
 * minus start) may not exceed duration x (1 + maxExtraTimePct / 100).
 * @returns {{ ok: true, deadlineAt: Date } | { ok: false, maxDeadlineAt: Date }}
 */
export function extendDeadline({ startedAt, deadlineAt, durationMin, maxExtraTimePct, minutes }) {
    const capped = deadlineFrom(startedAt, durationMin, maxExtraTimePct);
    const next = new Date(time(deadlineAt) + Math.max(0, Number(minutes) || 0) * 60 * SECOND);
    if (time(next) > time(capped)) return { ok: false, maxDeadlineAt: capped };
    return { ok: true, deadlineAt: next };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const sectionPassMark = (section, blueprint) => {
    const own = Number(section?.sectionPassMarkPct);
    return Number.isFinite(own) ? own : Number(blueprint?.passMarkPct ?? 60);
};

/** An answer only counts when it is well formed (a flag-only save is not an answer). */
const usableAnswer = (type, answer) => (isAnswerShapeValid(type, answer) ? answer : null);

/**
 * Score one sitting.
 *
 * @param {object} args
 * @param {Array<{ itemId:number, sectionKey:string, type:string, answerKey:object, scoringRule?:object }>} args.items
 *   the drawn items in order, answer keys decrypted and parsed
 * @param {Array<{ itemId:number, answer:object }>} args.responses
 * @param {object} args.blueprint  { sections, passMarkPct, borderlineBandPct, negativeMarking, negativeMarkFraction, integrityFlagThreshold }
 * @param {number} [args.integrityFlagCount]
 * @returns {{ rawScore:number, maxScore:number, scorePct:number, sectionScores:Array, mustPassFailed:boolean,
 *             band:string, integrityFlagCount:number, answeredCount:number, correctCount:number }}
 */
export function scoreSession({ items = [], responses = [], blueprint = {}, integrityFlagCount = 0 }) {
    const answers = new Map(responses.map((r) => [Number(r.itemId), r.answer]));
    const penalty = blueprint.negativeMarking
        ? clamp(Number(blueprint.negativeMarkFraction ?? DEFAULT_NEGATIVE_MARK_FRACTION) || 0, 0, 1)
        : 0;

    const sections = Array.isArray(blueprint.sections) ? blueprint.sections : [];
    const totals = new Map(sections.map((s) => [String(s.key), { raw: 0, max: 0 }]));
    let raw = 0;
    let answeredCount = 0;
    let correctCount = 0;

    for (const item of items) {
        const answer = usableAnswer(item.type, answers.get(Number(item.itemId)));
        const outcome = scoreItemAnswer(item, answer);
        // Negative marking deducts only for a wrong answer, never for a blank.
        const points = outcome.credit - (outcome.answered && outcome.credit === 0 ? penalty : 0);
        if (outcome.answered) answeredCount += 1;
        if (outcome.correct) correctCount += 1;
        raw += points;
        const key = String(item.sectionKey ?? "");
        if (!totals.has(key)) totals.set(key, { raw: 0, max: 0 });
        const bucket = totals.get(key);
        bucket.raw += points;
        bucket.max += 1;
    }

    const maxScore = items.length;
    const rawScore = round2(Math.max(0, raw));
    const scorePct = maxScore ? round2(clamp((rawScore / maxScore) * 100, 0, 100)) : 0;

    const sectionScores = sections.map((section) => {
        const bucket = totals.get(String(section.key)) ?? { raw: 0, max: 0 };
        const passMarkPct = sectionPassMark(section, blueprint);
        const pct = bucket.max ? round2(clamp((Math.max(0, bucket.raw) / bucket.max) * 100, 0, 100)) : null;
        return {
            key: String(section.key),
            label: section.label ?? String(section.key),
            competencyKey: section.competencyKey ?? null,
            rawScore: round2(Math.max(0, bucket.raw)),
            maxScore: bucket.max,
            scorePct: pct,
            passMarkPct,
            // A section with no drawn items has no evidence against the candidate.
            passed: pct === null ? true : pct >= passMarkPct,
            mustPass: section.mustPass === true,
        };
    });
    const mustPassFailed = sectionScores.some((s) => s.mustPass && !s.passed);
    const flags = Math.max(0, Number(integrityFlagCount) || 0);
    const band = assignBand({ scorePct, mustPassFailed, integrityFlagCount: flags, blueprint });

    return { rawScore, maxScore, scorePct, sectionScores, mustPassFailed, band, integrityFlagCount: flags, answeredCount, correctCount };
}

/** The band for a scored sitting (see the module header). */
export function assignBand({ scorePct, mustPassFailed = false, integrityFlagCount = 0, blueprint = {}, incomplete = false }) {
    if (incomplete) return RESULT_BAND.INCOMPLETE;
    const threshold = Math.max(0, Number(blueprint.integrityFlagThreshold ?? 3));
    if (Number(integrityFlagCount) > threshold) return RESULT_BAND.REVIEW;
    if (mustPassFailed) return RESULT_BAND.FAILED;
    const passMark = Number(blueprint.passMarkPct ?? 60);
    const band = Math.max(0, Number(blueprint.borderlineBandPct ?? 10));
    if (scorePct >= passMark) return RESULT_BAND.PASSED;
    if (scorePct >= passMark - band) return RESULT_BAND.BORDERLINE;
    return RESULT_BAND.FAILED;
}

/**
 * Release without a person: only when the blueprint opts in, the score is
 * below its hard floor and the sitting raised no integrity flag at all.
 */
export function shouldAutoRelease({ blueprint = {}, scorePct, integrityFlagCount = 0, band }) {
    if (blueprint.autoReleaseBelowFloor !== true) return false;
    const floor = blueprint.hardFloorPct;
    if (floor === null || floor === undefined || !Number.isFinite(Number(floor))) return false;
    if (band !== RESULT_BAND.FAILED) return false;
    return Number(integrityFlagCount) === 0 && Number(scorePct) < Number(floor);
}

/**
 * Percentile rank of `score` among the requisition's other scored results:
 * (below + half of ties) / (others + self) x 100. Null with no comparison.
 */
export function percentileRank(score, others = []) {
    const list = others.map(Number).filter(Number.isFinite);
    if (!list.length) return null;
    const below = list.filter((s) => s < score).length;
    const ties = list.filter((s) => s === score).length + 1; // the candidate is a tie with themself
    return Math.round(((below + ties / 2) / (list.length + 1)) * 1000) / 10;
}
