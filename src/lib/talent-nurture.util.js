// src/lib/talent-nurture.util.js — Recruitment Phase 5 / plan 6.2.
//
// PURE talent pool nurture decisions: which requisitions get a proposal, what
// segment a requisition implies, who falls out of it, and how a run moves. No
// DB and no I/O, so the matrix is unit-testable and the job, the tools and the
// acceptance hook cannot drift apart.
//
// Why a run is a PROPOSAL and not a send: a posted requisition is a good moment
// to tell kept-on-file people about it, but contacting a pool is unsolicited
// outbound contact. The system builds the segment; a recruiter decides. One run
// per requisition (the schema's unique key), so a requisition is proposed once,
// even when nobody matches, and the job never rebuilds it.
import { APPLICATION_ACCEPTING_STATUSES } from "./requisitionEligibility.js";

const fail = (message, code, status = 422) => Object.assign(new Error(message), { status, code });

/** The closed run vocabulary (mirrors the talent_pool_nurture_runs CHECK). */
export const NURTURE_RUN_STATUS = Object.freeze({
    PROPOSED: "PROPOSED",
    SENT: "SENT",
    DISMISSED: "DISMISSED",
    EXPIRED: "EXPIRED",
});
export const NURTURE_RUN_STATUSES = Object.freeze(Object.values(NURTURE_RUN_STATUS));

/** One-way: only a PROPOSED run is decided, and a decided run never moves again. */
const RUN_TRANSITIONS = Object.freeze({
    PROPOSED: Object.freeze(["SENT", "DISMISSED", "EXPIRED"]),
    SENT: Object.freeze([]),
    DISMISSED: Object.freeze([]),
    EXPIRED: Object.freeze([]),
});

/** The invitation validity the plan names; the CHECK allows 1..365. */
export const DEFAULT_NURTURE_VALIDITY_DAYS = 30;
const MAX_VALIDITY_DAYS = 365;

/**
 * At most this many members per proposal. Sending is one transaction (the
 * claim, every invitation and its event commit together), so the batch has a
 * ceiling; the rest of the segment is reported as truncated, not dropped
 * silently.
 */
export const MAX_NURTURE_MEMBERS = 200;

export const MAX_DISMISS_REASON_LENGTH = 500;

// Location text that names no place: a remote role segments on skills only.
const PLACELESS_LOCATION = /\b(remote|anywhere|work from home|wfh|distributed)\b/i;

const uniqueText = (values) => {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const text = String(value ?? "").trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
};

/**
 * The location needle for a requisition's free-text location.
 *
 * The pool predicate matches when the candidate's location CONTAINS the needle,
 * so "Lahore, Pakistan" is cut to its first part ("Lahore"): the whole string
 * would match nobody who wrote "Lahore", and the country alone would match
 * everyone. A remote role has no needle.
 */
