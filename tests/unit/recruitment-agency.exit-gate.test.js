// Recruitment Phase 5 exit gate (plan 6.2): an agency user sees only the rows
// assigned to their agency.
//
// Two agencies, three requisitions in one tenant (plus a second tenant, a
// revoked login and a suspended agency). The agencies submit through the portal
// tools, a recruiter reviews through the HR tools (the real createCandidate and
// createApplication paths, against an in-memory Prisma), and then every
// agency-visible read is checked for each agency user: the portal tools, and
// the existing scoped recruitment reads (hr_application_list,
// hr_application_get, and the candidate list/detail services behind
// hr_candidates_list). The agency membership is attached the way the MCP router
// hook does it (withAgencyContext), so this is the path production takes.
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { makeAgencyDb } from "./services/helpers/agency.fake.js";

const fake = makeAgencyDb();
const events = [];

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: fake.db, prisma: fake.db }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: async () => undefined }));
jest.unstable_mockModule("../../src/services/tagService.js", () => ({ upsertTags: async () => [] }));
jest.unstable_mockModule("../../src/services/candidatePrivacy.service.js", () => ({
    computeRetentionUntil: async () => null,
    findActiveDnc: async () => null,
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: async (_tx, event) => {
        if (event) events.push(event);
        return event;
    },
}));

const { mcpCtx } = await import("../../src/mcp/context.js");
const { withAgencyContext } = await import("../../src/lib/agency-access.util.js");
const { resolveRecruitmentScope } = await import("../../src/lib/recruitmentAccess.js");
const { registerAgencyPortalTools } = await import("../../src/mcp/tools/agency-portal.tools.js");
const { registerRecruitmentAgencyTools } = await import("../../src/mcp/tools/recruitment-agency.tools.js");
const { registerApplicationTools } = await import("../../src/mcp/tools/applicationTools.js");
const { listCandidates, getCandidate } = await import("../../src/services/candidateService.js");

const handlers = new Map();
const server = { tool: (name, _d, _s, handler) => handlers.set(name, handler) };
registerAgencyPortalTools(server);
registerRecruitmentAgencyTools(server);
registerApplicationTools(server);

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const RECRUITER = { userId: "r-1", roles: ["RECRUITER"], employeeId: 7, tenantId: T };
const HR_PERMS = { "hr:recruitment": ["VIEW", "CREATE", "EDIT", "DELETE"] };
// Agency logins hold the portal grant and, for this test, the hr:recruitment
// read grant too, so the existing scoped reads are reachable and their row
// scope is what is under test.
const AGENCY_PERMS = { "hr:recruitment_agency": ["VIEW", "CREATE"], "hr:recruitment": ["VIEW"] };
const agencyUser = (userId, tenantId = T) => ({ userId, roles: ["AGENCY"], employeeId: null, tenantId });

const parse = (res) => JSON.parse(res.content[0].text);
async function call(name, args, user, permissions) {
    const ctx = await withAgencyContext({ user, permissions });
    return parse(await mcpCtx.run(ctx, () => handlers.get(name)(args)));
}
const asRecruiter = (name, args) => call(name, args, RECRUITER, HR_PERMS);
const asAgency = (user, name, args = {}) => call(name, args, user, AGENCY_PERMS);
const inCtx = async (user, fn) => {
    const ctx = await withAgencyContext({ user, permissions: AGENCY_PERMS });
    return mcpCtx.run(ctx, () => fn(ctx.user));
};

const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const W = {};
const previousFlag = process.env.HR_RECRUITMENT_AGENCY_PORTAL;

