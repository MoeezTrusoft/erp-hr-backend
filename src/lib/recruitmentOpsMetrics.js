// src/lib/recruitmentOpsMetrics.js
//
// Phase 15 — the seven ROLLOUT METRICS the plan names: transition failures,
// handoffs, parsing, notifications, denials, exports, and retention.
//
// One bounded-label Counter each, mirroring the authMetrics.js pattern:
//   * label values come from SMALL frozen allowlists — a stray value collapses
//     to a safe bucket rather than throwing, so no caller can blow up label
//     cardinality (the failure mode that exhausts a metrics store).
//   * every record* helper swallows its own errors — a metrics hiccup never
//     derails the recruitment write it is observing.
//   * counters are process-wide singletons looked up on the default registry
//     first (Jest re-import safety), and attached to each createApp() registry
//     via attachRecruitmentOpsMetrics(register) so /metrics exposes them at
//     value 0 before the first event.
//
// Forbidden (carried over from authMetrics): never label with candidate/
// applicant identifiers, emails, requisition titles, or raw error messages.

import client from "prom-client";

const PREFIX = "hr_recruitment";

// --- label allowlists --------------------------------------------------------

const PARSE_KINDS = Object.freeze(["CANDIDATE", "EMPLOYEE"]);
const parseKindLabel = (k) => (PARSE_KINDS.includes(String(k)) ? String(k) : "other");

const PARSE_OUTCOMES = Object.freeze(["ok", "cache-hit", "failed", "exhausted", "throttled", "flag-disabled"]);
const parseOutcomeLabel = (o) => (PARSE_OUTCOMES.includes(String(o)) ? String(o) : "other");

const NOTIFY_EVENTS = Object.freeze([
    "application_created", "application_stage_changed", "interview_scheduled",
    "interview_cancelled", "interview_rescheduled", "interview_reschedule_requested",
    "interview_outcome_recorded", "offer_sent", "offer_accepted", "candidate_hired",
    "handoff_completed", "handoff_failed", "requisition_posted", "requisition_decided",
    "requisition_submitted", "requisition_closed",
    // Portal candidate emails, counted once by the notification transport.
    "email_verification", "status_link", "application_confirmation", "mailbox_notice", "draft_link",
]);
const notifyEventLabel = (e) => (NOTIFY_EVENTS.includes(String(e)) ? String(e) : "other");

const NOTIFY_OUTCOMES = Object.freeze(["enqueued", "dropped-flag", "dropped-error"]);
const notifyOutcomeLabel = (o) => (NOTIFY_OUTCOMES.includes(String(o)) ? String(o) : "dropped-error");

const HANDOFF_OUTCOMES = Object.freeze(["completed", "failed"]);
const handoffOutcomeLabel = (o) => (HANDOFF_OUTCOMES.includes(String(o)) ? String(o) : "failed");

const EXPORT_FORMATS = Object.freeze(["csv", "pdf"]);
const exportFormatLabel = (f) => (EXPORT_FORMATS.includes(String(f)) ? String(f) : "other");

const EXPORT_OUTCOMES = Object.freeze(["ok", "denied", "failed"]);
const exportOutcomeLabel = (o) => (EXPORT_OUTCOMES.includes(String(o)) ? String(o) : "failed");

const RETENTION_OUTCOMES = Object.freeze(["dry-run", "applied", "refused-flag", "refused-tenant", "failed"]);
const retentionOutcomeLabel = (o) => (RETENTION_OUTCOMES.includes(String(o)) ? String(o) : "failed");

// --- metric names (exported for tests/dashboards) ----------------------------

export const TRANSITION_FAILURES_METRIC = `${PREFIX}_transition_failures_total`;
export const HANDOFF_METRIC = `${PREFIX}_handoffs_total`;
export const RESUME_PARSE_METRIC = `${PREFIX}_resume_parses_total`;
export const NOTIFICATION_METRIC = `${PREFIX}_notifications_total`;
export const DENIALS_METRIC = `${PREFIX}_denials_total`;
export const EXPORTS_METRIC = `${PREFIX}_exports_total`;
export const RETENTION_METRIC = `${PREFIX}_retention_runs_total`;

// --- builders ----------------------------------------------------------------

function buildCounter(name, help, labelNames) {
    return new client.Counter({ name, help, labelNames });
}

let _transitionFailures = null;
function transitionFailuresCounter() {
    if (_transitionFailures === null) {
        _transitionFailures =
            client.register.getSingleMetric(TRANSITION_FAILURES_METRIC) ||
            buildCounter(
                TRANSITION_FAILURES_METRIC,
                "Recruitment application stage-transition failures, labeled by failure code family.",
                ["code"],
            );
    }
    return _transitionFailures;
}

let _handoffs = null;
function handoffsCounter() {
    if (_handoffs === null) {
        _handoffs =
            client.register.getSingleMetric(HANDOFF_METRIC) ||
            buildCounter(
                HANDOFF_METRIC,
                "Recruitment hiring handoff outcomes, labeled by outcome (completed or failure family).",
                ["outcome"],
            );
    }
    return _handoffs;
}

