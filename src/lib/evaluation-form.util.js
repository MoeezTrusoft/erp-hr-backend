// src/lib/evaluation-form.util.js
//
// Recruitment Phase 3b — the PURE rules of the interviewer's evaluation form
// (plan 7.4) and of the candidate evaluation report (7.4.5).
//
// No DB, no I/O. The services store templates and scorecards; this module owns
// the decisions so the form, the draft autosave, the submit, the report, the
// frozen snapshot and the PDF cannot drift:
//
//   * A form is a template with SECTIONS of CRITERIA. Each criterion has a
//     competency, a weight, a required flag, an optional must-have threshold,
//     an anchor for every level of its scale and linked question keys. A
//     section may be limited to panel roles; a panelist rates only those.
//   * Old templates (a plain criteria list, Phase 7) keep working: they read
//     as one section on the default 1 to 5 scale with no anchors.
//   * Weighted score = sum(rating x weight) / sum(scale max x weight) over the
//     ASSESSED criteria, as a percentage. "Not assessed" is allowed only on a
//     non-required criterion and drops out of both sums.
//   * Must-have: a rating at or below the threshold on a must-have criterion
//     fails it, whatever the weighted score; the form then suggests Not
//     recommended. The suggestion never decides anything.
//   * Evidence notes are required for extreme ratings (1, 2 or 5 on the
//     five-point scale) and for every must-have criterion.
//   * Consolidation: per-criterion average, min, max and spread; a spread of
//     2 or more on a five-point scale is a divergent criterion (half the
//     scale's range, rounded up, on other scales).
//   * Composite = test weight x test score + interview weight x interview
//     score; the test drops out when it was waived or not required.
//   * The assessment gate (7.7): an outcome needs the interview's
//     assessmentStatus to be one that lets the interview proceed.

import { ASSESSMENT_STATUS } from "./test-band.util.js";

export const PANEL_ROLES = Object.freeze(["TECHNICAL", "HIRING_MANAGER", "HR", "CULTURE"]);
export const FORM_RECOMMENDATIONS = Object.freeze(["STRONG_HIRE", "HIRE", "NO_HIRE", "STRONG_NO_HIRE"]);
export const INTERVIEW_DECISIONS = Object.freeze(["NEXT_ROUND", "HOLD", "REJECTED"]);
export const DECISIVE_DECISIONS = Object.freeze(["NEXT_ROUND", "REJECTED"]);
export const TEMPLATE_STATUS = Object.freeze({ DRAFT: "DRAFT", PUBLISHED: "PUBLISHED", RETIRED: "RETIRED" });
export const SCORECARD_STATUS = Object.freeze({ DRAFT: "DRAFT", SUBMITTED: "SUBMITTED" });
export const NOT_RECOMMENDED = "NOT_RECOMMENDED";
export const DEFAULT_TEST_WEIGHT_PCT = 30;

// 7.7 — the states in which the interview may proceed to an outcome.
export const ASSESSMENT_PROCEED_STATES = Object.freeze([
    ASSESSMENT_STATUS.NOT_REQUIRED,
    ASSESSMENT_STATUS.PASSED,
    ASSESSMENT_STATUS.BORDERLINE,
    ASSESSMENT_STATUS.OVERRIDDEN,
    ASSESSMENT_STATUS.WAIVED,
]);

export const DEFAULT_SCALE = Object.freeze({ kind: "POINTS", min: 1, max: 5 });
export const SCALE_PRESETS = Object.freeze({
    "1-5": DEFAULT_SCALE,
    "1-4": Object.freeze({ kind: "POINTS", min: 1, max: 4, forcedChoice: true }),
    YES_NO: Object.freeze({ kind: "YES_NO", min: 0, max: 1 }),
});

const MAX_SECTIONS = 12;
const MAX_CRITERIA = 60;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ── Scales ───────────────────────────────────────────────────────────────────

/**
 * A scale from a preset name ("1-5", "1-4", "YES_NO") or an object. Only the
 * three scales the plan names are accepted, so anchors and the divergence rule
 * always mean the same thing. Returns null for anything else.
 */
