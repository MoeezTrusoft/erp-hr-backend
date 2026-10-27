// Recruitment Phase 5 — the AGENCY recruitment scope: who the agency user is
// (agency-access.util.js), what the scope resolves to (recruitment-access.util.js),
// that every other scope's predicates are unchanged, the agency field masks and
// the export refusal.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const findAgencyUser = jest.fn();
const findAgency = jest.fn();
const findAssignments = jest.fn();
const seen = [];
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({
    default: {
        recruitmentAgencyUser: { findFirst: (args) => findAgencyUser(args) },
        recruitmentAgency: { findFirst: (args) => findAgency(args) },
        requisitionAgencyAssignment: { findMany: (args) => findAssignments(args) },
    },
}));

const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const requestContextTenant = () => mcpCtx.getStore()?.user?.tenantId ?? null;
const access = await import("../../../src/lib/recruitment-access.util.js");
const util = await import("../../../src/lib/agency-access.util.js");
const {
    AGENCY_MEMBERSHIP, RECRUITMENT_SCOPE, resolveRecruitmentScope, requisitionScopeWhere, candidateScopeWhere,
    applicationScopeWhere, interviewScopeWhere, offerScopeWhere, agencyRequisitionScopeWhere, agencyRequisitionView,
    maskCandidateForScope, maskApplicationForScope, maskApplicationsForScope, requisitionAttachmentScopeWhere,
} = access;
const { withAgencyMembership, withAgencyContext, assertNoAgencyExport, loadAgencyMembership } = util;

const T = "11111111-1111-4111-8111-111111111111";
const previousFlag = process.env.HR_RECRUITMENT_AGENCY_PORTAL;
const membership = (over = {}) => ({ agencyId: 4, tenantId: T, userId: "u-1", requisitionIds: [10, 11], ...over });
const agencyUser = (over = {}) => ({ userId: "u-1", roles: ["AGENCY"], tenantId: T, ...over });
const withMembership = (user, m = membership()) => ({ ...user, [AGENCY_MEMBERSHIP]: m });

beforeEach(() => {
    process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
    jest.clearAllMocks();
    seen.length = 0;
    findAgencyUser.mockImplementation(async (args) => {
        seen.push(requestContextTenant());
        return args.where.userId === "u-1" ? { agencyId: 4 } : null;
    });
    findAgency.mockImplementation(async (args) => (args.where.id === 4 ? { id: 4 } : null));
    findAssignments.mockResolvedValue([{ requisitionId: 10 }, { requisitionId: 11 }, { requisitionId: 10 }]);
});

afterAll(() => {
    if (previousFlag === undefined) delete process.env.HR_RECRUITMENT_AGENCY_PORTAL;
    else process.env.HR_RECRUITMENT_AGENCY_PORTAL = previousFlag;
});

describe("the AGENCY scope", () => {
    it("carries the agency and its assigned requisitions from a valid membership", () => {
        const scope = resolveRecruitmentScope(withMembership(agencyUser()));
        expect(scope).toMatchObject({
            level: RECRUITMENT_SCOPE.AGENCY, agencyId: 4, agencyRequisitionIds: [10, 11],
            unrestricted: false, canSeeInternalNotes: false, canSeeRequisitions: false, canSeeCompensation: false, canSeeCandidates: false,
        });
        expect(candidateScopeWhere(scope)).toEqual({ ownerAgencyId: 4 });
        expect(applicationScopeWhere(scope)).toEqual({ ownerAgencyId: 4 });
        expect(agencyRequisitionScopeWhere(scope)).toEqual({ id: { in: [10, 11] } });
        // The internal requisition row, interviews and offers stay closed.
        expect(requisitionScopeWhere(scope)).toEqual({ id: { in: [] } });
        expect(interviewScopeWhere(scope)).toEqual({ id: { in: [] } });
        expect(offerScopeWhere(scope)).toEqual({ id: { in: [] } });
        expect(requisitionAttachmentScopeWhere(scope.level)).toEqual({ id: { in: [] } });
    });

    it.each([
        ["no membership", agencyUser()],
        ["a null membership", withMembership(agencyUser(), null)],
        ["a membership for another tenant", withMembership(agencyUser(), membership({ tenantId: "22222222-2222-4222-8222-222222222222" }))],
        ["a membership for another user", withMembership(agencyUser(), membership({ userId: "u-2" }))],
        ["a string key instead of the symbol", { ...agencyUser(), agencyMembership: membership() }],
        ["a non-integer agency id", withMembership(agencyUser(), membership({ agencyId: "4" }))],
    ])("reaches no rows with %s", (_label, user) => {
        const scope = resolveRecruitmentScope(user);
        expect(scope.level).toBe(RECRUITMENT_SCOPE.AGENCY);
        expect(scope.agencyId).toBeNull();
        expect(candidateScopeWhere(scope)).toEqual({ id: { in: [] } });
        expect(applicationScopeWhere(scope)).toEqual({ id: { in: [] } });
        expect(agencyRequisitionScopeWhere(scope)).toEqual({ id: { in: [] } });
    });

    it("reaches no rows when the flag is off, even with a valid membership", () => {
        process.env.HR_RECRUITMENT_AGENCY_PORTAL = "false";
        const scope = resolveRecruitmentScope(withMembership(agencyUser()));
        expect(scope.agencyId).toBeNull();
        expect(applicationScopeWhere(scope)).toEqual({ id: { in: [] } });
    });

    it("lets an ORG role win over an AGENCY role, as before", () => {
        const scope = resolveRecruitmentScope(withMembership(agencyUser({ roles: ["AGENCY", "RECRUITER"] })));
        expect(scope.level).toBe(RECRUITMENT_SCOPE.ORG);
        expect(scope.agencyId).toBeUndefined();
    });
});

