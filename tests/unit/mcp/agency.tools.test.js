// Recruitment Phase 5 — the agency tool registrars: names, the grant each
// checks, ORG-only HR administration, the AGENCY-only portal, the flag, and
// that the actor and tenant come from the verified context.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const fn = () => jest.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }));
const adminSvc = {
    addAgencyUser: fn(), assignRequisitionToAgency: fn(), createAgency: fn(), getAgency: fn(), listAgencies: fn(),
    listAgencyUsers: fn(), revokeAgencyUser: fn(), unassignRequisitionFromAgency: fn(), updateAgency: fn(),
};
const subSvc = {
    listAgencySubmissions: fn(), reviewAgencySubmission: fn(), getAgencyRequisition: fn(), listAgencyRequisitions: fn(),
    listOwnAgencySubmissions: fn(), submitAgencyCandidate: fn(),
};
const flag = { on: true };
jest.unstable_mockModule("../../../src/services/recruitment-agency.service.js", () => ({
    ...adminSvc,
    assertAgencyPortalEnabled: () => {
        if (!flag.on) throw Object.assign(new Error("off"), { status: 503, code: "HR-RECRUITMENT-AGENCY-PORTAL-DISABLED" });
    },
}));
jest.unstable_mockModule("../../../src/services/agency-submission.service.js", () => ({
    ...subSvc,
    assertAgencyScope: (scope) => {
        if (scope?.level !== "AGENCY") throw Object.assign(new Error("agency only"), { status: 403, code: "HR-RECRUITMENT-AGENCY-SCOPE-REQUIRED" });
    },
}));
const lookups = [];
jest.unstable_mockModule("../../../src/lib/agency-access.util.js", () => ({
    withAgencyMembership: async (user) => {
        lookups.push(user.userId);
        return user;
    },
}));