export function normalizeScale(raw) {
    if (raw === undefined || raw === null) return { ...DEFAULT_SCALE };
    if (typeof raw === "string") {
        const preset = SCALE_PRESETS[raw.trim().toUpperCase()] ?? SCALE_PRESETS[raw.trim()];
        return preset ? { ...preset } : null;
    }
    if (!isPlainObject(raw)) return null;
    if (String(raw.kind ?? "").toUpperCase() === "YES_NO") return { ...SCALE_PRESETS.YES_NO };
    const min = raw.min === undefined ? 1 : Number(raw.min);
    const max = raw.max === undefined ? 5 : Number(raw.max);
    if (min !== 1 || (max !== 5 && max !== 4)) return null;
    return max === 4 ? { ...SCALE_PRESETS["1-4"] } : { ...DEFAULT_SCALE };
}

/** The rating values of a scale, lowest first. */
export const scaleLevels = (scale) => {
    const levels = [];
    for (let v = scale.min; v <= scale.max; v += 1) levels.push(v);
    return levels;
};

/** The anchor key of one level: "1".."5", or "NO" / "YES". */
export const anchorKey = (scale, level) => (scale.kind === "YES_NO" ? (level === 1 ? "YES" : "NO") : String(level));

/**
 * One rating against a scale: a number, null when absent, undefined when it is
 * not a value of the scale. YES_NO takes YES/NO, true/false or 1/0.
 */
export function parseRating(value, scale) {
    if (value === undefined || value === null || value === "") return null;
    if (scale.kind === "YES_NO") {
        if (value === true || value === 1 || String(value).toUpperCase() === "YES" || value === "1") return 1;
        if (value === false || value === 0 || String(value).toUpperCase() === "NO" || value === "0") return 0;
        return undefined;
    }
    const n = Number(value);
    return Number.isInteger(n) && n >= scale.min && n <= scale.max ? n : undefined;
}

/** Ratings that need an evidence note on this criterion's scale. */
function extremeRatingsFor(scale, rules) {
    if (scale.kind === "YES_NO") return [];
    const levels = scaleLevels(scale);
    if (Array.isArray(rules?.extremeRatings)) return rules.extremeRatings.map(Number).filter((v) => levels.includes(v));
    // 1, 2 or 5 on the five-point scale; the same shape (two lowest, highest)
    // on the four-point forced-choice scale.
    return [scale.min, scale.min + 1, scale.max];
}

/** Half the scale's range, rounded up: 2 on 1-5 and 1-4, 1 on YES_NO. */
export const divergenceThreshold = (scale) => Math.max(1, Math.ceil((scale.max - scale.min) / 2));

// ── Template definition ──────────────────────────────────────────────────────

function normalizeEvidenceRules(raw) {
    const rules = isPlainObject(raw) ? raw : {};
    const extreme = Array.isArray(rules.extremeRatings)
        ? [...new Set(rules.extremeRatings.map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
        : null;
    return { extremeRatings: extreme, mustHave: rules.mustHave !== false };
}

function normalizeAnchors(raw, scale) {
    const out = {};
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            const level = scale.kind === "YES_NO" ? String(entry?.level ?? "").toUpperCase() : String(entry?.level ?? "");
            if (text(entry?.text)) out[level] = text(entry.text);
        }
    } else if (isPlainObject(raw)) {
        for (const [level, value] of Object.entries(raw)) {
            const key = scale.kind === "YES_NO" ? level.toUpperCase() : level;
            if (text(value)) out[key] = text(value);
        }
    }
    return out;
}