let _resumeParses = null;
function resumeParsesCounter() {
    if (_resumeParses === null) {
        _resumeParses =
            client.register.getSingleMetric(RESUME_PARSE_METRIC) ||
            buildCounter(
                RESUME_PARSE_METRIC,
                "Resume parse attempts through the AI plane, labeled by ingestion kind and outcome.",
                ["kind", "outcome"],
            );
    }
    return _resumeParses;
}

let _notifications = null;
function notificationsCounter() {
    if (_notifications === null) {
        _notifications =
            client.register.getSingleMetric(NOTIFICATION_METRIC) ||
            buildCounter(
                NOTIFICATION_METRIC,
                "Recruitment notification events emitted to the hub, labeled by event and outcome.",
                ["event", "outcome"],
            );
    }
    return _notifications;
}

let _denials = null;
function denialsCounter() {
    if (_denials === null) {
        _denials =
            client.register.getSingleMetric(DENIALS_METRIC) ||
            buildCounter(
                DENIALS_METRIC,
                "Recruitment permission denials at the route-authorization boundary, labeled by denial code.",
                ["code"],
            );
    }
    return _denials;
}

let _exports = null;
function exportsCounter() {
    if (_exports === null) {
        _exports =
            client.register.getSingleMetric(EXPORTS_METRIC) ||
            buildCounter(
                EXPORTS_METRIC,
                "Recruitment bulk exports, labeled by format and outcome.",
                ["format", "outcome"],
            );
    }
    return _exports;
}

let _retention = null;
function retentionCounter() {
    if (_retention === null) {
        _retention =
            client.register.getSingleMetric(RETENTION_METRIC) ||
            buildCounter(
                RETENTION_METRIC,
                "Retention runs, labeled by outcome (dry-run, applied, refused-flag, failed).",
                ["outcome"],
            );
    }
    return _retention;
}

// --- record helpers (never throw) --------------------------------------------

export function recordTransitionFailure(code) {
    try {
        transitionFailuresCounter().inc({ code: String(code ?? "unknown").slice(0, 60) || "unknown" });
    } catch {
        // Never derail the recruitment write on a metrics registry hiccup.
    }
}

export function recordHandoff(outcome) {
    try {
        handoffsCounter().inc({ outcome: handoffOutcomeLabel(outcome) });
    } catch {
        // Never derail the handoff on a metrics registry hiccup.
    }
}

export function recordResumeParse({ kind, outcome }) {
    try {
        resumeParsesCounter().inc({ kind: parseKindLabel(kind), outcome: parseOutcomeLabel(outcome) });
    } catch {
        // Never derail the parse on a metrics registry hiccup.
    }
}

export function recordRecruitmentNotification(event, outcome) {
    try {
        notificationsCounter().inc({ event: notifyEventLabel(event), outcome: notifyOutcomeLabel(outcome) });
    } catch {
        // Never derail the event emit on a metrics registry hiccup.
    }
}

export function recordDenial(code) {
    try {
        denialsCounter().inc({ code: String(code ?? "unknown").slice(0, 12) || "unknown" });
    } catch {
        // Never derail the denial response on a metrics registry hiccup.
    }
}

export function recordExport(format, outcome) {
    try {
        exportsCounter().inc({ format: exportFormatLabel(format), outcome: exportOutcomeLabel(outcome) });
    } catch {
        // Never derail the export on a metrics registry hiccup.
    }
}

export function recordRetentionRun(outcome) {
    try {
        retentionCounter().inc({ outcome: retentionOutcomeLabel(outcome) });
    } catch {
        // Never derail the retention run on a metrics registry hiccup.
    }
}

// --- registry attachment ------------------------------------------------------

/** Idempotently attach every counter to a private registry (per createApp()). */
export function attachRecruitmentOpsMetrics(register) {
    const names = [
        [TRANSITION_FAILURES_METRIC, transitionFailuresCounter],
        [HANDOFF_METRIC, handoffsCounter],
        [RESUME_PARSE_METRIC, resumeParsesCounter],
        [NOTIFICATION_METRIC, notificationsCounter],
        [DENIALS_METRIC, denialsCounter],
        [EXPORTS_METRIC, exportsCounter],
        [RETENTION_METRIC, retentionCounter],
    ];
    for (const [name, factory] of names) {
        if (register.getSingleMetric && register.getSingleMetric(name)) continue;
        try {
            register.registerMetric(factory());
        } catch {
            // Already registered on this registry; nothing to do.
        }
    }
}

// Jest re-import safety.
export function _resetRecruitmentOpsMetricsForTests() {
    for (const name of [TRANSITION_FAILURES_METRIC, HANDOFF_METRIC, RESUME_PARSE_METRIC, NOTIFICATION_METRIC, DENIALS_METRIC, EXPORTS_METRIC, RETENTION_METRIC]) {
        client.register.removeSingleMetric(name);
    }
    _transitionFailures = _handoffs = _resumeParses = null;
    _notifications = _denials = _exports = _retention = null;
}
