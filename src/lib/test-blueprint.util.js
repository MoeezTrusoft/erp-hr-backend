// src/lib/test-blueprint.util.js
//
// Recruitment Phase 3b (plan 7.3.3) — the PURE rules of a test blueprint.
//
// A blueprint says how the on-arrival test for a role is assembled: two to
// five sections, each one competency with an item count and a difficulty mix,
// plus timing, pass mark, borderline band, hard floor, navigation, cooldown,
// validity and weights. The service stores blueprints, approves, publishes and
// links them; THIS module owns the decisions so the write path, the publish
// check, the preview and the kiosk's draw (stream I) cannot drift:
//
//   * normalizeBlueprintInput   ranges that match the migration's CHECK, the
//                               plan's defaults, and each section's mix turned
//                               into integer item counts per difficulty
//   * drawPlan / poolDepthReport the pool depth rule: a published pool of at
//                               least three times the draw per section and
//                               difficulty, else publishing is refused
//   * pickBlueprintLink          most-specific-first resolution, REQUISITION,
//                               then JOB_FAMILY_GRADE, then JOB_FAMILY (the
//                               scorecard-templates.util.js pattern)
//   * isOnsiteInterview          which interviews need the test at all
//   * assessmentRequirementFor   reuse of a still-valid result, and the retake
//                               cooldown signal
//
// Rounding rule for the difficulty mix (deterministic, keeps the total): each
// difficulty gets floor(itemCount x pct / 100); the items left over go one by
// one to the largest fractional remainders, ties in EASY, MEDIUM, HARD order.
// 10 items at 30/50/20 -> 3/5/2; 7 items at 30/50/20 -> 2/4/1.
//
// Job family: JobRequisition has no job family column, and jobContent's
// normalizer keeps only its known keys. requisitionJobFamily therefore reads
// jobContent.jobFamily when present (future-proof) and otherwise the
// requisition's Position.jobCode; with neither, the requisition has no family
// and only a REQUISITION link can resolve for it. Families are compared
// upper-cased and trimmed.
//
// No DB, no I/O.

export const DIFFICULTIES = Object.freeze(["EASY", "MEDIUM", "HARD"]);
export const BLUEPRINT_STATUS = Object.freeze({
    DRAFT: "DRAFT",
    IN_APPROVAL: "IN_APPROVAL",
    APPROVED: "APPROVED",
    PUBLISHED: "PUBLISHED",
    RETIRED: "RETIRED",
});
export const BLUEPRINT_SCOPES = Object.freeze(["REQUISITION", "JOB_FAMILY_GRADE", "JOB_FAMILY"]);
export const BLUEPRINT_NAVIGATION = Object.freeze(["FREE", "FORWARD_ONLY"]);
export const BLUEPRINT_LANGUAGES = Object.freeze(["en", "ur"]);
export const POOL_DEPTH_FACTOR = 3;
export const DEFAULT_DIFFICULTY_MIX = Object.freeze({ EASY: 30, MEDIUM: 50, HARD: 20 });

// The plan's defaults (7.3.3 table); the same values as the schema defaults.
export const BLUEPRINT_DEFAULTS = Object.freeze({
    language: "en",
    durationMin: 30,
    passMarkPct: 60,
    borderlineBandPct: 10,
    hardFloorPct: null,
    autoReleaseBelowFloor: false,
    negativeMarking: false,
    negativeMarkFraction: null,
    navigation: "FREE",
    flagForReview: true,
    retakeCooldownDays: 180,
    resultValidityDays: 90,
    testWeightPct: 30,
    integrityFlagThreshold: 3,
    maxExtraTimePct: 50,
    allowAnySiteKiosk: false,
});

const DEFAULT_NEGATIVE_FRACTION = 0.25;
const MIN_SECTIONS = 2;
const MAX_SECTIONS = 5;
const MAX_ITEMS_PER_SECTION = 50;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const DAY_MS = 86400000;

const invalid = (errors) =>
    Object.assign(new Error(`Invalid test blueprint: ${errors.join("; ")}`), {
        status: 422,
        code: "HR-RECRUITMENT-BLUEPRINT-INVALID",
        details: { code: "HR-RECRUITMENT-BLUEPRINT-INVALID", errors },
    });