function normalizeCriterion(raw, formScale, path, seen) {
    const key = text(raw?.key);
    if (!key || !KEY_RE.test(key)) return { error: `${path}: key is required (letters, digits, _ . -)` };
    if (seen.has(key)) return { error: `Duplicate criterion key "${key}"` };
    seen.add(key);
    const label = text(raw.label) ?? key;
    const competencyKey = text(raw.competencyKey);
    if (!competencyKey) return { error: `Criterion "${key}": competencyKey is required` };

    const weight = raw.weight === undefined || raw.weight === null ? 1 : Number(raw.weight);
    if (!Number.isFinite(weight) || weight <= 0) return { error: `Criterion "${key}": weight must be greater than 0` };

    let scale = formScale;
    if (raw.scale !== undefined && raw.scale !== null) {
        scale = normalizeScale(raw.scale);
        if (!scale) return { error: `Criterion "${key}": scale must be 1-5, 1-4 or YES_NO` };
    }

    const mustHave = raw.mustHave === true;
    let mustHaveThreshold = null;
    if (mustHave) {
        const fallback = scale.kind === "YES_NO" ? 0 : scale.min + 1;
        mustHaveThreshold = raw.mustHaveThreshold === undefined || raw.mustHaveThreshold === null ? fallback : Number(raw.mustHaveThreshold);
        // At or below the threshold fails, so the top of the scale must pass.
        if (!Number.isInteger(mustHaveThreshold) || mustHaveThreshold < scale.min || mustHaveThreshold >= scale.max) {
            return { error: `Criterion "${key}": mustHaveThreshold must be a rating from ${scale.min} to ${scale.max - 1}` };
        }
    }

    const anchors = normalizeAnchors(raw.anchors, scale);
    const missingAnchors = scaleLevels(scale).map((l) => anchorKey(scale, l)).filter((k) => !anchors[k]);
    if (missingAnchors.length) return { error: `Criterion "${key}": an anchor is required for every level (missing ${missingAnchors.join(", ")})` };

    const questionKeys = Array.isArray(raw.questionKeys) ? [...new Set(raw.questionKeys.map(text).filter(Boolean))] : [];
    return {
        criterion: {
            key,
            label,
            description: text(raw.description),
            competencyKey,
            weight,
            // A must-have can never be skipped as "not assessed".
            required: mustHave ? true : raw.required !== false,
            mustHave,
            mustHaveThreshold,
            ...(scale === formScale ? {} : { scale }),
            anchors,
            questionKeys,
        },
    };
}

function normalizeSection(raw, formScale, index, seenSections, seenCriteria) {
    const key = text(raw?.key) ?? `section_${index + 1}`;
    if (!KEY_RE.test(key)) return { error: `Section ${index + 1}: key must be letters, digits, _ . -` };
    if (seenSections.has(key)) return { error: `Duplicate section key "${key}"` };
    seenSections.add(key);
    const panelRoles = Array.isArray(raw.panelRoles) ? [...new Set(raw.panelRoles.map((r) => String(r).toUpperCase()))] : [];
    const badRole = panelRoles.find((r) => !PANEL_ROLES.includes(r));
    if (badRole) return { error: `Section "${key}": unknown panel role ${badRole}` };
    if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) return { error: `Section "${key}" needs at least one criterion` };

    const criteria = [];
    for (const [i, c] of raw.criteria.entries()) {
        const out = normalizeCriterion(c, formScale, `Section "${key}" criterion ${i + 1}`, seenCriteria);
        if (out.error) return out;
        criteria.push(out.criterion);
    }
    return { section: { key, label: text(raw.label) ?? key, description: text(raw.description), panelRoles, criteria } };
}

/**
 * Validate and normalise a form definition: sections, weights > 0, an anchor
 * for every level of the scale, must-have thresholds inside the scale, panel
 * roles from the closed list.
 *
 * @returns {{ ok: true, form: { scale, sections, evidenceRules }, criteria: object[] }
 *          | { ok: false, error: string }}
 *   `criteria` is the flattened list kept in the template's legacy column so
 *   readers that predate forms still see every key.
 */
export function validateFormDefinition({ scale, sections, evidenceRules } = {}) {
    const formScale = normalizeScale(scale);
    if (!formScale) return { ok: false, error: "scale must be 1-5, 1-4 or YES_NO" };
    if (!Array.isArray(sections) || sections.length === 0) return { ok: false, error: "A form needs at least one section" };
    if (sections.length > MAX_SECTIONS) return { ok: false, error: `A form has at most ${MAX_SECTIONS} sections` };

    const seenSections = new Set();
    const seenCriteria = new Set();
    const out = [];
    for (const [i, raw] of sections.entries()) {
        const res = normalizeSection(raw, formScale, i, seenSections, seenCriteria);
        if (res.error) return { ok: false, error: res.error };
        out.push(res.section);
    }
    if (seenCriteria.size > MAX_CRITERIA) return { ok: false, error: `A form has at most ${MAX_CRITERIA} criteria` };

    const rules = normalizeEvidenceRules(evidenceRules);
    if (rules.extremeRatings && rules.extremeRatings.some((v) => v < 0 || v > 5)) {
        return { ok: false, error: "evidenceRules.extremeRatings must be ratings on the scale" };
    }
    const form = { scale: formScale, sections: out, evidenceRules: rules };
    const criteria = flattenCriteria(form).map((c) => ({ key: c.key, label: c.label, weight: c.weight, required: c.required, numeric: false }));
    return { ok: true, form, criteria };
}

