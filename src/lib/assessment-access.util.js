// src/lib/assessment-access.util.js
//
// Phase 3b — who may do what on the interview-day assessment.
//
// Every assessment tool still requires the `hr:recruitment` grant (the only
// seeded resource: CLAUDE.md, "check RBAC permissions exist before
// registering tools"). Inside that grant, this module turns the caller's role
// claims into capabilities, so a receptionist can check a candidate in without
// ever seeing an item, a key or a score, and an author can never publish their
// own item. Recruitment row scope (recruitmentAccess.js) still decides which
// candidates and requisitions a caller may reach.
//
// When the RBAC repository seeds hr.recruitment.assessment and
// hr.recruitment.reception (plan section 7.9), the tools add those grants on
// top; the capabilities here stay the second, role-level check.
//
// Pure functions only.
import { RECRUITMENT_SCOPE, resolveRecruitmentScope, rolesOf } from "./recruitmentAccess.js";

const AUTHOR_ROLES = Object.freeze(["ASSESSMENT_AUTHOR"]);
const REVIEWER_ROLES = Object.freeze(["ASSESSMENT_REVIEWER"]);
const RECEPTION_ROLES = Object.freeze(["RECEPTION", "RECEPTIONIST"]);
const ADMIN_ROLES = Object.freeze(["HR_ADMIN", "RBAC_ADMIN"]);

const hasAny = (roles, candidates) => candidates.some((role) => roles.includes(role));

/**
 * @param {object} user - verified actor ({ roles|role, employeeId, isAdmin })
 * @returns {{
 *   scope: object, employeeId: number|null,
 *   author: boolean, reviewer: boolean, reception: boolean, admin: boolean,
 *   recruiter: boolean, manager: boolean, interviewer: boolean,
 * }}
 */
export function resolveAssessmentAccess(user) {
    const roles = rolesOf(user);
    const scope = resolveRecruitmentScope(user);
    const recruiter = scope.level === RECRUITMENT_SCOPE.ORG;
    const admin = user?.isAdmin === true || hasAny(roles, ADMIN_ROLES);
    return {
        scope,
        employeeId: scope.employeeId,
        // Recruiters (ORG) author and review too; four eyes is enforced per
        // person, not per role (the reviewer is never the item's author).
        author: recruiter || hasAny(roles, AUTHOR_ROLES),
        reviewer: recruiter || hasAny(roles, REVIEWER_ROLES),
        reception: recruiter || hasAny(roles, RECEPTION_ROLES),
        admin,
        recruiter,
        manager: scope.level === RECRUITMENT_SCOPE.MANAGED,
        interviewer: scope.level === RECRUITMENT_SCOPE.ASSIGNED,
    };
}

/** Throw a 403 unless the capability holds. */
export function assertAssessmentCapability(access, capability, message = "You are not allowed to do this") {
    if (!access?.[capability]) {
        throw Object.assign(new Error(message), { status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });
    }
}
