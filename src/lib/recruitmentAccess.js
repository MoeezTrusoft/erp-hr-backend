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
//   AGENCY    external agency (Phase 5, flag agencyPortal) — a registered,
//             active agency user reaches the applications and candidates their
//             agency owns (ownerAgencyId) and, through the agency portal only,
//             the requisitions assigned to it. No internal notes, no interviews,
//             no offers, no internal requisition rows. Without the flag, or for
//             a caller with no active mapping to an active agency, no rows.
//   ASSESSMENT reception and assessment authors / reviewers (Phase 3b) — NO
//             recruitment rows at all; their reach is the on-site assessment
//             tools, which check src/lib/assessment-access.util.js instead.
//   NONE      every other caller: a role claim this module does not know, and
//             a manager or interviewer claim without an employee id. NO rows,
//             no writes (Phase 6).
//
// Two deliberate choices:
//
//  1. UNKNOWN ROLES SEE NOTHING (Phase 6 decision; plan section 14). Who may
//     use the hr:recruitment surface and with which role is decided by RBAC,
//     which issues the role claims; a claim this module does not recognise is
//     not evidence of HR or recruiter standing, so it resolves to NONE, never
//     to the organisation-wide view. A manager or interviewer claim without an
//     employee id cannot be narrowed to its own rows, so it resolves to NONE
//     too. New role names are added to the lists below, not inferred.
//  2. Out-of-scope reads return NOT FOUND (404 / empty), never 403. Telling a
//     hiring manager "forbidden" on an id they guessed confirms the row exists.
//
// Pure functions only — no DB, no I/O — so the whole matrix is unit-testable.
// (The AGENCY membership is looked up by src/lib/agency-access.util.js and
// handed in on the user under AGENCY_MEMBERSHIP; this module only reads it.)

import { isRecruitmentFlagEnabled } from "./recruitmentFlags.js";

export const RECRUITMENT_SCOPE = Object.freeze({
    ORG: "ORG",
    MANAGED: "MANAGED",
    ASSIGNED: "ASSIGNED",
    FINANCE: "FINANCE",
    AGENCY: "AGENCY",
    ASSESSMENT: "ASSESSMENT",
    NONE: "NONE",
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
// Phase 3b — roles that exist for the interview-day assessment only. They must
// never fall through to the unknown-role ORG default: a receptionist would
// otherwise read every candidate, note and salary.
export const ASSESSMENT_ONLY_ROLES = Object.freeze(["RECEPTION", "RECEPTIONIST", "ASSESSMENT_AUTHOR", "ASSESSMENT_REVIEWER"]);

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

// Phase 5 — where agency-access.util.js puts the caller's resolved agency
// membership ({ agencyId, tenantId, userId, requisitionIds }, or null when the
// caller has none). A module-private Symbol, not a string key: a property copied
// from a token claim or a tool argument can never carry it, and JSON never
// serializes it into a log line or a response.
export const AGENCY_MEMBERSHIP = Symbol("hr.recruitment.agencyMembership");

const positiveIntOrNull = (value) => (Number.isInteger(value) && value > 0 ? value : null);

/**
 * The agency this AGENCY caller acts for, or null. The membership counts only
 * while the agencyPortal flag is on and only for the exact verified user and
 * tenant it was resolved for, so a membership object that strays onto another
 * user (or a context copied across tenants) grants nothing.
 */
function agencyMembershipOf(user) {
    if (!isRecruitmentFlagEnabled("agencyPortal")) return null;
    const membership = user?.[AGENCY_MEMBERSHIP];
    if (!membership || typeof membership !== "object") return null;
    const agencyId = positiveIntOrNull(membership.agencyId);
    const tenantId = typeof user?.tenantId === "string" ? user.tenantId : null;
    if (!agencyId || !tenantId || membership.tenantId !== tenantId) return null;
    if (user?.userId == null || String(membership.userId) !== String(user.userId)) return null;
    const requisitionIds = Array.isArray(membership.requisitionIds)
        ? [...new Set(membership.requisitionIds.filter((id) => positiveIntOrNull(id)))]
        : [];
    return { agencyId, requisitionIds };
}

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
                            : hasAny(roles, ASSESSMENT_ONLY_ROLES) ? RECRUITMENT_SCOPE.ASSESSMENT
                            // Unknown or employee-only vocabulary, or a manager or
                            // interviewer claim with no employee id: no rows (see header).
                            : RECRUITMENT_SCOPE.NONE;

    const unrestricted = level === RECRUITMENT_SCOPE.ORG;

    const scope = {
        level,
        employeeId,
        unrestricted,
        canSeeInternalNotes: level === RECRUITMENT_SCOPE.ORG || level === RECRUITMENT_SCOPE.MANAGED,
        canSeeRequisitions:
            level !== RECRUITMENT_SCOPE.FINANCE && level !== RECRUITMENT_SCOPE.AGENCY && level !== RECRUITMENT_SCOPE.ASSESSMENT
            && level !== RECRUITMENT_SCOPE.NONE,
        canSeeCompensation: level === RECRUITMENT_SCOPE.ORG || level === RECRUITMENT_SCOPE.FINANCE,
        canSeeCandidates:
            level !== RECRUITMENT_SCOPE.FINANCE && level !== RECRUITMENT_SCOPE.ASSESSMENT && level !== RECRUITMENT_SCOPE.NONE,
    };
    if (level !== RECRUITMENT_SCOPE.AGENCY) return scope;

    // Phase 5 — the agency the caller acts for and the requisitions assigned to
    // it. An agency reads its own submissions' records, never the internal
    // candidate profile (Candidate 360, workspace cards): canSeeCandidates off.
    const membership = agencyMembershipOf(user);
    return {
        ...scope,
        canSeeCandidates: false,
        agencyId: membership?.agencyId ?? null,
        agencyRequisitionIds: membership?.requisitionIds ?? [],
    };
}

const agencyIdOf = (scope) =>
    scope?.level === RECRUITMENT_SCOPE.AGENCY ? positiveIntOrNull(scope.agencyId) : null;

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
    // AGENCY stays denied on purpose even with a membership: every reader of
    // this predicate returns the INTERNAL requisition row (budget, approval
    // chain, grade band, cost centre). An agency reads its assigned
    // requisitions only through agencyRequisitionScopeWhere and the portal's
    // agencyRequisitionView projection.
    return { ...MATCH_NONE };
}

