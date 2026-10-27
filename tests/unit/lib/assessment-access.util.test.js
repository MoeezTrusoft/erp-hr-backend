// tests/unit/lib/assessment-access.util.test.js
//
// Phase 3b — the assessment-only roles get no recruitment rows (they must never
// fall through to the unknown-role ORG default), and capabilities follow the
// role claims.
import { describe, it, expect } from "@jest/globals";

import { RECRUITMENT_SCOPE, resolveRecruitmentScope, applicationScopeWhere, candidateScopeWhere, offerScopeWhere } from "../../../src/lib/recruitment-access.util.js";
import { assertAssessmentCapability, resolveAssessmentAccess } from "../../../src/lib/assessment-access.util.js";

const NONE = { id: { in: [] } };

describe("assessment-only roles in the recruitment scope", () => {
    it.each(["RECEPTION", "RECEPTIONIST", "ASSESSMENT_AUTHOR", "ASSESSMENT_REVIEWER"])(
        "%s reads no recruitment rows, candidates, requisitions or pay",
        (role) => {
            const scope = resolveRecruitmentScope({ roles: [role], employeeId: 9 });
            expect(scope.level).toBe(RECRUITMENT_SCOPE.ASSESSMENT);
            expect(scope.unrestricted).toBe(false);
            expect(scope).toMatchObject({
                canSeeCandidates: false,
                canSeeRequisitions: false,
                canSeeCompensation: false,
                canSeeInternalNotes: false,
            });
            expect(applicationScopeWhere(scope)).toEqual(NONE);
            expect(candidateScopeWhere(scope)).toEqual(NONE);
            expect(offerScopeWhere(scope)).toEqual(NONE);
        },
    );

    it("a recognised recruitment role still wins over an assessment role", () => {
        expect(resolveRecruitmentScope({ roles: ["RECRUITER", "RECEPTION"] }).level).toBe(RECRUITMENT_SCOPE.ORG);
        expect(resolveRecruitmentScope({ roles: ["HIRING_MANAGER", "ASSESSMENT_REVIEWER"], employeeId: 4 }).level)
            .toBe(RECRUITMENT_SCOPE.MANAGED);
    });

    it("an unknown role sees no recruitment rows (Phase 6)", () => {
        expect(resolveRecruitmentScope({ roles: ["SOMETHING_NEW"] }).level).toBe(RECRUITMENT_SCOPE.NONE);
    });
});

describe("resolveAssessmentAccess", () => {
    it("gives reception check-in only", () => {
        const access = resolveAssessmentAccess({ roles: ["RECEPTION"], employeeId: 5 });
        expect(access).toMatchObject({ reception: true, author: false, reviewer: false, recruiter: false, admin: false });
    });

    it("separates authors and reviewers; recruiters may do both", () => {
        expect(resolveAssessmentAccess({ roles: ["ASSESSMENT_AUTHOR"] })).toMatchObject({ author: true, reviewer: false });
        expect(resolveAssessmentAccess({ roles: ["ASSESSMENT_REVIEWER"] })).toMatchObject({ author: false, reviewer: true });
        expect(resolveAssessmentAccess({ roles: ["RECRUITER"] })).toMatchObject({ author: true, reviewer: true, reception: true, recruiter: true });
    });

    it("marks admins, managers and interviewers", () => {
        expect(resolveAssessmentAccess({ roles: ["HR_ADMIN"] }).admin).toBe(true);
        expect(resolveAssessmentAccess({ isAdmin: true }).admin).toBe(true);
        expect(resolveAssessmentAccess({ roles: ["HIRING_MANAGER"], employeeId: 3 }).manager).toBe(true);
        expect(resolveAssessmentAccess({ roles: ["INTERVIEWER"], employeeId: 3 }).interviewer).toBe(true);
    });

    it("assertAssessmentCapability refuses with 403", () => {
        const access = resolveAssessmentAccess({ roles: ["RECEPTION"] });
        expect(() => assertAssessmentCapability(access, "reviewer")).toThrow(
            expect.objectContaining({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" }),
        );
        expect(() => assertAssessmentCapability(access, "reception")).not.toThrow();
    });
});