export function nurtureLocationNeedle(location) {
    const text = String(location ?? "").trim();
    if (!text || PLACELESS_LOCATION.test(text)) return null;
    const first = text.split(/[,/|;(]/)[0].trim();
    return first || null;
}

/**
 * The nurture criteria for one requisition.
 *
 * @param {object} requisition      { location }
 * @param {{required?: string[], preferred?: string[]}|null} skillRequirements
 *        the requisition's skills (structured job content first, the legacy
 *        requirements text as the fallback: candidateMatch.requisitionSkillRequirements)
 */
export function buildNurtureCriteria(requisition, skillRequirements) {
    const skills = uniqueText([...(skillRequirements?.required ?? []), ...(skillRequirements?.preferred ?? [])]);
    const needle = nurtureLocationNeedle(requisition?.location);
    return {
        skills,
        locations: needle ? [needle] : [],
        remote: Boolean(requisition?.location) && !needle,
    };
}

/**
 * The pool segment the criteria imply, or null when there is none.
 *
 * Skills are required: a location alone would invite everyone in a city to any
 * role there, which is not a match. Skills are any-of (the pool predicate's
 * rule); the location narrows when the role has one.
 */
export function segmentFiltersFor(criteria) {
    if (!criteria?.skills?.length) return null;
    return {
        skills: [...criteria.skills],
        ...(criteria.locations?.length ? { locations: [...criteria.locations] } : {}),
    };
}

/** Whether a requisition can be proposed now: the same gate an application passes. */
export const isNurturable = (evaluation) => evaluation?.eligible === true;

/**
 * Whether a PROPOSED run's requisition has closed: it left the accepting
 * states or its application window passed. A requisition that is only between
 * channels (POSTED, no live posting) is not closed, so its proposal waits.
 */
export function nurtureRunShouldExpire(requisition, now = new Date()) {
    if (!requisition) return true;
    const status = String(requisition.status ?? "").trim().toUpperCase();
    if (!APPLICATION_ACCEPTING_STATUSES.includes(status)) return true;
    const closesAt = requisition.closesAt ? new Date(requisition.closesAt) : null;
    return Boolean(closesAt && closesAt.getTime() < new Date(now).getTime());
}

/**
 * Why a pool member is not proposed, privacy reasons first: a do-not-contact
 * entry or withdrawn consent outranks "already applied" in the report.
 * Returns null when the member stays in.
 */
export function nurtureExclusionReason({ anonymized, dnc, consentWithdrawn, applied, invited } = {}) {
    if (anonymized) return "anonymized";
    if (dnc) return "dnc";
    if (consentWithdrawn) return "consent_withdrawn";
    if (applied) return "applied";
    if (invited) return "invited";
    return null;
}

/** Positive, distinct integer ids from a stored Json column (order kept). */
export function parseCandidateIds(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const n = Number(item);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * The members a recruiter approves: the proposal minus the ones they dropped.
 * A drop id that was never proposed is reported, not an error: the intent
 * (that person is not invited) already holds.
 */
export function approvedMembers(candidateIds, dropCandidateIds = []) {
    const proposed = parseCandidateIds(candidateIds);
    const drop = new Set(parseCandidateIds(dropCandidateIds));
    const proposedSet = new Set(proposed);
    return {
        approved: proposed.filter((id) => !drop.has(id)),
        dropped: proposed.filter((id) => drop.has(id)),
        ignoredDropIds: [...drop].filter((id) => !proposedSet.has(id)),
    };
}

/** Whether a run may move from `from` to `to`; a reason instead of a throw. */
export function checkNurtureRunTransition(from, to) {
    const fromStatus = String(from ?? "").trim().toUpperCase();
    const toStatus = String(to ?? "").trim().toUpperCase();
    if (!NURTURE_RUN_STATUSES.includes(fromStatus) || !NURTURE_RUN_STATUSES.includes(toStatus)) {
        return { ok: false, error: `Unknown nurture run status "${!NURTURE_RUN_STATUSES.includes(fromStatus) ? from : to}"`, code: "HR-RECRUITMENT-NURTURE-STATUS-INVALID" };
    }
    if (!RUN_TRANSITIONS[fromStatus].includes(toStatus)) {
        return {
            ok: false,
            error: `A nurture run in status ${fromStatus} cannot become ${toStatus}`,
            code: "HR-RECRUITMENT-NURTURE-TRANSITION-INVALID",
        };
    }
    return { ok: true };
}

/** The validity for a send: the run's own (30 by default) unless overridden. */
export function resolveValidityDays(value, fallback = DEFAULT_NURTURE_VALIDITY_DAYS) {
    const raw = value === undefined || value === null || value === "" ? fallback : value;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) {
        throw fail(`validityDays must be a whole number between 1 and ${MAX_VALIDITY_DAYS}`, "HR-RECRUITMENT-NURTURE-VALIDITY-INVALID");
    }
    return days;
}

/** A dismissal reason: required, trimmed, bounded. */
export function normalizeDismissReason(reason) {
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text) throw fail("A reason is required to dismiss a nurture proposal", "HR-RECRUITMENT-NURTURE-REASON-REQUIRED", 400);
    if (text.length > MAX_DISMISS_REASON_LENGTH) {
        throw fail(`The reason must be at most ${MAX_DISMISS_REASON_LENGTH} characters`, "HR-RECRUITMENT-NURTURE-REASON-REQUIRED", 400);
    }
    return text;
}

/**
 * The application sourceDetail an accepted nurture invitation records: the run
 * that sent it (a routing id, never PII), within the column's 200 characters.
 */
export const nurtureSourceDetail = (runId) => `nurture:${Number(runId)}`;