beforeAll(async () => {
    process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
    const req = (title, extra = {}) => fake.seed("jobRequisition", {
        tenantId: T, title, status: "APPROVED", description: `${title} JD`, location: "Lahore", employmentType: "FULL_TIME",
        requestedById: 3, recruiterId: 7, budgetedAmount: 900000, budgetCurrency: "PKR", gradeLevelId: 4,
        approvalChainSnapshot: { steps: ["CFO"] }, costCenterRef: "CC-1", ...extra,
    });
    W.r1 = req("Backend Engineer");
    W.r2 = req("Designer");
    W.r3 = req("Data Analyst");
    W.foreignReq = fake.seed("jobRequisition", { tenantId: T2, title: "Other tenant", status: "APPROVED", requestedById: 1 });

    // A direct (non-agency) applicant on R1 that neither agency may see.
    W.eve = fake.seed("candidate", { tenantId: T, firstName: "Eve", lastName: "Direct", email: "eve@example.com", notes: "internal" });
    W.eveApp = fake.seed("application", { tenantId: T, candidateId: W.eve.id, jobRequisitionId: W.r1.id, sourceChannel: "CAREER_SITE" });

    // HR side: two agencies, their logins and assignments (A1: R1+R3, A2: R2+R3).
    W.a1 = (await asRecruiter("hr_recruitment_agency_create", { name: "Alpha Talent", ownershipDays: 90 })).data;
    W.a2 = (await asRecruiter("hr_recruitment_agency_create", { name: "Beta Search", ownershipDays: 90 })).data;
    W.a4 = (await asRecruiter("hr_recruitment_agency_create", { name: "Suspended Co" })).data;
    for (const [agency, userId] of [[W.a1, "u-a1"], [W.a2, "u-a2"], [W.a1, "u-revoked"], [W.a4, "u-a4"]]) {
        await asRecruiter("hr_recruitment_agency_user_add", { agencyId: agency.id, userId });
    }
    for (const [agency, requisition] of [[W.a1, W.r1], [W.a1, W.r3], [W.a2, W.r2], [W.a2, W.r3], [W.a2, W.r1], [W.a4, W.r1]]) {
        const out = await asRecruiter("hr_requisition_agency_assign", { requisitionId: requisition.id, agencyId: agency.id });
        expect(out.success).toBe(true);
    }
    // A2's R1 assignment ends; the revoked login and the suspended agency see nothing.
    await asRecruiter("hr_requisition_agency_unassign", { requisitionId: W.r1.id, agencyId: W.a2.id });
    const revoked = fake.all("recruitmentAgencyUser").find((u) => u.userId === "u-revoked");
    await asRecruiter("hr_recruitment_agency_user_revoke", { id: revoked.id });
    await asRecruiter("hr_recruitment_agency_update", { id: W.a4.id, expectedVersion: 0, status: "SUSPENDED" });
    // A login with the same user id in another tenant, mapped there to its own agency.
    W.foreignAgency = fake.seed("recruitmentAgency", { tenantId: T2, name: "Gamma", status: "ACTIVE" });
    fake.seed("recruitmentAgencyUser", { tenantId: T2, agencyId: W.foreignAgency.id, userId: "u-a1", status: "ACTIVE" });
    fake.seed("requisitionAgencyAssignment", { tenantId: T2, agencyId: W.foreignAgency.id, requisitionId: W.foreignReq.id, status: "ACTIVE" });

    // Agency side: submissions.
    W.u1 = agencyUser("u-a1");
    W.u2 = agencyUser("u-a2");
    const submit = async (user, requisition, firstName) => {
        const out = await asAgency(user, "hr_recruitment_agency_portal_submit", {
            requisitionId: requisition.id, firstName, lastName: "Agency", email: `${firstName.toLowerCase()}@example.com`, note: "Strong fit",
        });
        expect(out.success).toBe(true);
        return out.data;
    };
    W.annSub = await submit(W.u1, W.r1, "Ann");
    W.bobSub = await submit(W.u1, W.r3, "Bob");
    W.catSub = await submit(W.u2, W.r2, "Cat");
    W.danSub = await submit(W.u2, W.r3, "Dan");
    W.ann2Sub = await submit(W.u2, W.r3, "Ann"); // A1 will own Ann first: a DUPLICATE
    W.pendingSub = await submit(W.u1, W.r3, "Pia"); // stays pending

    // Recruiter reviews.
    const review = async (sub, decision, reason) =>
        (await asRecruiter("hr_recruitment_agency_submission_review", { id: sub.id, decision, reason })).data;
    W.annReview = await review(W.annSub, "ACCEPT");
    W.bobReview = await review(W.bobSub, "ACCEPT");
    W.catReview = await review(W.catSub, "ACCEPT");
    W.danReview = await review(W.danSub, "ACCEPT");
    W.ann2Review = await review(W.ann2Sub, "ACCEPT");
});

afterAll(() => {
    if (previousFlag === undefined) delete process.env.HR_RECRUITMENT_AGENCY_PORTAL;
    else process.env.HR_RECRUITMENT_AGENCY_PORTAL = previousFlag;
});

