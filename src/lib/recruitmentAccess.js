// src/lib/recruitmentAccess.js
//
// Phase 1.4 — RECORD-LEVEL access control for Recruitment.
//
// A verified actor with a valid `hr:recruitment` grant is not the same thing as
// someone entitled to every row. This module turns the caller's role claim into
// a *row scope*, so a hiring manager sees their own requisitions and an
// interviewer sees only the interviews they sit on — without duplicating the
// decision at each call site.
//
// The model (one place, one table):
//
//   ORG       HR admin / HR manager / recruiter — the whole tenant funnel.
//   MANAGED   hiring / department manager — requisitions they requested or
//             approved, plus the applications and interviews attached to them.
//   ASSIGNED  interviewer — only interviews they were placed on (and, through
//             them, the candidate they are meeting).
//   FINANCE   compensation views only; no candidate notes, no requisition
//             administration.
//   AGENCY    external agency — no internal notes and no requisition view.
//
// Two deliberate choices:
//
//  1. UNKNOWN ROLES FALL BACK TO ORG, not to "no rows". F-02 has ALREADY decided
//     the caller may use the hr:recruitment surface, and this service does not own
//     the tenant's full role vocabulary. Denying rows to a role we simply do not
//     recognise would take recruiting offline for every unfamiliar vocabulary
//     while adding no security — an unrecognised role is not the threat model;
//     a known manager reading someone else's requisition is.
//  2. Out-of-scope reads return NOT FOUND (404 / empty), never 403. Telling a
//     hiring manager "forbidden" on an id they guessed confirms the row exists.
//
// Pure functions only — no DB, no I/O — so the whole matrix is unit-testable.

export const RECRUITMENT_SCOPE = Object.freeze({
    ORG: "ORG",
    MANAGED: "MANAGED",
    ASSIGNED: "ASSIGNED",
    FINANCE: "FINANCE",
    AGENCY: "AGENCY",
});

// Roles that grant the organisation-wide view of recruitment.
const ORG_ROLES = Object.freeze([
    "HR_ADMIN",
    "HR_MANAGER",
    "RBAC_ADMIN",
    "RECRUITER",
    "TA_RECRUITER",
    "TALENT_ACQUISITION",
]);

// Roles whose reach is limited to the requisitions they own.
const MANAGED_ROLES = Object.freeze([
    "DEPARTMENT_MANAGER",
    "HIRING_MANAGER",
    "LINE_MANAGER",
    "MANAGER",
]);

// Roles limited to interviews they were assigned to.
const ASSIGNED_ROLES = Object.freeze(["INTERVIEWER", "PANELIST", "PANEL_MEMBER"]);

const FINANCE_ROLES = Object.freeze(["FINANCE", "FINANCE_MANAGER", "FINANCE_ADMIN"]);
const AGENCY_ROLES = Object.freeze(["EXTERNAL_AGENCY", "AGENCY", "AGENCY_USER"]);

const normalizeRole = (role) => String(role ?? "").trim().toUpperCase();

/** The caller's role claims, however the transport happened to pass them. */
export const rolesOf = (user) => {
    const raw = user?.roles;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!list.length && user?.role) list.push(user.role);
    return list.map(normalizeRole).filter(Boolean);
};

const hasAny = (roles, candidates) => candidates.some((role) => roles.includes(role));

const employeeIdOf = (user) => {
    const id = Number(user?.employeeId);
    return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * Resolve the caller's recruitment row scope.
 * @param {object} user - verified actor ({ roles|role, employeeId, isAdmin })
 * @returns {{level:string, employeeId:number|null, unrestricted:boolean, canSeeInternalNotes:boolean, canSeeRequisitions:boolean, canSeeCompensation:boolean}}
 */
export function resolveRecruitmentScope(user) {
    const roles = rolesOf(user);
    const employeeId = employeeIdOf(user);

    // An admin claim with a real employee id still scopes to ORG; the actor is
    // only used for attribution, not for narrowing an admin's reach.
    const level =
        (user?.isAdmin === true || hasAny(roles, ORG_ROLES)) ? RECRUITMENT_SCOPE.ORG
            : hasAny(roles, FINANCE_ROLES) ? RECRUITMENT_SCOPE.FINANCE
                : hasAny(roles, AGENCY_ROLES) ? RECRUITMENT_SCOPE.AGENCY
                    : hasAny(roles, MANAGED_ROLES) && employeeId ? RECRUITMENT_SCOPE.MANAGED
                        : hasAny(roles, ASSIGNED_ROLES) && employeeId ? RECRUITMENT_SCOPE.ASSIGNED
                            // Unknown or employee-only vocabulary: F-02 already granted the
                            // surface, so do not invent a narrower rule than the tenant has.
                            : RECRUITMENT_SCOPE.ORG;

    const unrestricted = level === RECRUITMENT_SCOPE.ORG;

    return {
        level,
        employeeId,
        unrestricted,
        canSeeInternalNotes: level === RECRUITMENT_SCOPE.ORG || level === RECRUITMENT_SCOPE.MANAGED,
        canSeeRequisitions: level !== RECRUITMENT_SCOPE.FINANCE && level !== RECRUITMENT_SCOPE.AGENCY,
        canSeeCompensation: level === RECRUITMENT_SCOPE.ORG || level === RECRUITMENT_SCOPE.FINANCE,
        canSeeCandidates: level !== RECRUITMENT_SCOPE.FINANCE,
    };
}

// A predicate that can never match, used instead of throwing: a list endpoint
// returns an empty page and a detail endpoint returns not-found.
const MATCH_NONE = Object.freeze({ id: { in: [] } });

/**
 * Where-clause fragment restricting requisitions to the caller's scope.
 * Compose it into the existing tenant-scoped predicate: `{ ...scoped, ...where }`.
 */
export function requisitionScopeWhere(scope) {
    if (scope.unrestricted) return {};
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return { OR: [{ requestedById: scope.employeeId }, { approvedById: scope.employeeId }] };
    }
    // FINANCE and AGENCY administer nothing here; ASSIGNED interviewers do not
    // create or edit openings. Deny rather than 403 (see module header).
    return { ...MATCH_NONE };
}