/**
 * The form a template defines. A template without sections (Phase 7) reads as
 * one section of its criteria on the default scale, weight 1 where unset.
 */
export function formFromTemplate(template) {
    if (!template) return null;
    if (Array.isArray(template.sections) && template.sections.length) {
        return {
            scale: normalizeScale(template.scale) ?? { ...DEFAULT_SCALE },
            sections: template.sections.map((s) => ({ panelRoles: [], ...s, criteria: Array.isArray(s.criteria) ? s.criteria : [] })),
            evidenceRules: normalizeEvidenceRules(template.evidenceRules),
            legacy: false,
        };
    }
    const criteria = Array.isArray(template.criteria) ? template.criteria : [];
    return {
        scale: { ...DEFAULT_SCALE },
        sections: [{
            key: "criteria",
            label: template.name ?? "Criteria",
            description: null,
            panelRoles: [],
            criteria: criteria.map((c) => ({
                key: c.key,
                label: c.label ?? c.key,
                description: null,
                competencyKey: c.key,
                weight: typeof c.weight === "number" && c.weight > 0 ? c.weight : 1,
                required: c.required !== false,
                mustHave: false,
                mustHaveThreshold: null,
                anchors: {},
                questionKeys: [],
            })),
        }],
        evidenceRules: normalizeEvidenceRules(null),
        legacy: true,
    };
}

/** The sections one panelist rates; no role (or a role-free section) sees all. */
export function formForPanelRole(form, panelRole) {
    if (!form) return null;
    const role = panelRole ? String(panelRole).toUpperCase() : null;
    if (!role) return form;
    return { ...form, sections: form.sections.filter((s) => !s.panelRoles?.length || s.panelRoles.includes(role)) };
}

export const criterionScale = (criterion, form) => criterion.scale ?? form.scale;

export const flattenCriteria = (form) =>
    (form?.sections ?? []).flatMap((s) => s.criteria.map((c) => ({ ...c, sectionKey: s.key })));

/** Every question key the form links, for one bank lookup. */
export const linkedQuestionKeys = (form) => [...new Set(flattenCriteria(form).flatMap((c) => c.questionKeys ?? []))];

// ── Criterion scores ─────────────────────────────────────────────────────────

/**
 * Normalise submitted ratings to { [key]: { rating, notAssessed, note } }.
 * Accepts a list of { key, rating, notAssessed, note } or a map of key to a
 * rating or to that object.
 */
export function normalizeCriterionScores(input) {
    const out = {};
    const put = (key, raw) => {
        const k = text(key);
        if (!k) return;
        const entry = isPlainObject(raw) ? raw : { rating: raw };
        out[k] = {
            rating: entry.rating === undefined ? null : entry.rating,
            notAssessed: entry.notAssessed === true,
            note: text(entry.note),
        };
    };
    if (Array.isArray(input)) for (const e of input) put(e?.key, e);
    else if (isPlainObject(input)) for (const [k, v] of Object.entries(input)) put(k, v);
    return out;
}

/**
 * Merge submitted ratings over stored ones, field by field: a field the input
 * leaves out (rating, notAssessed, note) keeps its stored value, so an
 * autosave of one rating never drops that criterion's evidence note.
 */
export function mergeCriterionScores(stored = {}, input) {
    const out = { ...stored };
    const raw = Array.isArray(input)
        ? input.map((e) => [text(e?.key), e])
        : isPlainObject(input) ? Object.entries(input).map(([k, v]) => [text(k), isPlainObject(v) ? v : { rating: v }]) : [];
    const incoming = normalizeCriterionScores(input);
    for (const [key, entry] of raw) {
        if (!key || !incoming[key]) continue;
        const before = out[key] ?? { rating: null, notAssessed: false, note: null };
        out[key] = {
            rating: "rating" in entry ? incoming[key].rating : before.rating,
            notAssessed: "notAssessed" in entry ? incoming[key].notAssessed : before.notAssessed === true,
            note: "note" in entry ? incoming[key].note : before.note ?? null,
        };
        // Rating a criterion clears an earlier "not assessed", and the reverse.
        if ("rating" in entry && entry.rating !== null && entry.rating !== undefined && !("notAssessed" in entry)) out[key].notAssessed = false;
        if (entry.notAssessed === true && !("rating" in entry)) out[key].rating = null;
    }
    return out;
}