describe("every other scope is unchanged", () => {
    const EXPECTED = {
        ORG: { scope: { level: "ORG", employeeId: 5, unrestricted: true, canSeeInternalNotes: true, canSeeRequisitions: true, canSeeCompensation: true, canSeeCandidates: true }, req: {}, cand: {}, app: {} },
        MANAGED: {
            scope: { level: "MANAGED", employeeId: 5, unrestricted: false, canSeeInternalNotes: true, canSeeRequisitions: true, canSeeCompensation: false, canSeeCandidates: true },
            req: { OR: [{ requestedById: 5 }, { approvedById: 5 }] },
            cand: { applications: { some: { jobRequisition: { requestedById: 5 } } } },
            app: { jobRequisition: { OR: [{ requestedById: 5 }, { approvedById: 5 }] } },
        },
        ASSIGNED: {
            scope: { level: "ASSIGNED", employeeId: 5, unrestricted: false, canSeeInternalNotes: false, canSeeRequisitions: true, canSeeCompensation: false, canSeeCandidates: true },
            req: { id: { in: [] } },
            cand: { applications: { some: { interviews: { some: { interviewers: { some: { employeeId: 5 } } } } } } },
            app: { interviews: { some: { interviewers: { some: { employeeId: 5 } } } } },
        },
        FINANCE: {
            scope: { level: "FINANCE", employeeId: 5, unrestricted: false, canSeeInternalNotes: false, canSeeRequisitions: false, canSeeCompensation: true, canSeeCandidates: false },
            req: { id: { in: [] } }, cand: { id: { in: [] } }, app: { id: { in: [] } },
        },
        ASSESSMENT: {
            scope: { level: "ASSESSMENT", employeeId: 5, unrestricted: false, canSeeInternalNotes: false, canSeeRequisitions: false, canSeeCompensation: false, canSeeCandidates: false },
            req: { id: { in: [] } }, cand: { id: { in: [] } }, app: { id: { in: [] } },
        },
    };
    const ROLE = { ORG: "HR_ADMIN", MANAGED: "HIRING_MANAGER", ASSIGNED: "INTERVIEWER", FINANCE: "FINANCE", ASSESSMENT: "RECEPTION" };

    it.each(Object.keys(EXPECTED))("%s resolves and predicates exactly as before (a stray membership changes nothing)", (level) => {
        const user = withMembership({ userId: "u-1", roles: [ROLE[level]], employeeId: 5, tenantId: T });
        const scope = resolveRecruitmentScope(user);
        expect(scope).toEqual(EXPECTED[level].scope);
        expect(requisitionScopeWhere(scope)).toEqual(EXPECTED[level].req);
        expect(candidateScopeWhere(scope)).toEqual(EXPECTED[level].cand);
        expect(applicationScopeWhere(scope)).toEqual(EXPECTED[level].app);
        expect(agencyRequisitionScopeWhere(scope)).toEqual({ id: { in: [] } });
        const row = { id: 1, notes: "n", offer: { salary: 1 } };
        expect(maskApplicationForScope(row, scope)).toBe(row);
    });
});

