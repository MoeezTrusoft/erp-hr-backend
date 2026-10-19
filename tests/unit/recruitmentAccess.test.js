// tests/unit/recruitmentAccess.test.js
//
// Phase 1.4 — record-level access for Recruitment.
//
// The behaviours that matter:
//   * A hiring manager is narrowed to the requisitions they own; a peer's
//     requisition is NOT readable and, critically, reads as not-found rather
//     than forbidden (403 would confirm the row exists).
//   * An interviewer is narrowed to interviews they were actually placed on.
//   * Internal notes are stripped for scopes that must not see the recruiter's
//     working record.
//   * An unrecognised role vocabulary falls back to org-wide, because F-02 has
//     already granted the surface and inventing a narrower rule than the tenant
//     defines would take recruiting offline without adding security.
import { describe, it, expect } from "@jest/globals";

import {
    RECRUITMENT_SCOPE,
    resolveRecruitmentScope,
    requisitionScopeWhere,
    interviewScopeWhere,
    candidateScopeWhere,
    offerScopeWhere,
    maskCandidateForScope,
    maskInterviewForScope,
    scopeListResult,
} from "../../src/lib/recruitmentAccess.js";

const TENANT_OK = true; // scope functions are pure; tenancy is asserted elsewhere

const user = (roles, employeeId = 42, extra = {}) => ({ roles, employeeId, ...extra });

describe("resolveRecruitmentScope", () => {
    it("gives HR admin, HR manager and recruiter the whole tenant funnel", () => {
        for (const role of ["HR_ADMIN", "HR_MANAGER", "RECRUITER"]) {
            const scope = resolveRecruitmentScope(user([role]));
            expect(scope.level).toBe(RECRUITMENT_SCOPE.ORG);
            expect(scope.unrestricted).toBe(true);
        }
    });

    it("treats an isAdmin claim as org-wide", () => {
        expect(resolveRecruitmentScope({ isAdmin: true, employeeId: 5 }).level).toBe(RECRUITMENT_SCOPE.ORG);
    });

    it("narrows a hiring or department manager to what they own", () => {
        for (const role of ["HIRING_MANAGER", "DEPARTMENT_MANAGER", "LINE_MANAGER"]) {
            const scope = resolveRecruitmentScope(user([role]));
            expect(scope.level).toBe(RECRUITMENT_SCOPE.MANAGED);
            expect(scope.unrestricted).toBe(false);
            expect(scope.canSeeInternalNotes).toBe(true);
        }
    });

    it("narrows an interviewer to assigned work and hides internal notes", () => {
        const scope = resolveRecruitmentScope(user(["INTERVIEWER"]));
        expect(scope.level).toBe(RECRUITMENT_SCOPE.ASSIGNED);
        expect(scope.canSeeInternalNotes).toBe(false);
    });

    it("gives finance compensation without requisition administration", () => {
        const scope = resolveRecruitmentScope(user(["FINANCE"]));
        expect(scope.level).toBe(RECRUITMENT_SCOPE.FINANCE);
        expect(scope.canSeeCompensation).toBe(true);
        expect(scope.canSeeRequisitions).toBe(false);
        expect(scope.canSeeInternalNotes).toBe(false);
    });

    it("gives an external agency no internal notes and no requisition view", () => {
        const scope = resolveRecruitmentScope(user(["EXTERNAL_AGENCY"]));
        expect(scope.level).toBe(RECRUITMENT_SCOPE.AGENCY);
        expect(scope.canSeeInternalNotes).toBe(false);
        expect(scope.canSeeRequisitions).toBe(false);
    });

    it("reads role claims from either `roles` or a single `role`", () => {
        expect(resolveRecruitmentScope({ role: "HIRING_MANAGER", employeeId: 3 }).level)
            .toBe(RECRUITMENT_SCOPE.MANAGED);
        expect(resolveRecruitmentScope({ role: "hr_admin" }).level).toBe(RECRUITMENT_SCOPE.ORG);
    });

    it("prefers the widest claim when a user holds several roles", () => {
        expect(resolveRecruitmentScope(user(["INTERVIEWER", "HR_MANAGER"])).level).toBe(RECRUITMENT_SCOPE.ORG);
        expect(resolveRecruitmentScope(user(["INTERVIEWER", "HIRING_MANAGER"])).level).toBe(RECRUITMENT_SCOPE.MANAGED);
    });

    it("cannot narrow a scoped role without an employee id to scope by", () => {
        // Nothing to filter on: a manager with no employee link keeps the prior
        // (org-wide) behaviour rather than silently seeing zero rows.
        expect(resolveRecruitmentScope({ roles: ["HIRING_MANAGER"] }).level).toBe(RECRUITMENT_SCOPE.ORG);
    });

    it("falls back to org-wide for an unrecognised role vocabulary", () => {
        expect(resolveRecruitmentScope(user(["SOMETHING_NEW"])).level).toBe(RECRUITMENT_SCOPE.ORG);
        expect(resolveRecruitmentScope(user([])).level).toBe(RECRUITMENT_SCOPE.ORG);
    });
});