/**
 * The per-criterion map stored on a scorecard. Form scorecards store
 * { criteria, decision } in criterionScores; a scorecard written before forms
 * has only its `scores` ratings.
 */
export function storedCriteriaOf(card) {
    const stored = card?.criterionScores;
    if (isPlainObject(stored?.criteria)) return stored.criteria;
    const out = {};
    for (const [k, v] of Object.entries(isPlainObject(card?.scores) ? card.scores : {})) {
        if (Number.isFinite(Number(v)) && v !== null && v !== "") out[k] = { rating: Number(v), notAssessed: false, note: null };
    }
    return out;
}

/** The panelist's decision on a form scorecard (NEXT_ROUND | HOLD | REJECTED). */
export const storedDecisionOf = (card) => card?.criterionScores?.decision ?? null;

/**
 * The live score of one scorecard against a form.
 *
 * @param {object} template  a template row or an already-built form
 * @param {object|object[]} criterionScores
 * @returns {{ weightedScore: number|null, assessedWeight: number, totalWeight: number,
 *             meanRating: number|null, mustHaveFailed: boolean, mustHaveFailures: string[],
 *             missingRequired: string[], missingEvidence: string[], invalidRatings: string[],
 *             unknownCriteria: string[], answered: number, total: number, suggestion: string|null }}
 */
export function computeWeightedScore(template, criterionScores) {
    const form = template?.sections && template?.scale && template?.evidenceRules ? template : formFromTemplate(template);
    const scores = normalizeCriterionScores(criterionScores);
    const result = {
        weightedScore: null, assessedWeight: 0, totalWeight: 0, meanRating: null,
        mustHaveFailed: false, mustHaveFailures: [], missingRequired: [], missingEvidence: [],
        invalidRatings: [], unknownCriteria: [], answered: 0, total: 0, suggestion: null,
    };
    let num = 0;
    let den = 0;
    let pointsNum = 0;
    let pointsDen = 0;
    const criteria = flattenCriteria(form);
    const known = new Set(criteria.map((c) => c.key));
    for (const c of criteria) {
        result.total += 1;
        result.totalWeight += c.weight;
        const scale = criterionScale(c, form);
        const entry = scores[c.key];
        if (entry?.notAssessed) {
            // Not assessed is a choice only on optional criteria.
            if (c.required) result.missingRequired.push(c.key);
            else result.answered += 1;
            continue;
        }
        const rating = parseRating(entry?.rating, scale);
        if (rating === null) {
            if (c.required) result.missingRequired.push(c.key);
            continue;
        }
        if (rating === undefined) {
            result.invalidRatings.push(c.key);
            continue;
        }
        result.answered += 1;
        num += rating * c.weight;
        den += scale.max * c.weight;
        result.assessedWeight += c.weight;
        if (scale.kind === "POINTS") {
            pointsNum += rating * c.weight;
            pointsDen += c.weight;
        }
        if (c.mustHave && rating <= c.mustHaveThreshold) {
            result.mustHaveFailed = true;
            result.mustHaveFailures.push(c.key);
        }
        const needsEvidence = (c.mustHave && form.evidenceRules.mustHave) || extremeRatingsFor(scale, form.evidenceRules).includes(rating);
        if (needsEvidence && !entry?.note) result.missingEvidence.push(c.key);
    }
    for (const key of Object.keys(scores)) if (!known.has(key)) result.unknownCriteria.push(key);
    result.weightedScore = den ? round2((num / den) * 100) : null;
    result.meanRating = pointsDen ? round2(pointsNum / pointsDen) : null;
    result.suggestion = result.mustHaveFailed ? NOT_RECOMMENDED : null;
    return result;
}

/**
 * Validate a submission: required criteria rated (or a required criterion
 * marked not assessed), evidence notes where the rules ask, ratings on the
 * scale, no invented criteria, the conflict-of-interest declaration and an
 * overall recommendation.
 *
 * @returns {{ ok: boolean, errors: { code: string, criteria?: string[] }[], score: object }}
 */