describe("agency field masks", () => {
    // Resolved per test: the flag is switched on in beforeEach.
    let scope;
    beforeEach(() => {
        scope = resolveRecruitmentScope(withMembership(agencyUser()));
    });
    const requisition = { id: 10, title: "Engineer", description: "JD", location: "Lahore", employmentType: "FULL_TIME", closesAt: null, budgetedAmount: 9, gradeLevelId: 3, approvalChainSnapshot: {}, requestedById: 2 };
    const candidate = {
        id: 1, firstName: "Ann", lastName: "A", email: "ann@x.io", phone: null, notes: "internal", tags: [{ id: 1 }], parsedResume: {},
        legalHold: true, ownerAgencyId: 4,
        applications: [
            { id: 7, ownerAgencyId: 4, stage: "applied", dispositionReason: "x", jobRequisition: requisition },
            { id: 8, ownerAgencyId: 9, stage: "interview", jobRequisition: requisition },
            { id: 9, ownerAgencyId: null, stage: "offer", jobRequisition: requisition },
        ],
    };

    it("projects a requisition to the job-ad fields", () => {
        expect(agencyRequisitionView(requisition)).toEqual({ id: 10, title: "Engineer", description: "JD", location: "Lahore", employmentType: "FULL_TIME", closesAt: null });
        expect(agencyRequisitionView(null)).toBeNull();
    });

    it("allow-lists the candidate and keeps only the agency's own applications", () => {
        const out = maskCandidateForScope(candidate, scope);
        expect(out).toMatchObject({ id: 1, firstName: "Ann", email: "ann@x.io", notes: null, notesRedacted: true, ownerAgencyId: 4 });
        for (const key of ["tags", "parsedResume", "legalHold"]) expect(out[key]).toBeUndefined();
        expect(out.applications.map((a) => a.id)).toEqual([7]);
        expect(out.applications[0].dispositionReason).toBeUndefined();
        expect(out.applications[0].jobRequisition.budgetedAmount).toBeUndefined();
    });

    it("strips interviews, offer and the internal requisition from an application", () => {
        const app = { id: 7, candidateId: 1, ownerAgencyId: 4, stage: "applied", status: "open", interviews: [{ notes: "x" }], offer: { salary: 1 }, score: { total: 3 }, candidate, jobRequisition: requisition };
        const out = maskApplicationForScope(app, scope);
        expect(Object.keys(out).sort()).toEqual(["candidate", "candidateId", "id", "jobRequisition", "ownerAgencyId", "stage", "status"]);
        expect(out.jobRequisition).toEqual(agencyRequisitionView(requisition));
        expect(out.candidate.notes).toBeNull();
        expect(maskApplicationsForScope([app], scope)).toEqual([out]);
        expect(maskApplicationsForScope([app], null)).toEqual([app]);
    });
});

describe("withAgencyMembership", () => {
    it("looks the agency user up under the caller's tenant and attaches the membership", async () => {
        const user = await withAgencyMembership(agencyUser());
        expect(user[AGENCY_MEMBERSHIP]).toEqual({ agencyId: 4, tenantId: T, userId: "u-1", requisitionIds: [10, 11] });
        expect(Object.isFrozen(user[AGENCY_MEMBERSHIP])).toBe(true);
        expect(findAgencyUser).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T, userId: "u-1", status: "ACTIVE" } }));
        expect(findAgency).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T, id: 4, status: "ACTIVE" } }));
        expect(seen).toEqual([T]);
        // JSON never carries it.
        expect(JSON.stringify(user)).not.toMatch(/agencyId/);
        expect(resolveRecruitmentScope(user).agencyId).toBe(4);
    });

    it("leaves non-agency callers untouched and does not look anything up", async () => {
        const user = { userId: "u-1", roles: ["RECRUITER"], tenantId: T };
        expect(await withAgencyMembership(user)).toBe(user);
        const ctx = { user, permissions: {} };
        expect(await withAgencyContext(ctx)).toBe(ctx);
        expect(findAgencyUser).not.toHaveBeenCalled();
    });

    it("does not look up twice", async () => {
        const once = await withAgencyMembership(agencyUser());
        expect(await withAgencyMembership(once)).toBe(once);
        expect(findAgencyUser).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["no mapping (or a revoked one)", () => findAgencyUser.mockResolvedValue(null)],
        ["a suspended agency", () => findAgency.mockResolvedValue(null)],
        ["a failing lookup", () => findAgencyUser.mockRejectedValue(new Error("db down"))],
    ])("attaches null for %s", async (_label, arrange) => {
        arrange();
        const user = await withAgencyMembership(agencyUser());
        expect(user[AGENCY_MEMBERSHIP]).toBeNull();
        expect(resolveRecruitmentScope(user).agencyId).toBeNull();
    });

    it("does not touch the database when the flag is off", async () => {
        process.env.HR_RECRUITMENT_AGENCY_PORTAL = "false";
        expect(await loadAgencyMembership({ tenantId: T, userId: "u-1" })).toBeNull();
        expect(findAgencyUser).not.toHaveBeenCalled();
    });
});

describe("assertNoAgencyExport", () => {
    it("refuses an agency caller whatever its membership", () => {
        for (const user of [agencyUser(), withMembership(agencyUser()), { roles: ["EXTERNAL_AGENCY"], tenantId: T }]) {
            expect(() => assertNoAgencyExport(user)).toThrow(expect.objectContaining({ status: 403, code: "HR-RECRUITMENT-AGENCY-EXPORT-FORBIDDEN" }));
        }
    });

    it("lets every other scope through", () => {
        for (const roles of [["HR_ADMIN"], ["HIRING_MANAGER"], ["FINANCE"], ["INTERVIEWER"], []]) {
            expect(() => assertNoAgencyExport({ roles, employeeId: 5, tenantId: T })).not.toThrow();
        }
    });
});
