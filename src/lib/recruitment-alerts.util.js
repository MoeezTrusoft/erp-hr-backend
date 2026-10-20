// src/lib/recruitment-alerts.util.js
//
// Recruitment Phase 5 (plan 6.10) — the pure rules behind analytics threshold
// alerts: which metrics can alert, how a tenant's thresholds are validated,
// the evaluation period, and what one evaluation does to an existing alert.
// No DB and no services here (src/lib may not import src/services); the
// service assembles the inputs.
//
// PERIOD. Each hourly evaluation measures a ROLLING 30-day window ending at
// the run (timeToFill: requisitions whose overall fill fell inside it; offer
// decline rate: offers whose final outcome fell inside it; failed handoffs:
// handoffs left FAILED and last touched inside it; SLA breaches: the open
// applications breaching their stage SLA right now, a point-in-time count).
// A rolling window moves every hour, so an alert is NOT keyed by it: an alert
// is one breach episode. While an OPEN or ACKNOWLEDGED alert exists for a
// metric, later breaching runs only update it (value, lastSeenAt); the first
// run back under the threshold RESOLVES it. A new episode starts a new row
// whose periodStart is the UTC day the window started on (the unique key is
// tenant + metric + periodStart; a second episode on the same day reopens the
// resolved row instead).
//
// BREACH. value > threshold (strictly). A metric that cannot be measured in the
// window (no fill, no final offer, no SLA configured) neither raises nor
// resolves: "no data" says nothing about whether it is back under.

export const ALERT_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ALERT_STATUS = Object.freeze({
    OPEN: "OPEN",
    ACKNOWLEDGED: "ACKNOWLEDGED",
    RESOLVED: "RESOLVED",
});
export const ALERT_STATUSES = Object.freeze(Object.values(ALERT_STATUS));
export const ACTIVE_ALERT_STATUSES = Object.freeze([ALERT_STATUS.OPEN, ALERT_STATUS.ACKNOWLEDGED]);

/** RecruitmentAlert.metric (the migration CHECK) → the threshold key that drives it. */
export const ALERT_METRIC_THRESHOLD_KEYS = Object.freeze({
    TIME_TO_FILL: "timeToFillDays",
    SLA_BREACHES: "slaBreaches",
    OFFER_DECLINE_RATE: "offerDeclineRatePct",
    FAILED_HANDOFFS: "failedHandoffs",
});
export const ALERT_METRICS = Object.freeze(Object.keys(ALERT_METRIC_THRESHOLD_KEYS));

// Each threshold: [min, max, integer?]. A threshold of 0 on a count means
// "alert on any".
const THRESHOLD_RULES = Object.freeze({
    timeToFillDays: [1, 365, false],
    slaBreaches: [0, 100000, true],
    offerDeclineRatePct: [0, 100, false],
    failedHandoffs: [0, 100000, true],
});
export const THRESHOLD_KEYS = Object.freeze(Object.keys(THRESHOLD_RULES));

const invalid = (message) =>
    Object.assign(new Error(message), { status: 400, code: "HR-RECRUITMENT-ALERTS-INVALID" });

const toNumber = (raw) =>
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;

function checkThreshold(key, raw) {
    const [min, max, integer] = THRESHOLD_RULES[key];
    const n = toNumber(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw invalid(`${key} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}, or null`);
    }
    return n;
}

/**
 * Validate a thresholds change. Unknown keys are refused; null clears a key
 * (that metric is no longer watched); an absent key is left unchanged.
 * @returns {Record<string, number|null>} only the keys the input named
 */
export function normalizeAlertThresholdsInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw invalid("thresholds must be an object");
    }
    const unknown = Object.keys(input).filter((k) => !THRESHOLD_KEYS.includes(k));
    if (unknown.length) throw invalid(`Unsupported threshold(s): ${unknown.join(", ")}`);
    const out = {};
    for (const key of THRESHOLD_KEYS) {
        if (input[key] === undefined) continue;
        out[key] = input[key] === null ? null : checkThreshold(key, input[key]);
    }
    return out;
}

/** The stored JSON read tolerantly: only valid thresholds survive, nulls dropped. */
export function readStoredThresholds(json) {
    const out = {};
    if (!json || typeof json !== "object" || Array.isArray(json)) return out;
    for (const key of THRESHOLD_KEYS) {
        if (json[key] === null || json[key] === undefined) continue;
        try {
            out[key] = checkThreshold(key, json[key]);
        } catch {
            // A hand-edited or legacy value outside the rules is not watched.
        }
    }
    return out;
}

/** Merge a validated change onto the stored thresholds; null removes a key. */
export function mergeThresholds(stored, change) {
    const merged = { ...readStoredThresholds(stored) };
    for (const [key, value] of Object.entries(change)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
    }
    return merged;
}

/** The metrics a thresholds object watches, in a stable order. */
export const watchedMetrics = (thresholds) =>
    ALERT_METRICS.filter((m) => thresholds[ALERT_METRIC_THRESHOLD_KEYS[m]] !== undefined);

/** The rolling window ending at `now`, and the periodStart a new alert is keyed by. */
export function alertWindow(now = new Date()) {
    const to = new Date(now);
    const from = new Date(to.getTime() - ALERT_PERIOD_DAYS * DAY_MS);
    const periodStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    return { from, to, periodStart };
}

export const isBreached = (value, threshold) =>
    value !== null && value !== undefined && threshold !== null && threshold !== undefined && Number(value) > Number(threshold);

/**
 * What one evaluation does.
 *   active   — the metric's OPEN/ACKNOWLEDGED alert, if any
 *   samePeriod — the row already at this run's periodStart (only consulted
 *                when there is no active alert; it can only be RESOLVED then)
 * @returns {{ action: "CREATE"|"REOPEN"|"TOUCH"|"RESOLVE"|"NONE", emit: boolean }}
 */
export function planAlertTransition({ active = null, samePeriod = null, value, threshold }) {
    const measurable = value !== null && value !== undefined;
    const breached = isBreached(value, threshold);
    if (active) {
        if (breached) return { action: "TOUCH", emit: false };
        if (measurable) return { action: "RESOLVE", emit: false };
        return { action: "NONE", emit: false };
    }
    if (!breached) return { action: "NONE", emit: false };
    if (samePeriod) return { action: "REOPEN", emit: true };
    return { action: "CREATE", emit: true };
}

// A recruiting lead, when the tenant named no alert recipient: an active
// employee whose job title reads as leading recruiting or talent acquisition.
const RECRUITING_TITLE = /recruit|talent acquisition/i;
const LEAD_TITLE = /\b(lead|head|manager|director|chief|vp)\b/i;

export const isRecruitingLeadTitle = (title) =>
    typeof title === "string" && RECRUITING_TITLE.test(title) && LEAD_TITLE.test(title);