/** Upper-cased, trimmed job family, or null. */
export function normalizeJobFamily(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim().toUpperCase();
    return text ? text.slice(0, 100) : null;
}

/**
 * The job family of a requisition (see the header): jobContent.jobFamily,
 * else the position's jobCode, else null.
 * @param {{ jobContent?: object|null, position?: { jobCode?: string|null }|null }} requisition
 */
export function requisitionJobFamily(requisition) {
    const fromContent = requisition?.jobContent && typeof requisition.jobContent === "object"
        ? normalizeJobFamily(requisition.jobContent.jobFamily)
        : null;
    return fromContent ?? normalizeJobFamily(requisition?.position?.jobCode);
}

const sameFamily = (a, b) => a != null && b != null && normalizeJobFamily(a) === normalizeJobFamily(b);

/**
 * Integer item counts per difficulty for one section (the rounding rule in
 * the header). The counts always sum to itemCount.
 */
export function difficultyCounts(itemCount, mix) {
    const total = Number(itemCount);
    const exact = DIFFICULTIES.map((d) => (total * Number(mix?.[d] ?? 0)) / 100);
    const counts = exact.map(Math.floor);
    let left = total - counts.reduce((a, b) => a + b, 0);
    const order = DIFFICULTIES.map((_, i) => i).sort((a, b) => (exact[b] - counts[b]) - (exact[a] - counts[a]) || a - b);
    for (const i of order) {
        if (left <= 0) break;
        counts[i] += 1;
        left -= 1;
    }
    return Object.fromEntries(DIFFICULTIES.map((d, i) => [d, counts[i]]));
}

function intIn(errors, label, value, min, max, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        errors.push(`${label} must be a whole number from ${min} to ${max}`);
        return fallback;
    }
    return n;
}

function bool(value, fallback) {
    return value === undefined || value === null ? fallback : value === true;
}