/**
 * Phase 5 — the requisitions assigned to the caller's agency (the ACTIVE
 * assignments resolved with the membership). Used by the agency portal only,
 * together with agencyRequisitionView; any other scope matches none here.
 */
export function agencyRequisitionScopeWhere(scope) {
    const ids = agencyIdOf(scope) && Array.isArray(scope.agencyRequisitionIds) ? scope.agencyRequisitionIds : [];
    return ids.length ? { id: { in: [...ids] } } : { ...MATCH_NONE };
}

// The requisition fields an agency may see: what a candidate would read on a
// job ad. Never the salary band, budget, approvals, internal notes, the hiring
// team or other agencies.
const AGENCY_REQUISITION_FIELDS = Object.freeze(["id", "title", "description", "location", "employmentType", "closesAt"]);

/** The agency-safe projection of a requisition row (null-tolerant). */
export function agencyRequisitionView(requisition) {
    if (!requisition) return requisition ?? null;
    const out = {};
    for (const key of AGENCY_REQUISITION_FIELDS) out[key] = requisition[key] ?? null;
    return out;
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
    // Phase 5 — the candidates the caller's agency owns. One key, so a caller
    // that spreads its own OR / AND next to this fragment cannot replace it.
    const agencyId = agencyIdOf(scope);
    if (agencyId) return { ownerAgencyId: agencyId };
    return { ...MATCH_NONE };
}

/**
 * Where-clause fragment restricting applications to the caller's scope.
 *
 * The application is the join that grants a manager or an interviewer their view,
 * so the rule mirrors candidateScopeWhere: MANAGED reaches applications on the
 * requisitions they own, ASSIGNED reaches the applications they sit on a panel for.
 * FINANCE reaches none — a pricing reviewer has no business reading candidate
 * submissions. AGENCY (Phase 5) reaches the applications its agency owns
 * (Application.ownerAgencyId, recorded when a recruiter accepts a submission).
 */
export function applicationScopeWhere(scope) {
    if (scope.unrestricted) return {};
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return {
            jobRequisition: {
                OR: [{ requestedById: scope.employeeId }, { approvedById: scope.employeeId }],
            },
        };
    }
    if (scope.level === RECRUITMENT_SCOPE.ASSIGNED && scope.employeeId) {
        return { interviews: { some: { interviewers: { some: { employeeId: scope.employeeId } } } } };
    }
    // Phase 5 — the applications created from the agency's accepted submissions.
    const agencyId = agencyIdOf(scope);
    if (agencyId) return { ownerAgencyId: agencyId };
    return { ...MATCH_NONE };
}

/**
 * Where-clause fragment restricting offers to the caller's scope.
 */
/**
 * FR-09 residue — SENSITIVE-FIELD MASKING PARITY for offers.
 *
 * `offerScopeWhere` decides WHICH offers a caller may read; this decides which
 * FIELDS of those offers they may see. The two must agree, and until now they
 * did not: a hiring manager legitimately reads the offers for their own
 * requisitions (`offerScopeWhere` grants it) while `canSeeCompensation` is
 * ORG/FINANCE only — so a MANAGED caller was handed `salary`, `currency` and the
 * structured `compensation` block by a row they were allowed to open. Masking
 * is the second half of the ACL, exactly as it already is for candidates and
 * interviews.
 *
 * Masked fields are replaced by `null` plus an explicit `compensationRedacted`
 * marker, so a UI shows "restricted" rather than a misleading zero — and a
 * consumer can tell "not granted" apart from "no data". Contractual terms a
 * non-comp scope still needs to act on (respondedAt, status, dates) are kept.
 */
