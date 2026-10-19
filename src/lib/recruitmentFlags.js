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
    // talent-pool invitation expiry). Approval itself is the HR Approval
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
    // §7 — AI advisory features (match summary; resume parsing degrades to a
    // clear 503 when off).
    ai: {
        env: "HR_RECRUITMENT_AI",
        def: false, // OFF: §7.1b — with no approved provider/config, AI stays disabled
        desc: "AI advisory features (candidate match summary, resume parsing via the plane)",
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