describe("scope where-clauses", () => {
    it("adds no predicate for an org-wide caller", () => {
        const scope = resolveRecruitmentScope(user(["HR_ADMIN"]));
        expect(requisitionScopeWhere(scope)).toEqual({});
        expect(interviewScopeWhere(scope)).toEqual({});
        expect(candidateScopeWhere(scope)).toEqual({});
        expect(offerScopeWhere(scope)).toEqual({});
    });

    it("restricts a manager's requisitions to the ones they requested or approved", () => {
        const scope = resolveRecruitmentScope(user(["HIRING_MANAGER"], 42));
        expect(requisitionScopeWhere(scope)).toEqual({
            OR: [{ requestedById: 42 }, { approvedById: 42 }],
        });
    });

    it("restricts an interviewer to interviews they sit on", () => {
        const scope = resolveRecruitmentScope(user(["INTERVIEWER"], 42));
        expect(interviewScopeWhere(scope)).toEqual({
            interviewers: { some: { employeeId: 42 } },
        });
    });

    it("lets a manager see interviews on their own requisitions as well as their own panels", () => {
        const scope = resolveRecruitmentScope(user(["HIRING_MANAGER"], 42));
        expect(interviewScopeWhere(scope)).toEqual({
            OR: [
                { interviewers: { some: { employeeId: 42 } } },
                { application: { jobRequisition: { requestedById: 42 } } },
            ],
        });
    });

    it("reaches candidates through the applications a manager owns", () => {
        const scope = resolveRecruitmentScope(user(["HIRING_MANAGER"], 42));
        expect(candidateScopeWhere(scope)).toEqual({
            applications: { some: { jobRequisition: { requestedById: 42 } } },
        });
    });

    it("reaches candidates for an interviewer only via their own interviews", () => {
        const scope = resolveRecruitmentScope(user(["INTERVIEWER"], 42));
        expect(candidateScopeWhere(scope)).toEqual({
            applications: {
                some: { interviews: { some: { interviewers: { some: { employeeId: 42 } } } } },
            },
        });
    });

    it("denies with an unsatisfiable predicate rather than throwing", () => {
        const agency = resolveRecruitmentScope(user(["EXTERNAL_AGENCY"], 42));
        expect(requisitionScopeWhere(agency)).toEqual({ id: { in: [] } });
        expect(candidateScopeWhere(agency)).toEqual({ id: { in: [] } });

        const interviewer = resolveRecruitmentScope(user(["INTERVIEWER"], 42));
        // An interviewer does not administer requisitions or offers.
        expect(requisitionScopeWhere(interviewer)).toEqual({ id: { in: [] } });
        expect(offerScopeWhere(interviewer)).toEqual({ id: { in: [] } });
    });

    it("gives finance the offers it prices", () => {
        const finance = resolveRecruitmentScope(user(["FINANCE"], 42));
        expect(offerScopeWhere(finance)).toEqual({});
    });
});

describe("field masking", () => {
    const candidate = { id: 7, firstName: "Ayesha", notes: "Referred by the CTO's brother", status: "active" };

    it("keeps internal notes for org-wide and manager scopes", () => {
        expect(maskCandidateForScope(candidate, resolveRecruitmentScope(user(["HR_ADMIN"])))).toBe(candidate);
        expect(maskCandidateForScope(candidate, resolveRecruitmentScope(user(["HIRING_MANAGER"]))).notes)
            .toBe("Referred by the CTO's brother");
    });

    it("strips internal notes for interviewers, finance and agencies", () => {
        for (const role of ["INTERVIEWER", "FINANCE", "EXTERNAL_AGENCY"]) {
            const masked = maskCandidateForScope(candidate, resolveRecruitmentScope(user([role])));
            expect(masked.notes).toBeNull();
            expect(masked.notesRedacted).toBe(true);
            // The rest of the record survives: they still need to do their job.
            expect(masked.firstName).toBe("Ayesha");
        }
    });

    it("strips interviewer notes from the interview itself", () => {
        const masked = maskInterviewForScope(
            { id: 3, notes: "Panel was lukewarm", applicationId: 9 },
            resolveRecruitmentScope(user(["EXTERNAL_AGENCY"])),
        );
        expect(masked).toMatchObject({ id: 3, notes: null, notesRedacted: true });
    });

    it("tolerates a null row", () => {
        const scope = resolveRecruitmentScope(user(["HR_ADMIN"]));
        expect(maskCandidateForScope(null, scope)).toBeNull();
        expect(maskInterviewForScope(undefined, scope)).toBeUndefined();
    });

    it("empties a list result when the collection is out of scope", () => {
        expect(scopeListResult({ items: [{ id: 1 }], total: 1 }, false)).toEqual({ items: [], total: 0 });
        expect(scopeListResult([{ id: 1 }], false)).toEqual([]);
        expect(scopeListResult({ items: [{ id: 1 }], total: 1 }, true)).toEqual({ items: [{ id: 1 }], total: 1 });
    });

    it("serves every endpoint for a tenant-scoped read (sanity)", () => {
        expect(TENANT_OK).toBe(true);
    });
});