export function maskOfferForScope(offer, scope) {
    if (!offer || scope?.canSeeCompensation) return offer;
    return {
        ...offer,
        salary: null,
        currency: null,
        compensation: null,
        compensationRedacted: true,
    };
}

/** Same treatment for a page/list of offers. */
export const maskOffersForScope = (offers, scope) =>
    Array.isArray(offers) ? offers.map((o) => maskOfferForScope(o, scope)) : offers;

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
// Phase 2.2 / decision record §1.4 — requisition attachment visibility.
//
// Two audiences, because "attached to the requisition" is not one permission:
// the JOB_DESCRIPTION is hiring-team material, while a BUSINESS_JUSTIFICATION or
// BUDGET_APPROVAL document is internal. The rule is derived from the SAME scope
// the rest of recruitment uses rather than a new role list — an ORG caller
// (recruiter/HR) sees everything, everyone else sees only HIRING_TEAM rows. An
// AGENCY caller sees none, matching the existing "no requisition view" rule.
//
// Least privilege by construction: an unrecognised or narrower scope gets the
// NARROW arm, so a new scope added later cannot accidentally start exposing
// budget documents.
export function attachmentAudience(scope) {
    return scope === RECRUITMENT_SCOPE.ORG ? "INTERNAL" : "HIRING_TEAM";
}

/** Rows of `requisition_attachments` the caller may read. */
export function requisitionAttachmentScopeWhere(scope) {
    // No requisition view at all for an agency or an unrecognised caller.
    if (scope === RECRUITMENT_SCOPE.AGENCY || scope === RECRUITMENT_SCOPE.NONE) return { id: { in: [] } };
    return attachmentAudience(scope) === "INTERNAL" ? {} : { visibility: "HIRING_TEAM" };
}

/** May this caller upload/remove attachments (as opposed to only reading them)? */
export function canManageRequisitionAttachments(scope) {
    return scope === RECRUITMENT_SCOPE.ORG || scope === RECRUITMENT_SCOPE.MANAGED;
}

export function maskCandidateForScope(candidate, scope) {
    if (!candidate || scope.canSeeInternalNotes) return candidate;
    if (scope.level === RECRUITMENT_SCOPE.AGENCY) return agencyCandidateView(candidate, scope);
    // Copy-then-delete rather than rest-destructuring: the discarded binding in
    // `const { notes, ...rest }` trips no-unused-vars here (only args are exempt).
    const masked = { ...candidate, notes: null, notesRedacted: true };
    return masked;
}

// Phase 5 — what an agency may read of a candidate it introduced: the contact
// details it submitted and the ownership it holds. An allow-list, not a strip
// list, so a column added to Candidate later is not exposed by default (tags,
// parsed resume, privacy and retention state are the recruiter's).
const AGENCY_CANDIDATE_FIELDS = Object.freeze([
    "id", "firstName", "lastName", "email", "phone", "location", "resumeMediaId",
    "ownerAgencyId", "ownershipExpiresAt", "createdAt",
]);
const AGENCY_APPLICATION_FIELDS = Object.freeze([
    "id", "candidateId", "jobRequisitionId", "stage", "status", "appliedAt", "updatedAt",
    "sourceChannel", "ownerAgencyId", "ownershipExpiresAt",
]);

const pick = (row, fields) => {
    const out = {};
    for (const key of fields) if (row[key] !== undefined) out[key] = row[key];
    return out;
};

function agencyCandidateView(candidate, scope) {
    const out = { ...pick(candidate, AGENCY_CANDIDATE_FIELDS), notes: null, notesRedacted: true };
    if (Array.isArray(candidate.applications)) {
        // Only the agency's own applications ride along: the same person may be
        // in process elsewhere through another channel or another agency.
        const agencyId = agencyIdOf(scope);
        out.applications = candidate.applications
            .filter((app) => agencyId && app?.ownerAgencyId === agencyId)
            .map((app) => agencyApplicationView(app, scope, { withCandidate: false }));
    }
    return out;
}

function agencyApplicationView(application, scope, { withCandidate = true } = {}) {
    const out = pick(application, AGENCY_APPLICATION_FIELDS);
    if (application.jobRequisition !== undefined) out.jobRequisition = agencyRequisitionView(application.jobRequisition);
    if (withCandidate && application.candidate !== undefined) {
        out.candidate = application.candidate ? agencyCandidateView(application.candidate, scope) : null;
    }
    return out;
}

/**
 * Phase 5 — field masking for an application row (and what rides on it). Every
 * scope but AGENCY gets the row back untouched; an AGENCY caller gets the
 * allow-listed application fields, the agency projection of the requisition and
 * of the candidate, and never the interviews, offer, score, answers or history.
 */
export function maskApplicationForScope(application, scope) {
    if (!application || scope?.level !== RECRUITMENT_SCOPE.AGENCY) return application;
    return agencyApplicationView(application, scope);
}

/** Same treatment for a page/list of applications. */
export const maskApplicationsForScope = (applications, scope) =>
    !scope || !Array.isArray(applications) ? applications : applications.map((a) => maskApplicationForScope(a, scope));

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
