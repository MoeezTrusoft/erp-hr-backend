// src/lib/recruitmentFlags.js
//
// Phase 15 — the Recruitment rollout FEATURE FLAGS.
//
// The plan's rollout order is security → workflow enforcement → offer/handoff
// → portal/privacy → analytics → AI. That sequence needs per-area switches so
// a deployment can enable capabilities in stages and disable one WITHOUT
// redeploying. Flags are environment variables read AT CALL TIME (never cached
// at import — an operator flips the env and restarts, or a future config
// service can back the same getters) with one frozen definition table, so the
// set of flags is greppable and the defaults are decisions, not accidents.
//
// DEFAULTS ARE OFF ONLY FOR NEW BEHAVIOUR. The flags gate the Phase 2.2–13
// capabilities that change what a legacy caller can do; the base requisition/
// application/offer CRUD that predates this branch is NOT flag-gated, because
// disabling it would not be a rollout — it would be an outage.
//
// Failure posture: reading a flag NEVER throws. An unset/unknown value falls
// back to the documented default so a typo cannot take a feature down.

const DEFINITIONS = Object.freeze({
    // §2 — requisition workflow enforcement. Read by the mandatory-field
    // submission gate and by the scheduled sweeps (requisition auto-close,
    // talent-pool invitation expiry). Approval
    // itself is the HR Approval
    // Centre's and is never flag-gated.
    workflow: {
        env: "HR_RECRUITMENT_WORKFLOW_ENFORCEMENT",
        def: true, // ON: the audit and the plan treat this as the intended state
        desc: "Requisition mandatory-field submission gate and the scheduled recruitment sweeps",
    },
    // §2.7-adjacent — offer acceptance and the hiring handoff pipeline. Off
    // refuses acceptance and handoff runs with a 503, so no hire is left
    // half-provisioned; offer approval stays with the HR Approval Centre.
    offerHandoff: {
        env: "HR_RECRUITMENT_OFFER_HANDOFF",
        def: true,
        desc: "Offer acceptance and the hiring handoff pipeline",
    },
    // §3 — public careers portal intake (the internet-facing surface).
    portal: {
        env: "HR_RECRUITMENT_PUBLIC_PORTAL",
        def: true,
        desc: "Public portal application intake and job listings",
    },
    // §10 — privacy automation (retention apply mode; consent/DNC enforcement
    // stays ALWAYS ON — it is a legal control, not a feature).
    retention: {
        env: "HR_RECRUITMENT_RETENTION_AUTOMATION",
        def: false, // OFF: retention apply is dry-run-only until the policy owner approves (§8)
        desc: "Automated retention application (dry-run remains available regardless)",
    },
    // §6 — canonical analytics block in the analytics payload.
    analytics: {
        env: "HR_RECRUITMENT_CANONICAL_ANALYTICS",
        def: true,
        desc: "canonicalMetrics block in the recruitment analytics payload",
    },
    // F-35 — the recruitment dashboard's headline numbers (open positions,
    // time to fill, offer acceptance and the KPI alerts built on them) read the
    // canonical definitions above instead of the dashboard's older formulas.
    // OFF until the numbers are reconciled with the dashboard's owners, because
    // switching it changes figures people already report.
    canonicalDashboard: {
        env: "HR_RECRUITMENT_CANONICAL_DASHBOARD",
        def: false,
        desc: "Recruitment dashboard headline metrics use the canonical definitions",
    },
    // §7 — AI advisory features (match summary; resume parsing degrades to a
    // clear 503 when off).
    ai: {
        env: "HR_RECRUITMENT_AI",
        def: false, // OFF: §7.1b — with no approved provider/config, AI stays disabled
        desc: "AI advisory features (candidate match summary, resume parsing via the plane)",
    },
    // F-02 — requisition/offer approval SLA reminders and escalation (the
    // scheduled recruitment-approval-sla sweep). OFF until the Notification Hub
    // maps the reminder/escalation events, so a deploy never starts nagging
    // approvers through a consumer that drops the event.
    approvalSla: {
        env: "HR_RECRUITMENT_APPROVAL_SLA",
        def: false,
        desc: "Approval SLA reminders and escalation for pending requisition/offer approvals",
    },
    // F-04 — publish an APPROVED requisition to the default channel(s) without
    // a recruiter action (the scheduled requisition-autopublish sweep). OFF:
    // publication is candidate-facing, so a tenant opts in deliberately.
    autoPublish: {
        env: "HR_RECRUITMENT_AUTO_PUBLISH",
        def: false,
        desc: "Automatic publication of approved requisitions to the default channel(s)",
    },
    // F-04 — close a posted requisition's active postings once its closesAt has
    // passed (the scheduled requisition-posting-expiry sweep). OFF: the first
    // run closes every posting already past its date, so a tenant switches it
    // on once those requisitions have been reviewed. Applications past closesAt
    // are refused either way (requisitionEligibility).
    postingExpiry: {
        env: "HR_RECRUITMENT_POSTING_EXPIRY",
        def: false,
        desc: "Automatic closing of postings on requisitions past their closesAt",
    },
    // Phase 2 — intake and screening. Every switch below changes what happens
    // to an applicant without a recruiter action, so each is OFF until a tenant
    // has reviewed its settings. DNC at intake is not here: it is a legal
    // control and always on (see retention above).
    //
    // Knockout questions: an answer outside a question's knockout rule
    // schedules a MINIMUM_REQUIREMENTS_NOT_MET rejection after the tenant's
    // knockoutDelayHours, cancellable until it runs. Off records the knockout
    // on the answer but schedules nothing.
    knockout: {
        env: "HR_RECRUITMENT_KNOCKOUT",
        def: false,
        desc: "Scheduled, reversible rejection of applications that fail a knockout question",
    },
    // The per-tenant XML job feed for job boards. Off serves 404 for every
    // feed URL, whatever the tenant's own feedEnabled says.
    jobFeed: {
        env: "HR_RECRUITMENT_JOB_FEED",
        def: false,
        desc: "Per-tenant XML job feed for job boards",
    },
    // Resume parsing on a queue (the parse worker) instead of in the request.
    // Off leaves queued parses PENDING; the synchronous parse tools still work.
    // The worker also needs HR_RECRUITMENT_AI on, since it parses through the
    // AI plane (the name follows the *_WORKER_ENABLED convention).
    parseWorker: {
        env: "HR_RESUME_PARSE_WORKER_ENABLED",
        def: false,
        desc: "Asynchronous resume parse worker",
    },
    // Fit score, ranking and shortlist proposals.
    scoring: {
        env: "HR_RECRUITMENT_SCORING",
        def: false,
        desc: "Application fit score, requisition ranking and shortlist proposals",
    },
    // Templated candidate emails driven by recruitment events, with a log, the
    // rejection delay and DNC checked again at send.
    communications: {
        env: "HR_RECRUITMENT_COMMUNICATIONS",
        def: false,
        desc: "Templated candidate communications from recruitment events",
    },
    // Duplicate candidate detection and merge suggestions (never merges on
    // its own; a recruiter accepts a suggestion).
    duplicates: {
        env: "HR_RECRUITMENT_DUPLICATES",
        def: false,
        desc: "Duplicate candidate detection and merge suggestions",
    },
    // Phase 3a — interview and offer orchestration. Each switch below writes to
    // a calendar, messages a person or changes an offer without a recruiter
    // action, so each is OFF until the tenant (and the external service it
    // depends on) is ready.
    //
    // Calendar events for interviews through the Communication module (create,
    // update, cancel) and its free-busy lookup for the slot finder. Off leaves
    // calendarSyncStatus PENDING; nothing is written to any calendar.
    calendarSync: {
        env: "HR_RECRUITMENT_CALENDAR_SYNC",
        def: false,
        desc: "Interview calendar events and free-busy through the Communication module",
    },
    // Slot offers a candidate picks from through the portal; the confirm
    // creates the interview. Off refuses sending and confirming (proposing a
    // slot set for review still works).
    selfScheduling: {
        env: "HR_RECRUITMENT_SELF_SCHEDULING",
        def: false,
        desc: "Candidate self-scheduling from offered interview slots",
    },
    // Interview reminders (24 h and 1 h before), feedback nudges and
    // escalation, and the no-show disposition prompt.
    interviewReminders: {
        env: "HR_RECRUITMENT_INTERVIEW_REMINDERS",
        def: false,
        desc: "Interview reminders, feedback nudges and escalation",
    },
    // The hiring manager's decision prompt once every panel scorecard is in,
    // and the automatic advance of the application on a NEXT_ROUND decision.
    decisionPrompts: {
        env: "HR_RECRUITMENT_DECISION_PROMPTS",
        def: false,
        desc: "Decision prompts after the panel's scorecards and auto-advance on NEXT_ROUND",
    },
    // Offer letters rendered from the tenant's versioned templates to a PDF
    // in DAM.
    offerLetters: {
        env: "HR_RECRUITMENT_OFFER_LETTERS",
        def: false,
        desc: "Versioned offer letters rendered from tenant templates",
    },
    // Sending a letter for e-signature through the adapter, and applying the
    // provider's webhook (a signed letter accepts the offer).
    esign: {
        env: "HR_RECRUITMENT_ESIGN",
        def: false,
        desc: "Offer letter e-signature round trip",
    },
    // The offer expiry sweep: reminds the candidate before expiryDate and sets
    // EXPIRED once it has passed. OFF: the first run would expire every SENT
    // offer already past its date, so a tenant switches it on after review.
    offerExpiry: {
        env: "HR_RECRUITMENT_OFFER_EXPIRY",
        def: false,
        desc: "Offer expiry reminders and automatic expiry",
    },
});

export const RECRUITMENT_FLAG_DEFINITIONS = DEFINITIONS;

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled"]);

function parseRaw(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const v = String(raw).trim().toLowerCase();
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    return fallback; // unknown value → documented default, never a crash
}

/**
 * Read one flag by key. Never throws.
 * @param {keyof typeof DEFINITIONS} key
 * @returns {boolean}
 */
export function isRecruitmentFlagEnabled(key) {
    const def = DEFINITIONS[key];
    if (!def) return false; // unknown key → off (fail closed for capabilities)
    return parseRaw(process.env[def.env], def.def);
}

/**
 * Snapshot of every flag with its env name, value and description — for the
 * /metrics exposition and the runbook's "what is on right now" check.
 */
export function recruitmentFlagSnapshot() {
    return Object.fromEntries(
        Object.entries(DEFINITIONS).map(([key, def]) => [
            key,
            { env: def.env, enabled: isRecruitmentFlagEnabled(key), default: def.def, description: def.desc },
        ]),
    );
}