const { registerRecruitmentAgencyTools } = await import("../../../src/mcp/tools/recruitment-agency.tools.js");
const { registerAgencyPortalTools } = await import("../../../src/mcp/tools/agency-portal.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const server = { tool: (name, _d, _s, handler) => handlers.set(name, handler) };
registerRecruitmentAgencyTools(server);
registerAgencyPortalTools(server);

const T = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { userId: "r-1", roles: ["RECRUITER"], employeeId: 7, tenantId: T };
const MANAGER = { userId: "m-1", roles: ["HIRING_MANAGER"], employeeId: 8, tenantId: T };
const AGENCY = { userId: "u-1", roles: ["AGENCY"], employeeId: null, tenantId: T };
const ALL = ["VIEW", "CREATE", "EDIT", "DELETE"];
const call = (name, args, user, permissions) => mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const HR = [
    ["hr_recruitment_agencies_list", "VIEW", {}, adminSvc.listAgencies],
    ["hr_recruitment_agency_get", "VIEW", { id: 1 }, adminSvc.getAgency],
    ["hr_recruitment_agency_create", "CREATE", { name: "Alpha" }, adminSvc.createAgency],
    ["hr_recruitment_agency_update", "EDIT", { id: 1, expectedVersion: 0, status: "SUSPENDED" }, adminSvc.updateAgency],
    ["hr_recruitment_agency_users_list", "VIEW", {}, adminSvc.listAgencyUsers],
    ["hr_recruitment_agency_user_add", "CREATE", { agencyId: 1, userId: "u-1" }, adminSvc.addAgencyUser],
    ["hr_recruitment_agency_user_revoke", "EDIT", { id: 1 }, adminSvc.revokeAgencyUser],
    ["hr_requisition_agency_assign", "CREATE", { requisitionId: 2, agencyId: 1 }, adminSvc.assignRequisitionToAgency],
    ["hr_requisition_agency_unassign", "EDIT", { requisitionId: 2, agencyId: 1 }, adminSvc.unassignRequisitionFromAgency],
    ["hr_recruitment_agency_submissions_list", "VIEW", {}, subSvc.listAgencySubmissions],
    ["hr_recruitment_agency_submission_review", "EDIT", { id: 3, decision: "REJECT", reason: "no" }, subSvc.reviewAgencySubmission],
];
const PORTAL = [
    ["hr_recruitment_agency_portal_requisitions_list", "VIEW", {}, subSvc.listAgencyRequisitions],
    ["hr_recruitment_agency_portal_requisition_get", "VIEW", { requisitionId: 2 }, subSvc.getAgencyRequisition],
    ["hr_recruitment_agency_portal_submit", "CREATE", { requisitionId: 2, firstName: "A", lastName: "B", email: "a@b.co", note: "x" }, subSvc.submitAgencyCandidate],
    ["hr_recruitment_agency_portal_submissions_list", "VIEW", {}, subSvc.listOwnAgencySubmissions],
];

beforeEach(() => {
    flag.on = true;
    lookups.length = 0;
    jest.clearAllMocks();
});
afterAll(() => {
    flag.on = true;
});

it("registers exactly the fifteen agency tools", () => {
    expect([...handlers.keys()].sort()).toEqual([...HR, ...PORTAL].map(([n]) => n).sort());
});

describe("HR side", () => {
    it.each(HR)("%s needs hr:recruitment %s and the ORG scope, and passes the verified tenant", async (name, action, args, service) => {
        const noGrant = parse(await call(name, args, RECRUITER, { "hr:recruitment": ALL.filter((a) => a !== action) }));
        expect(noGrant.status).toBe(403);
        for (const user of [MANAGER, AGENCY]) {
            const res = parse(await call(name, args, user, { "hr:recruitment": ALL, "hr:recruitment_agency": ALL }));
            expect(res).toMatchObject({ status: 403 });
        }
        expect(service).not.toHaveBeenCalled();
        const ok = await call(name, { ...args, tenantId: "forged" }, RECRUITER, { "hr:recruitment": [action] });
        expect(ok.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T }));
    });

    it("records the verified employee as the actor", async () => {
        await call("hr_recruitment_agency_submission_review", { id: 3, decision: "ACCEPT" }, RECRUITER, { "hr:recruitment": ["EDIT"] });
        expect(subSvc.reviewAgencySubmission).toHaveBeenCalledWith(expect.objectContaining({ actorId: 7, id: 3, decision: "ACCEPT" }));
    });
});

describe("agency side", () => {
    it.each(PORTAL)("%s takes hr:recruitment_agency %s, only for the AGENCY scope", async (name, action, args, service) => {
        const noGrant = parse(await call(name, args, AGENCY, { "hr:payroll": ALL }));
        expect(noGrant.status).toBe(403);
        for (const user of [RECRUITER, MANAGER]) {
            const res = parse(await call(name, args, user, { "hr:recruitment": ALL, "hr:recruitment_agency": ALL }));
            expect(res).toMatchObject({ status: 403, code: "HR-4030" });
        }
        expect(service).not.toHaveBeenCalled();
        expect(lookups).toEqual([]);
        const ok = await call(name, args, AGENCY, { "hr:recruitment_agency": [action] });
        expect(ok.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, scope: expect.objectContaining({ level: "AGENCY" }) }));
        expect(lookups).toEqual(["u-1"]);
    });

    it("submits as the verified agency user", async () => {
        await call("hr_recruitment_agency_portal_submit", PORTAL[2][2], AGENCY, { "hr:recruitment_agency": ["CREATE"] });
        expect(subSvc.submitAgencyCandidate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-1" }));
    });

    it("is unavailable with the flag off", async () => {
        flag.on = false;
        const res = parse(await call("hr_recruitment_agency_portal_requisitions_list", {}, AGENCY, { "hr:recruitment_agency": ["VIEW"] }));
        expect(res).toMatchObject({ status: 503, code: "HR-5031" });
    });
});