export function validateSubmission(template, { criterionScores, recommendation, coiDeclared } = {}) {
    const score = computeWeightedScore(template, criterionScores);
    const errors = [];
    if (score.missingRequired.length) errors.push({ code: "REQUIRED_MISSING", criteria: score.missingRequired });
    if (score.invalidRatings.length) errors.push({ code: "RATING_INVALID", criteria: score.invalidRatings });
    if (score.unknownCriteria.length) errors.push({ code: "CRITERION_UNKNOWN", criteria: score.unknownCriteria });
    if (score.missingEvidence.length) errors.push({ code: "EVIDENCE_MISSING", criteria: score.missingEvidence });
    if (coiDeclared !== true) errors.push({ code: "COI_NOT_DECLARED" });
    if (!FORM_RECOMMENDATIONS.includes(recommendation)) errors.push({ code: "RECOMMENDATION_MISSING" });
    return { ok: errors.length === 0, errors, score };
}

// ── Consolidation and the report ─────────────────────────────────────────────

const average = (nums) => (nums.length ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : null);

/**
 * Consolidate SUBMITTED scorecards against one form.
 *
 * @param {object} form
 * @param {{ reviewerId, reviewer?, criterionScores?, scores?, weightedScore?, overallScore?,
 *           mustHaveFailed?, recommendation? }[]} cards
 */
export function consolidateForm(form, cards = []) {
    const criteria = {};
    const divergentCriteria = [];
    for (const c of flattenCriteria(form)) {
        const scale = criterionScale(c, form);
        const values = [];
        for (const card of cards) {
            const entry = storedCriteriaOf(card)[c.key];
            if (!entry || entry.notAssessed) continue;
            const rating = parseRating(entry.rating, scale);
            if (typeof rating === "number") values.push({ reviewerId: card.reviewerId, reviewer: card.reviewer ?? null, rating });
        }
        const nums = values.map((v) => v.rating);
        const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : null;
        const divergent = nums.length > 1 && spread >= divergenceThreshold(scale);
        if (divergent) divergentCriteria.push(c.key);
        criteria[c.key] = {
            label: c.label,
            sectionKey: c.sectionKey,
            competencyKey: c.competencyKey,
            mustHave: c.mustHave === true,
            scale: { kind: scale.kind, min: scale.min, max: scale.max },
            average: average(nums),
            min: nums.length ? Math.min(...nums) : null,
            max: nums.length ? Math.max(...nums) : null,
            spread,
            count: nums.length,
            divergent,
            values,
        };
    }

    const recommendationTally = Object.fromEntries(FORM_RECOMMENDATIONS.map((r) => [r, 0]));
    const decisionTally = Object.fromEntries(INTERVIEW_DECISIONS.map((d) => [d, 0]));
    const mustHaveAlerts = [];
    for (const card of cards) {
        if (FORM_RECOMMENDATIONS.includes(card.recommendation)) recommendationTally[card.recommendation] += 1;
        const decision = storedDecisionOf(card);
        if (INTERVIEW_DECISIONS.includes(decision)) decisionTally[decision] += 1;
        if (card.mustHaveFailed) {
            const failed = computeWeightedScore(form, storedCriteriaOf(card)).mustHaveFailures;
            mustHaveAlerts.push({ reviewerId: card.reviewerId, reviewer: card.reviewer ?? null, criteria: failed });
        }
    }

    return {
        criteria,
        divergentCriteria,
        interviewScorePct: interviewScoreOf(cards),
        mustHaveFailed: mustHaveAlerts.length > 0,
        mustHaveAlerts,
        suggestion: mustHaveAlerts.length ? NOT_RECOMMENDED : null,
        recommendationTally,
        decisionTally,
        submittedCount: cards.length,
    };
}

/**
 * The interview score of a round: the panelists' weighted scores averaged. A
 * scorecard from before forms counts by its 1 to 5 overall, as a percentage.
 */
export function interviewScoreOf(cards = []) {
    const pcts = cards
        .map((card) => {
            if (typeof card.weightedScore === "number") return card.weightedScore;
            const overall = Number(card.overallScore);
            return card.overallScore !== null && card.overallScore !== undefined && Number.isFinite(overall) ? (overall / 5) * 100 : null;
        })
        .filter((v) => typeof v === "number");
    return average(pcts);
}