function normalizeMix(errors, label, raw) {
    if (raw === undefined || raw === null) return { ...DEFAULT_DIFFICULTY_MIX };
    if (typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${label}: difficultyMix must be an object of EASY, MEDIUM and HARD percentages`);
        return { ...DEFAULT_DIFFICULTY_MIX };
    }
    const unknown = Object.keys(raw).filter((k) => !DIFFICULTIES.includes(k));
    if (unknown.length) errors.push(`${label}: unknown difficulty ${unknown.join(", ")}`);
    const mix = Object.fromEntries(DIFFICULTIES.map((d) => [d, intIn(errors, `${label} ${d}`, raw[d], 0, 100, 0)]));
    const sum = DIFFICULTIES.reduce((a, d) => a + mix[d], 0);
    if (sum !== 100) errors.push(`${label}: difficultyMix must sum to 100 (got ${sum})`);
    return mix;
}

function normalizeSection(errors, raw, i, durationMin) {
    const label0 = `Section ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${label0} must be an object`);
        return null;
    }
    const competencyKey = typeof raw.competencyKey === "string" ? raw.competencyKey.trim() : "";
    if (!competencyKey || competencyKey.length > 80) errors.push(`${label0}: competencyKey is required (at most 80 characters)`);
    const key = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : `s${i + 1}`;
    if (!KEY_RE.test(key)) errors.push(`${label0}: key must be letters, digits, dot, dash or underscore`);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 120) : competencyKey;
    const itemCount = intIn(errors, `${label0} itemCount`, raw.itemCount, 1, MAX_ITEMS_PER_SECTION, null);
    if (itemCount === null && (raw.itemCount === undefined || raw.itemCount === null)) errors.push(`${label0}: itemCount is required`);
    const difficultyMix = normalizeMix(errors, label0, raw.difficultyMix);
    const sectionPassMarkPct = intIn(errors, `${label0} sectionPassMarkPct`, raw.sectionPassMarkPct, 0, 100, null);
    const timeLimitMin = intIn(errors, `${label0} timeLimitMin`, raw.timeLimitMin, 1, durationMin, null);
    return {
        key,
        label,
        competencyKey,
        itemCount: itemCount ?? 0,
        difficultyMix,
        counts: itemCount ? difficultyCounts(itemCount, difficultyMix) : { EASY: 0, MEDIUM: 0, HARD: 0 },
        mustPass: raw.mustPass === true,
        sectionPassMarkPct,
        timeLimitMin,
    };
}

function normalizeSections(errors, sections, durationMin) {
    if (!Array.isArray(sections) || sections.length < MIN_SECTIONS || sections.length > MAX_SECTIONS) {
        errors.push(`A blueprint needs ${MIN_SECTIONS} to ${MAX_SECTIONS} sections`);
        return [];
    }
    const out = sections.map((s, i) => normalizeSection(errors, s, i, durationMin)).filter(Boolean);
    const dup = (field) => out.map((s) => s[field]).filter((v, i, all) => v && all.indexOf(v) !== i);
    // One competency per section, so a section's pool is its own and the
    // depth check per section is exact.
    if (dup("key").length) errors.push(`Duplicate section key ${dup("key").join(", ")}`);
    if (dup("competencyKey").length) errors.push(`Each section needs its own competency (repeated: ${dup("competencyKey").join(", ")})`);
    const timed = out.filter((s) => s.timeLimitMin != null);
    const timedSum = timed.reduce((a, s) => a + s.timeLimitMin, 0);
    if (timedSum > durationMin) errors.push(`Section time limits (${timedSum} min) exceed the duration (${durationMin} min)`);
    return out;
}

/**
 * Validate and normalise a full blueprint input (create, or the merged
 * result of an update). Throws 422 HR-RECRUITMENT-BLUEPRINT-INVALID with
 * every problem in details.errors.
 *
 * @returns {object} the columns to store (sections include their counts)
 */
export function normalizeBlueprintInput(input = {}) {
    const errors = [];
    const d = BLUEPRINT_DEFAULTS;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) errors.push("name is required (at most 200 characters)");

    const language = input.language == null ? d.language : String(input.language).trim().toLowerCase();
    if (!BLUEPRINT_LANGUAGES.includes(language)) errors.push(`language must be one of ${BLUEPRINT_LANGUAGES.join(", ")}`);
    const navigation = input.navigation == null ? d.navigation : String(input.navigation).trim().toUpperCase();
    if (!BLUEPRINT_NAVIGATION.includes(navigation)) errors.push(`navigation must be one of ${BLUEPRINT_NAVIGATION.join(", ")}`);

    const durationMin = intIn(errors, "durationMin", input.durationMin, 5, 240, d.durationMin);
    const passMarkPct = intIn(errors, "passMarkPct", input.passMarkPct, 0, 100, d.passMarkPct);
    const borderlineBandPct = intIn(errors, "borderlineBandPct", input.borderlineBandPct, 0, 100, d.borderlineBandPct);
    if (borderlineBandPct > passMarkPct) errors.push("borderlineBandPct cannot be larger than passMarkPct");
    const hardFloorPct = intIn(errors, "hardFloorPct", input.hardFloorPct, 0, 100, null);
    if (hardFloorPct != null && hardFloorPct > passMarkPct - borderlineBandPct) {
        errors.push("hardFloorPct must sit below the borderline band (at most passMarkPct - borderlineBandPct)");
    }
    const autoReleaseBelowFloor = bool(input.autoReleaseBelowFloor, d.autoReleaseBelowFloor);
    if (autoReleaseBelowFloor && hardFloorPct == null) errors.push("autoReleaseBelowFloor needs a hardFloorPct");

    const negativeMarking = bool(input.negativeMarking, d.negativeMarking);
    let negativeMarkFraction = null;
    if (negativeMarking) {
        const f = input.negativeMarkFraction == null ? DEFAULT_NEGATIVE_FRACTION : Number(input.negativeMarkFraction);
        if (!Number.isFinite(f) || f <= 0 || f > 1) errors.push("negativeMarkFraction must be above 0 and at most 1");
        negativeMarkFraction = Number.isFinite(f) ? f : null;
    }

    const value = {
        name,
        language,
        jobFamily: normalizeJobFamily(input.jobFamily),
        durationMin,
        passMarkPct,
        borderlineBandPct,
        hardFloorPct,
        autoReleaseBelowFloor,
        negativeMarking,
        negativeMarkFraction,
        navigation,
        // Flag-for-review needs back navigation; a forward-only test has none.
        flagForReview: navigation === "FORWARD_ONLY" ? false : bool(input.flagForReview, d.flagForReview),
        sections: normalizeSections(errors, input.sections, durationMin),
        retakeCooldownDays: intIn(errors, "retakeCooldownDays", input.retakeCooldownDays, 0, 3650, d.retakeCooldownDays),
        resultValidityDays: intIn(errors, "resultValidityDays", input.resultValidityDays, 0, 3650, d.resultValidityDays),
        testWeightPct: intIn(errors, "testWeightPct", input.testWeightPct, 0, 100, d.testWeightPct),
        integrityFlagThreshold: intIn(errors, "integrityFlagThreshold", input.integrityFlagThreshold, 0, 100, d.integrityFlagThreshold),
        maxExtraTimePct: intIn(errors, "maxExtraTimePct", input.maxExtraTimePct, 0, 100, d.maxExtraTimePct),
        allowAnySiteKiosk: bool(input.allowAnySiteKiosk, d.allowAnySiteKiosk),
    };
    if (errors.length) throw invalid(errors);
    return value;
}

/** The fields a blueprint update may change (everything normalizeBlueprintInput reads). */
export const BLUEPRINT_EDITABLE_FIELDS = Object.freeze([
    "name", "language", "jobFamily", "durationMin", "passMarkPct", "borderlineBandPct", "hardFloorPct",
    "autoReleaseBelowFloor", "negativeMarking", "negativeMarkFraction", "navigation", "flagForReview",
    "sections", "retakeCooldownDays", "resultValidityDays", "testWeightPct", "integrityFlagThreshold",
    "maxExtraTimePct", "allowAnySiteKiosk",
]);

/**
 * Per section, per difficulty item counts (recomputed from the mix, so a
 * stored blueprint and a fresh input plan the same draw).
 * @returns {{ sectionKey, competencyKey, counts: {EASY,MEDIUM,HARD}, total }[]}
 */
export function drawPlan(sections = []) {
    return sections.map((s) => {
        const counts = difficultyCounts(s.itemCount, s.difficultyMix ?? DEFAULT_DIFFICULTY_MIX);
        return { sectionKey: s.key, competencyKey: s.competencyKey, counts, total: Number(s.itemCount) };
    });
}

/**
 * The pool depth rule: for every section and every difficulty it draws from,
 * the published pool holds at least factor x the draw.
 *
 * @param {{ sections: object[], poolCounts: { [competencyKey]: { EASY?, MEDIUM?, HARD? } }, factor?: number }} args
 * @returns {{ ok: boolean, factor: number, sections: object[], shortfalls: object[] }}
 */
export function poolDepthReport({ sections = [], poolCounts = {}, factor = POOL_DEPTH_FACTOR } = {}) {
    const out = drawPlan(sections).map((plan) => {
        const difficulties = DIFFICULTIES.filter((d) => plan.counts[d] > 0).map((difficulty) => {
            const draw = plan.counts[difficulty];
            const needed = draw * factor;
            const available = Number(poolCounts?.[plan.competencyKey]?.[difficulty] ?? 0);
            return { difficulty, draw, needed, available, ok: available >= needed };
        });
        return { sectionKey: plan.sectionKey, competencyKey: plan.competencyKey, difficulties, ok: difficulties.every((x) => x.ok) };
    });
    const shortfalls = out.flatMap((s) =>
        s.difficulties.filter((x) => !x.ok).map((x) => ({ sectionKey: s.sectionKey, competencyKey: s.competencyKey, ...x })),
    );
    return { ok: shortfalls.length === 0, factor, sections: out, shortfalls };
}

/**
 * Most-specific-first: REQUISITION (scopeId = requisition id), then
 * JOB_FAMILY_GRADE (scopeKey = family, scopeId = grade level id), then
 * JOB_FAMILY (scopeKey = family). Only active links to PUBLISHED blueprints
 * count; a tie (which the one-active-link index prevents) goes to the lowest
 * blueprint id.
 *
 * @param {{ scopeType, scopeId, scopeKey, isActive, blueprint }[]} links
 * @param {{ requisitionId: number, jobFamily: string|null, gradeLevelId: number|null }} ctx
 * @returns {{ link: object, blueprint: object, matchedScope: string }|null}
 */
export function pickBlueprintLink(links = [], ctx = {}) {
    const usable = links.filter((l) => l.isActive !== false && l.blueprint?.status === BLUEPRINT_STATUS.PUBLISHED);
    const rules = [
        ["REQUISITION", (l) => ctx.requisitionId != null && Number(l.scopeId) === Number(ctx.requisitionId)],
        ["JOB_FAMILY_GRADE", (l) => ctx.gradeLevelId != null && Number(l.scopeId) === Number(ctx.gradeLevelId) && sameFamily(l.scopeKey, ctx.jobFamily)],
        ["JOB_FAMILY", (l) => sameFamily(l.scopeKey, ctx.jobFamily)],
    ];
    for (const [scopeType, match] of rules) {
        const hit = usable
            .filter((l) => l.scopeType === scopeType && match(l))
            .sort((a, b) => a.blueprint.id - b.blueprint.id)[0];
        if (hit) return { link: hit, blueprint: hit.blueprint, matchedScope: scopeType };
    }
    return null;
}

// Video and phone interviews never take the on-site test. ONSITE is on site
// whatever its location says. Any other type is on site when it names a
// physical location: non-empty and not a meeting link or a remote word.
const REMOTE_TYPES = new Set(["VIDEO", "PHONE_SCREEN"]);
const REMOTE_LOCATION = /(https?:\/\/|www\.|meet\.google|\b(zoom|teams|webex|skype|whereby|video|phone|remote|online|virtual)\b)/i;

/** Does this interview happen on site (and so may need the test)? */
export function isOnsiteInterview({ interviewType, location } = {}) {
    const type = String(interviewType ?? "").trim().toUpperCase();
    if (REMOTE_TYPES.has(type)) return false;
    if (type === "ONSITE") return true;
    const place = String(location ?? "").trim();
    return place.length > 0 && !REMOTE_LOCATION.test(place);
}

const REUSABLE_BANDS = new Set(["PASSED", "BORDERLINE"]);
const PROCEEDING_DECISIONS = new Set(["PROCEED", "OVERRIDE"]);
const STOPPING_DECISIONS = new Set(["RELEASE", "RETEST", "WAIVE"]);
const time = (v) => (v == null ? null : new Date(v).getTime());

/** A result the candidate may carry into another interview of the same family. */
export function isReusableResult(result, now = new Date()) {
    const until = time(result?.validUntil);
    if (until == null || until <= time(now)) return false;
    if (STOPPING_DECISIONS.has(result.decision)) return false;
    return PROCEEDING_DECISIONS.has(result.decision) || REUSABLE_BANDS.has(result.band);
}

const isFailedResult = (result) => result?.band === "FAILED" || result?.decision === "RELEASE";

/**
 * What scheduling an on-site interview means for a candidate with these past
 * results (already narrowed to the blueprint's job family):
 *   * a reusable result -> PASSED, nothing to sit; the result id is reported
 *   * otherwise REQUIRED; a FAILED result inside the retake cooldown sets
 *     cooldownActive (the recruiter decides whether the retest goes ahead)
 */
export function assessmentRequirementFor({ results = [], now = new Date(), retakeCooldownDays = BLUEPRINT_DEFAULTS.retakeCooldownDays } = {}) {
    const newestFirst = [...results].sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0) || b.id - a.id);
    const reusable = newestFirst.find((r) => isReusableResult(r, now));
    if (reusable) return { assessmentStatus: "PASSED", reusedResultId: reusable.id, cooldownActive: false, cooldownResultId: null };
    const cutoff = time(now) - Number(retakeCooldownDays ?? 0) * DAY_MS;
    const failed = newestFirst.find((r) => isFailedResult(r) && (time(r.createdAt) ?? 0) >= cutoff);
    return { assessmentStatus: "REQUIRED", reusedResultId: null, cooldownActive: Boolean(failed), cooldownResultId: failed?.id ?? null };
}
