// src/lib/candidate-status-view.util.js
//
// Phase 5 / decision record §3.5a — the CANDIDATE-VISIBLE status projection.
//
// "Simplified states only: Submitted, Under Review, Interview, Offer, Offer
// Accepted/Onboarding, Closed, Withdrawn. Never expose internal rejection
// reason codes, recruiter comments or AI scores. The external state set stays
// SIMPLER than the internal ATS state machine."
//
// This module is the entire mapping and nothing else — pure, no DB — so the
// public endpoint, the email copy and any future notification surface cannot
// drift apart on what a candidate is allowed to see:
//
//   internal stage     → candidate-visible
//   ----------------     ---------------------------------------------
//   applied            → Submitted
//   screening          → Under Review
//   on_hold            → Under Review   (never show a parking state)
//   interview          → Interview
//   offer              → Offer
//   hired              → Offer Accepted / Onboarding
//   rejected           → Closed         (reason codes NEVER cross)
//   withdrawn          → Withdrawn
//
// On top of the stage, an ACCEPTED offer sharpens `offer` into "Offer
// Accepted" even before the (async, handoff-driven) onboarding state lands.
// TERMINAL visibility: a Withdrawn application shows Withdrawn; Closed hides
// nothing (the decision record says Closed, not "disappeared").
//
// ANTI-ENUMERATION support: projectCandidateStatus returns null for an
// application the caller must not know about, and the endpoint renders the
// SAME "no applications" body for "wrong link", "revoked link" and "no
// applications" — a status link can never be probed for which emails exist.
export const CANDIDATE_VISIBLE_STATUSES = Object.freeze([
    "SUBMITTED",
    "UNDER_REVIEW",
    "INTERVIEW",
    "OFFER",
    "OFFER_ACCEPTED",
    "CLOSED",
    "WITHDRAWN",
]);

const STAGE_TO_VISIBLE = Object.freeze({
    applied: "SUBMITTED",
    screening: "UNDER_REVIEW",
    on_hold: "UNDER_REVIEW",
    interview: "INTERVIEW",
    offer: "OFFER",
    hired: "OFFER_ACCEPTED",
    rejected: "CLOSED",
    withdrawn: "WITHDRAWN",
});

/**
 * One application row (+ its offer status, when present) → the candidate-
 * visible view. Returns null for a row outside the visible contract (unknown
 * internal stage — refuse, never guess).
 *
 * @param {{stage?: string, updatedAt?: Date, status?: string}} application
 * @param {{offerStatus?: string|null}} [extra]
 * @returns {null | {status: string, label: string, updatedAt: string|null}}
 */
export function projectCandidateStatus(application, extra = {}) {
    const stage = String(application?.stage ?? "").toLowerCase();
    let visible = STAGE_TO_VISIBLE[stage];
    if (!visible) return null;
    if (visible === "OFFER" && String(extra?.offerStatus ?? "").toUpperCase() === "ACCEPTED") {
        visible = "OFFER_ACCEPTED";
    }
    return {
        status: visible,
        label: visibleToLabel(visible),
        updatedAt: application?.updatedAt ? new Date(application.updatedAt).toISOString() : null,
    };
}

const LABELS = Object.freeze({
    SUBMITTED: "Submitted",
    UNDER_REVIEW: "Under Review",
    INTERVIEW: "Interview",
    OFFER: "Offer",
    OFFER_ACCEPTED: "Offer Accepted / Onboarding",
    CLOSED: "Closed",
    WITHDRAWN: "Withdrawn",
});

export function visibleToLabel(visible) {
    return LABELS[visible] ?? null;
}

/**
 * The full public payload for a status-link holder: every VISIBLE application,
 * newest first, each stripped to { jobTitle, status, label, updatedAt }. A
 * candidate with zero visible applications yields an empty list — the endpoint
 * must render the same body as "link not found" (§3.4), so an empty result is
 * indistinguishable from a revoked or wrong link on the wire.
 *
 * @param {Array<{stage: string, updatedAt?: Date, jobRequisition?: {title?: string|null}|null, offer?: {status?: string}|null}>} applications
 * @returns {{applications: Array<{jobTitle: string|null, status: string, label: string, updatedAt: string|null}>}}
 */
export function projectCandidateStatusList(applications = []) {
    const list = (Array.isArray(applications) ? applications : [])
        .map((a) => {
            const view = projectCandidateStatus(a, { offerStatus: a?.offer?.status });
            if (!view) return null;
            return {
                jobTitle: a?.jobRequisition?.title ?? null,
                status: view.status,
                label: view.label,
                updatedAt: view.updatedAt,
            };
        })
        .filter(Boolean);
    list.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return { applications: list };
}
