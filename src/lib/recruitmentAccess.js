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
//  1. UNKNOWN ROLES receive no rows. Resource grants and row scope are independent.
//  2. Out-of-scope reads return NOT FOUND (404 / empty), never 403. Telling a
//     hiring manager "forbidden" on an id they guessed confirms the row exists.
//
// Pure functions only — no DB, no I/O — so the whole matrix is unit-testable.

export const RECRUITMENT_SCOPE = Object.freeze({
  NONE: "NONE",
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
  "HR_HEAD",
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

const ROLE_ALIASES = Object.freeze({
  HRADMIN: "HR_ADMIN",
  HRMANAGER: "HR_MANAGER",
  HRHEAD: "HR_HEAD",
  HIRINGMANAGER: "HIRING_MANAGER",
  DEPARTMENTMANAGER: "DEPARTMENT_MANAGER",
  LINEMANAGER: "LINE_MANAGER",
  FINANCEMANAGER: "FINANCE_MANAGER",
  FINANCEADMIN: "FINANCE_ADMIN",
  EXTERNALAGENCY: "EXTERNAL_AGENCY",
});
const normalizeRole = (role) => {
  const value = String(role ?? "")
    .trim()
    .replace(/[ -]/g, "_")
    .toUpperCase();
  return ROLE_ALIASES[value] ?? value;
};

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

  // External agency membership is a restrictive boundary even with mixed role claims.
  const level = hasAny(roles, AGENCY_ROLES)
    ? RECRUITMENT_SCOPE.AGENCY
    : hasAny(roles, ORG_ROLES)
      ? RECRUITMENT_SCOPE.ORG
      : hasAny(roles, FINANCE_ROLES)
        ? RECRUITMENT_SCOPE.FINANCE
        : hasAny(roles, MANAGED_ROLES) && employeeId
          ? RECRUITMENT_SCOPE.MANAGED
          : hasAny(roles, ASSIGNED_ROLES) && employeeId
            ? RECRUITMENT_SCOPE.ASSIGNED
            : RECRUITMENT_SCOPE.NONE;

  const unrestricted = level === RECRUITMENT_SCOPE.ORG;

  return {
    level,
    employeeId,
    unrestricted,
    canSeeInternalNotes: level === RECRUITMENT_SCOPE.ORG,
    canSeeRequisitions: [RECRUITMENT_SCOPE.ORG, RECRUITMENT_SCOPE.MANAGED].includes(level),
    canSeeCompensation: level === RECRUITMENT_SCOPE.ORG || level === RECRUITMENT_SCOPE.FINANCE,
    canSeeCandidates: [
      RECRUITMENT_SCOPE.ORG,
      RECRUITMENT_SCOPE.MANAGED,
      RECRUITMENT_SCOPE.ASSIGNED,
    ].includes(level),
  };
}

// A predicate that can never match, used instead of throwing: a list endpoint
// returns an empty page and a detail endpoint returns not-found.
const MATCH_NONE = Object.freeze({ id: { in: [] } });
const ownedRequisitionWhere = (employeeId) => ({
  OR: [{ requestedById: employeeId }, { approvedById: employeeId }, { recruiterId: employeeId }],
});

/**
 * Where-clause fragment restricting requisitions to the caller's scope.
 * Compose it into the existing tenant-scoped predicate: `{ ...scoped, ...where }`.
 */
export function requisitionScopeWhere(scope) {
  if (scope.unrestricted) return {};
  if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
    return ownedRequisitionWhere(scope.employeeId);
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
        {
          application: {
            jobRequisition: ownedRequisitionWhere(scope.employeeId),
          },
        },
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
    return {
      applications: {
        some: { jobRequisition: ownedRequisitionWhere(scope.employeeId) },
      },
    };
  }
  if (scope.level === RECRUITMENT_SCOPE.ASSIGNED && scope.employeeId) {
    return {
      applications: {
        some: {
          interviews: {
            some: { interviewers: { some: { employeeId: scope.employeeId } } },
          },
        },
      },
    };
  }
  return { ...MATCH_NONE };
}

/**
 * Where-clause fragment restricting applications to the caller's scope.
 *
 * The application is the join that grants a manager or an interviewer their view,
 * so the rule mirrors candidateScopeWhere: MANAGED reaches applications on the
 * requisitions they own, ASSIGNED reaches the applications they sit on a panel for.
 * FINANCE and AGENCY reach none — a pricing reviewer has no business reading
 * candidate submissions, and the agency portal exposes only owned submission receipts through its separate
 * service, never this general application projection.
 */
export function applicationScopeWhere(scope) {
  if (scope.unrestricted) return {};
  if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
    return {
      jobRequisition: ownedRequisitionWhere(scope.employeeId),
    };
  }
  if (scope.level === RECRUITMENT_SCOPE.ASSIGNED && scope.employeeId) {
    return {
      interviews: {
        some: { interviewers: { some: { employeeId: scope.employeeId } } },
      },
    };
  }
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
  if (!offer) return offer;
  if (!scope?.canSeeInternalNotes)
    offer = {
      ...offer,
      notes: null,
      notesRedacted: true,
      ...(offer.candidate ? { candidate: maskCandidateForScope(offer.candidate, scope) } : {}),
    };
  if (scope?.canSeeCompensation) return offer;
  return {
    ...offer,
    salary: null,
    currency: null,
    compensation: null,
    offerLetterMediaId: null,
    terms: null,
    approvals: null,
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
    return {
      application: { jobRequisition: ownedRequisitionWhere(scope.employeeId) },
    };
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
  if (scope === RECRUITMENT_SCOPE.AGENCY) return { id: { in: [] } }; // no requisition view at all
  return attachmentAudience(scope) === "INTERNAL" ? {} : { visibility: "HIRING_TEAM" };
}

/** May this caller upload/remove attachments (as opposed to only reading them)? */
export function canManageRequisitionAttachments(scope) {
  return scope === RECRUITMENT_SCOPE.ORG || scope === RECRUITMENT_SCOPE.MANAGED;
}

export function maskCandidateForScope(candidate, scope) {
  if (!candidate || scope?.canSeeInternalNotes) return candidate;
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
  interview = hidePeerFeedback(interview, scope);
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
  !scope || !Array.isArray(candidates)
    ? candidates
    : candidates.map((c) => maskCandidateForScope(c, scope));

export const maskInterviewsForScope = (interviews, scope) =>
  !scope || !Array.isArray(interviews)
    ? interviews
    : interviews.map((i) => maskInterviewForScope(i, scope));

/**
 * Scope a list result: `{ items, total }` (or a bare array) becomes an empty page
 * when the caller may not see the collection at all.
 */
export function scopeListResult(result, allowed) {
  if (allowed) return result;
  if (Array.isArray(result)) return [];
  return { ...result, items: [], total: 0 };
}

export function hidePeerFeedback(interview, scope) {
  if (!interview || !scope?.employeeId) return interview;
  const assigned = (interview.interviewers || []).some(
    (p) => (p.employeeId ?? p.employee?.id) === scope.employeeId,
  );
  const own = (interview.scorecards || []).find((c) => c.reviewerId === scope.employeeId);
  if (!assigned || own?.submittedAt) return interview;
  return { ...interview, scorecards: own ? [own] : [], peersHidden: true };
}