/**
 * Composite score. The test counts only when it was required and not waived,
 * and it has a score; otherwise the interview score is the composite.
 */
export function compositeScore({ testScorePct = null, interviewScorePct = null, testWeightPct = DEFAULT_TEST_WEIGHT_PCT, testIncluded = true } = {}) {
    const tw = Number.isFinite(Number(testWeightPct)) ? Math.min(100, Math.max(0, Number(testWeightPct))) : DEFAULT_TEST_WEIGHT_PCT;
    const useTest = testIncluded && typeof testScorePct === "number";
    const weights = useTest ? { testPct: tw, interviewPct: 100 - tw } : { testPct: 0, interviewPct: 100 };
    if (typeof interviewScorePct !== "number") return { compositeScore: null, weights, testIncluded: useTest };
    const composite = useTest ? (tw * testScorePct + (100 - tw) * interviewScorePct) / 100 : interviewScorePct;
    return { compositeScore: round2(composite), weights, testIncluded: useTest };
}

/** Advisory rank among the requisition's candidates (1 is the highest). */
export function rankAmong(score, others = []) {
    const peers = others.filter((v) => typeof v === "number");
    if (typeof score !== "number") return { rank: null, of: peers.length + 1 };
    return { rank: 1 + peers.filter((v) => v > score).length, of: peers.length + 1 };
}

// ── The assessment gate (7.7) ────────────────────────────────────────────────

export const assessmentGateOpen = (interview) =>
    interview?.assessmentRequired !== true || ASSESSMENT_PROCEED_STATES.includes(interview?.assessmentStatus ?? "NOT_REQUIRED");

/** Throw 409 HR-RECRUITMENT-ASSESSMENT-REQUIRED unless the interview may proceed. */
export function assertAssessmentGate(interview) {
    if (assessmentGateOpen(interview)) return;
    throw Object.assign(
        new Error(`The on-site assessment must be passed, overridden or waived before an outcome (status ${interview?.assessmentStatus ?? "unknown"})`),
        { status: 409, code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED", details: { assessmentStatus: interview?.assessmentStatus ?? null } },
    );
}

// ── The pre-interview test, as the form and the report read it ──────────────

const pct = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : round2(Number(v)));

/**
 * Section scores of a test result against its blueprint, whatever shape the
 * scoring stored them in (a list of sections, or a map keyed by section). Only
 * scores and pass marks: never items, answers or keys.
 *
 * @returns {{ key, label, competencyKey, scorePct, passMarkPct, passed, mustPass }[]}
 */
export function testSectionsOf(sectionScores, blueprint = null) {
    const list = Array.isArray(sectionScores)
        ? sectionScores
        : isPlainObject(sectionScores)
            ? Object.entries(sectionScores).map(([key, v]) => ({ key, ...(isPlainObject(v) ? v : { scorePct: v }) }))
            : [];
    const plan = Array.isArray(blueprint?.sections) ? blueprint.sections : [];
    return list.map((s) => {
        const key = s.key ?? s.sectionKey ?? s.competencyKey ?? null;
        const bp = plan.find((b) => b.key === key) ?? {};
        const scorePct = pct(s.scorePct ?? s.pct ?? (Number(s.maxScore) > 0 ? (Number(s.rawScore) / Number(s.maxScore)) * 100 : null));
        const passMarkPct = pct(s.passMarkPct ?? s.sectionPassMarkPct ?? bp.sectionPassMarkPct ?? blueprint?.passMarkPct);
        const passed = typeof s.passed === "boolean" ? s.passed : scorePct !== null && passMarkPct !== null ? scorePct >= passMarkPct : null;
        return {
            key,
            label: s.label ?? bp.label ?? key,
            competencyKey: s.competencyKey ?? bp.competencyKey ?? key,
            scorePct,
            passMarkPct,
            passed,
            mustPass: s.mustPass === true || bp.mustPass === true,
        };
    });
}

/** Competencies the candidate scored below the section pass mark on (7.4.2). */
export const weakCompetencies = (sections = []) =>
    sections.filter((s) => s.competencyKey && s.scorePct !== null && s.passMarkPct !== null && s.scorePct < s.passMarkPct);