describe("setup through the HR and portal tools", () => {
    it("accepted four submissions with the agency's ownership and recorded the duplicate", () => {
        expect([W.annReview, W.bobReview, W.catReview, W.danReview].map((r) => r.outcome)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
        expect(W.ann2Review.outcome).toBe("DUPLICATE");
        expect(W.ann2Review.reason).toMatch(new RegExp(`owned by agency ${W.a1.id}`));
        const apps = fake.all("application").filter((a) => a.sourceChannel === "AGENCY");
        expect(apps).toHaveLength(4);
        const ann = fake.all("candidate").find((c) => c.email === "ann@example.com");
        expect(ann.ownerAgencyId).toBe(W.a1.id);
        // One received event per submission, routed to the requisition's recruiter, ids only.
        const received = events.filter((e) => e.eventName === "hr.recruitment.agency_submission_received.v1");
        expect(received).toHaveLength(6);
        expect(received[0].payload).toEqual({
            submissionId: String(W.annSub.id), agencyId: String(W.a1.id), requisitionId: String(W.r1.id), recruiterId: "7", requestedById: "3",
        });
    });
});

const appOf = (review) => review.applicationId;
const candOf = (review) => review.candidateId;

describe.each([
    ["agency 1", () => ({
        user: W.u1, agency: W.a1, requisitions: [W.r1, W.r3], others: [W.r2],
        submissions: [W.annSub, W.bobSub, W.pendingSub], apps: [appOf(W.annReview), appOf(W.bobReview)],
        foreignApps: [appOf(W.catReview), appOf(W.danReview), W.eveApp.id],
        candidates: [candOf(W.annReview), candOf(W.bobReview)],
        foreignCandidates: [candOf(W.catReview), candOf(W.danReview), W.eve.id],
    })],
    ["agency 2", () => ({
        user: W.u2, agency: W.a2, requisitions: [W.r2, W.r3], others: [W.r1],
        submissions: [W.catSub, W.danSub, W.ann2Sub], apps: [appOf(W.catReview), appOf(W.danReview)],
        foreignApps: [appOf(W.annReview), appOf(W.bobReview), W.eveApp.id],
        candidates: [candOf(W.catReview), candOf(W.danReview)],
        foreignCandidates: [candOf(W.annReview), candOf(W.bobReview), W.eve.id],
    })],
])("%s sees only its own rows", (_label, world) => {
    it("resolves the scope to its agency and its active assignments", async () => {
        const w = world();
        const scope = await inCtx(w.user, async (user) => resolveRecruitmentScope(user));
        expect(scope).toMatchObject({ level: "AGENCY", agencyId: w.agency.id, canSeeCandidates: false, canSeeRequisitions: false });
        expect([...scope.agencyRequisitionIds].sort((a, b) => a - b)).toEqual(ids(w.requisitions));
    });

    it("portal requisitions: only its assigned open requisitions, as the agency projection", async () => {
        const w = world();
        const page = await asAgency(w.user, "hr_recruitment_agency_portal_requisitions_list");
        expect(ids(page.items)).toEqual(ids(w.requisitions));
        for (const item of page.items) {
            expect(Object.keys(item).sort()).toEqual(
                ["closesAt", "description", "employmentType", "id", "location", "maxSubmissions", "submittedCount", "title"],
            );
        }
        const own = await asAgency(w.user, "hr_recruitment_agency_portal_requisition_get", { requisitionId: w.requisitions[0].id });
        expect(own.data.id).toBe(w.requisitions[0].id);
        expect(own.data.budgetedAmount).toBeUndefined();
        for (const other of [...w.others, W.foreignReq]) {
            const denied = await asAgency(w.user, "hr_recruitment_agency_portal_requisition_get", { requisitionId: other.id });
            expect(denied.status).toBe(404);
        }
    });

    it("portal submissions: only its own, duplicates reading as a neutral rejection", async () => {
        const w = world();
        const page = await asAgency(w.user, "hr_recruitment_agency_portal_submissions_list");
        expect(ids(page.items)).toEqual(ids(w.submissions));
        const text = JSON.stringify(page.items);
        expect(text).not.toMatch(/DUPLICATE|owned by agency|in process/);
    });

    it("hr_application_list (existing, scoped): only the applications its agency owns", async () => {
        const w = world();
        const page = await asAgency(w.user, "hr_application_list", { limit: 100 });
        expect(ids(page.items)).toEqual([...w.apps].sort((a, b) => a - b));
        expect(page.total).toBe(w.apps.length);
        for (const item of page.items) {
            expect(item.ownerAgencyId).toBe(w.agency.id);
            // The candidate on each row is the agency projection (no notes, no tags).
            expect(item.candidate.notesRedacted).toBe(true);
            expect(item.candidate.tags).toBeUndefined();
        }
    });

    it("hr_application_get (existing, scoped): its own reads, everyone else's are not found", async () => {
        const w = world();
        const own = await asAgency(w.user, "hr_application_get", { id: w.apps[0] });
        expect(own.id).toBe(w.apps[0]);
        for (const other of w.foreignApps) {
            const denied = await asAgency(w.user, "hr_application_get", { id: other });
            expect(denied.status).toBe(404);
        }
    });

    it("candidate list and detail (behind hr_candidates_list): only the candidates its agency owns", async () => {
        const w = world();
        const page = await inCtx(w.user, async (user) =>
            await listCandidates({ tenantId: T, scope: resolveRecruitmentScope(user), limit: 100 }));
        expect(ids(page.items)).toEqual([...w.candidates].sort((a, b) => a - b));
        const detail = await inCtx(w.user, async (user) =>
            await getCandidate({ id: w.candidates[0], tenantId: T, scope: resolveRecruitmentScope(user) }));
        expect(detail.id).toBe(w.candidates[0]);
        expect(detail.applications.every((a) => a.ownerAgencyId === w.agency.id)).toBe(true);
        expect(detail.applications.every((a) => a.jobRequisition.budgetedAmount === undefined)).toBe(true);
        for (const other of w.foreignCandidates) {
            const none = await inCtx(w.user, async (user) =>
                await getCandidate({ id: other, tenantId: T, scope: resolveRecruitmentScope(user) }));
            expect(none).toBeNull();
        }
    });

    it("is refused by every HR-side agency tool", async () => {
        const w = world();
        for (const [name, args] of [
            ["hr_recruitment_agencies_list", {}],
            ["hr_recruitment_agency_get", { id: w.agency.id }],
            ["hr_recruitment_agency_submissions_list", {}],
            ["hr_recruitment_agency_users_list", {}],
        ]) {
            const res = await call(name, args, w.user, { ...AGENCY_PERMS, "hr:recruitment": ["VIEW", "CREATE", "EDIT"] });
            expect(res.status).toBe(403);
        }
    });
});

describe("callers with no live agency mapping see nothing", () => {
    const callers = [
        ["a revoked login", () => agencyUser("u-revoked")],
        ["a login of a suspended agency", () => agencyUser("u-a4")],
        ["an AGENCY-role user with no mapping", () => agencyUser("u-nobody")],
        ["the same user id in another tenant (reads that tenant's agency only)", () => agencyUser("u-a1", T2)],
    ];

    it.each(callers.slice(0, 3))("%s", async (_label, make) => {
        const user = make();
        const reqs = await asAgency(user, "hr_recruitment_agency_portal_requisitions_list");
        expect(reqs.items).toEqual([]);
        const subs = await asAgency(user, "hr_recruitment_agency_portal_submissions_list");
        expect(subs.items).toEqual([]);
        const apps = await asAgency(user, "hr_application_list", { limit: 100 });
        expect(apps.items).toEqual([]);
        const submit = await asAgency(user, "hr_recruitment_agency_portal_submit", {
            requisitionId: W.r1.id, firstName: "Zed", lastName: "Z", email: "zed@example.com", note: "x",
        });
        expect(submit.status).toBe(404);
    });

    it("keeps tenants apart", async () => {
        const user = callers[3][1]();
        const reqs = await asAgency(user, "hr_recruitment_agency_portal_requisitions_list");
        expect(ids(reqs.items)).toEqual([W.foreignReq.id]);
        const apps = await asAgency(user, "hr_application_list", { limit: 100 });
        expect(apps.items).toEqual([]);
    });

    it("everything is empty or off once the flag is switched off", async () => {
        process.env.HR_RECRUITMENT_AGENCY_PORTAL = "false";
        try {
            const reqs = await asAgency(W.u1, "hr_recruitment_agency_portal_requisitions_list");
            expect(reqs.status).toBe(503);
            expect(reqs.code).toBe("HR-5031");
            const apps = await asAgency(W.u1, "hr_application_list", { limit: 100 });
            expect(apps.items).toEqual([]);
        } finally {
            process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
        }
    });
});

describe("the recruiter still sees the whole funnel", () => {
    it("lists every application in the tenant", async () => {
        const page = await asRecruiter("hr_application_list", { limit: 100 });
        expect(page.items).toHaveLength(5);
    });
});