/** Where-clause fragment restricting interviews to the caller's scope. */
export function interviewScopeWhere(scope) {
    if (scope.unrestricted) return {};
    const assigned = { interviewers: { some: { employeeId: scope.employeeId } } };
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return {
            OR: [
                assigned,
                { application: { jobRequisition: { requestedById: scope.employeeId } } },
            ],
        };
    }
    if (scope.level === RECRUITMENT_SCOPE.ASSIGNED && scope.employeeId) return assigned;
    // A finance reviewer reads offers, not interview transcripts.
    return { ...MATCH_NONE };
}

/**
 * Where-clause fragment restricting candidates to the caller's scope.
 * Reached through the applications they belong to, since the link that grants a
 * manager or interviewer their view is the application, not the candidate row.
 */
export function candidateScopeWhere(scope) {
    if (scope.unrestricted) return {};
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return { applications: { some: { jobRequisition: { requestedById: scope.employeeId } } } };
    }
    if (scope.level === RECRUITMENT_SCOPE.ASSIGNED && scope.employeeId) {
        return {
            applications: {
                some: {
                    interviews: { some: { interviewers: { some: { employeeId: scope.employeeId } } } },
                },
            },
        };
    }
    return { ...MATCH_NONE };
}

/** Where-clause fragment restricting offers to the caller's scope. */
export function offerScopeWhere(scope) {
    if (scope.unrestricted) return {};
    // Finance and hiring managers both need the offer for the requisition they
    // own or are pricing; interviewers and agencies never see compensation.
    if (scope.level === RECRUITMENT_SCOPE.FINANCE) return {};
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return { application: { jobRequisition: { requestedById: scope.employeeId } } };
    }
    return { ...MATCH_NONE };
}

/**
 * Strip fields the caller's scope must not see from a candidate row.
 * Internal notes are the recruiter's working record and are not part of what an
 * interviewer or an external agency needs to do their job.
 */
export function maskCandidateForScope(candidate, scope) {
    if (!candidate || scope.canSeeInternalNotes) return candidate;
    // Copy-then-delete rather than rest-destructuring: the discarded binding in
    // `const { notes, ...rest }` trips no-unused-vars here (only args are exempt).
    const masked = { ...candidate, notes: null, notesRedacted: true };
    return masked;
}

/**
 * Same treatment for interview rows. An interview read also carries the
 * candidate through `application`, so the candidate's internal notes are
 * stripped there too — otherwise masking the interview alone would leak the
 * recruiter's notes through the nested relation.
 */
export function maskInterviewForScope(interview, scope) {
    if (!interview || scope.canSeeInternalNotes) return interview;
    const masked = { ...interview, notes: null, notesRedacted: true };
    const nested = interview.application?.candidate;
    if (nested) {
        masked.application = {
            ...interview.application,
            candidate: maskCandidateForScope(nested, scope),
        };
    }
    return masked;
}

// Null-scope tolerant list helpers: an unscoped internal caller gets the rows
// untouched rather than a crash, so callers can pass `scope ?? null`.
export const maskCandidatesForScope = (candidates, scope) =>
    !scope || !Array.isArray(candidates) ? candidates : candidates.map((c) => maskCandidateForScope(c, scope));

export const maskInterviewsForScope = (interviews, scope) =>
    !scope || !Array.isArray(interviews) ? interviews : interviews.map((i) => maskInterviewForScope(i, scope));

/**
 * Scope a list result: `{ items, total }` (or a bare array) becomes an empty page
 * when the caller may not see the collection at all.
 */
export function scopeListResult(result, allowed) {
    if (allowed) return result;
    if (Array.isArray(result)) return [];
    return { ...result, items: [], total: 0 };
}
