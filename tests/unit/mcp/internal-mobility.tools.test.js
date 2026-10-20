// Recruitment Phase 5 (plan 6.2) — the internal board and referral tools:
// registration, the gate each checks, the flag, the pin of every employee-side
// call to the verified caller, and the ORG-only bonus decision.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const flag = { on: true };
const assertInternalBoardEnabled = jest.fn(() => {
    if (!flag.on) throw Object.assign(new Error("off"), { status: 503, code: "HR-RECRUITMENT-INTERNAL-BOARD-DISABLED" });
});
const listInternalJobs = jest.fn(async () => ({ items: [], total: 0 }));
const getInternalJob = jest.fn(async () => ({ id: 1 }));
const applyToInternalJob = jest.fn(async () => ({ applied: true }));
const createReferral = jest.fn(async () => ({ id: 1, status: "SUBMITTED" }));
const listMyReferrals = jest.fn(async () => ({ items: [], total: 0 }));
const listReferrals = jest.fn(async () => ({ items: [], total: 0 }));
const updateReferralBonus = jest.fn(async () => ({ id: 1, bonusStatus: "APPROVED" }));

jest.unstable_mockModule("../../../src/services/internal-board.service.js", () => ({
    applyToInternalJob,
    createReferral,
    getInternalJob,
    listInternalJobs,
    listMyReferrals,
}));
jest.unstable_mockModule("../../../src/services/internal-referral.service.js", () => ({
    assertInternalBoardEnabled,
    listReferrals,
    updateReferralBonus,
}));

const { registerInternalBoardTools, resolveSelfEmployeeId } = await import("../../../src/mcp/tools/internal-board.tools.js");
const { registerInternalReferralTools } = await import("../../../src/mcp/tools/internal-referral.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const server = { tool: (name, _desc, _schema, handler) => handlers.set(name, handler) };
registerInternalBoardTools(server);
registerInternalReferralTools(server);

const TENANT = "11111111-1111-4111-8111-111111111111";
const EMP = { userId: "9", isAdmin: false, employeeId: 101, tenantId: TENANT, roles: ["EMPLOYEE"] };
const SELF = { "hr:self": ["VIEW"] };
const call = (name, args, { user = EMP, permissions = SELF } = {}) => mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const FORM = { requisitionId: 5, firstName: "Omar", email: "omar@mail.test", consent: true };
const SELF_TOOLS = [
    ["hr_self_internal_jobs_list", {}, listInternalJobs],
    ["hr_self_internal_job_get", { requisitionId: 5 }, getInternalJob],
    ["hr_self_internal_job_apply", { requisitionId: 5, consent: true }, applyToInternalJob],
    ["hr_self_referral_create", FORM, createReferral],
    ["hr_self_referrals_list", {}, listMyReferrals],
];
const RECRUITER = { ...EMP, employeeId: 160, roles: ["RECRUITER"] };

beforeEach(() => {
    flag.on = true;
    jest.clearAllMocks();
});

describe("registration", () => {
    it("registers the five employee tools and the two HR tools", () => {
        expect([...handlers.keys()].sort()).toEqual(
            [...SELF_TOOLS.map(([n]) => n), "hr_recruitment_referrals_list", "hr_recruitment_referral_bonus_update"].sort(),
        );
    });
});

describe("employee side", () => {
    it.each(SELF_TOOLS)("%s needs hr:self VIEW and passes the caller's own id and tenant", async (name, args, service) => {
        const denied = await call(name, args, { permissions: { "hr:recruitment": ["VIEW", "EDIT"] } });
        expect(parse(denied).status).toBe(403);
        expect(service).not.toHaveBeenCalled();
        const ok = await call(name, args);
        expect(ok.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, employeeId: 101 }));
    });

    it.each(SELF_TOOLS)("%s refuses a different employeeId, even for an admin", async (name, args, service) => {
        const res = await call(name, { ...args, employeeId: 102 }, { user: { ...EMP, isAdmin: true }, permissions: { ...SELF, "hr:recruitment": ["EDIT"] } });
        expect(parse(res).status).toBe(403);
        expect(service).not.toHaveBeenCalled();
        expect((await call(name, { ...args, employeeId: "101" })).isError).toBeUndefined();
    });

    it.each(SELF_TOOLS)("%s gives a calm 400 to a session with no employee", async (name, args, service) => {
        const res = await call(name, args, { user: { ...EMP, employeeId: null } });
        expect(parse(res).status).toBe(400);
        expect(parse(res).jsonrpc.data.details).toMatchObject({ code: "HR-RECRUITMENT-INTERNAL-NO-EMPLOYEE" });
        expect(service).not.toHaveBeenCalled();
    });

    it.each(SELF_TOOLS)("%s answers 503 HR-5031 while the flag is off", async (name, args, service) => {
        flag.on = false;
        const res = await call(name, args);
        expect(parse(res)).toMatchObject({ status: 503, code: "HR-5031" });
        expect(service).not.toHaveBeenCalled();
    });

    it("hands the referral form through without the employeeId", async () => {
        await call("hr_self_referral_create", { ...FORM, lastName: "Khan", note: "Great", employeeId: 101 });
        expect(createReferral).toHaveBeenCalledWith({ tenantId: TENANT, employeeId: 101, ...FORM, lastName: "Khan", note: "Great" });
    });
});

describe("HR side", () => {
    it("the list needs hr:recruitment VIEW and passes the caller's recruitment scope", async () => {
        expect(parse(await call("hr_recruitment_referrals_list", {})).status).toBe(403);
        await call("hr_recruitment_referrals_list", { status: "HIRED" }, { user: RECRUITER, permissions: { "hr:recruitment": ["VIEW"] } });
        expect(listReferrals).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, status: "HIRED", scope: expect.objectContaining({ level: "ORG" }) }));
    });

    it("the bonus decision needs hr:recruitment EDIT (PUT) and an ORG scope", async () => {
        const args = { referralId: 1, expectedVersion: 0, bonusStatus: "APPROVED", amount: 5000, currency: "PKR" };
        expect(parse(await call("hr_recruitment_referral_bonus_update", args, { user: RECRUITER, permissions: { "hr:recruitment": ["VIEW"] } })).status).toBe(403);
        const manager = { ...EMP, employeeId: 102, roles: ["HIRING_MANAGER"] };
        const res = await call("hr_recruitment_referral_bonus_update", args, { user: manager, permissions: { "hr:recruitment": ["EDIT"] } });
        expect(parse(res).status).toBe(403);
        expect(updateReferralBonus).not.toHaveBeenCalled();
        await call("hr_recruitment_referral_bonus_update", args, { user: RECRUITER, permissions: { "hr:recruitment": ["EDIT"] } });
        expect(updateReferralBonus).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, referralId: 1, amount: "5000", currency: "PKR", actorId: 160 }));
    });

    it("both answer 503 while the flag is off", async () => {
        flag.on = false;
        const res = await call("hr_recruitment_referrals_list", {}, { user: RECRUITER, permissions: { "hr:recruitment": ["VIEW"] } });
        expect(parse(res).status).toBe(503);
        expect(listReferrals).not.toHaveBeenCalled();
    });
});

describe("resolveSelfEmployeeId", () => {
    it("pins to the claim", () => {
        expect(resolveSelfEmployeeId({ employeeId: "101" })).toBe(101);
        expect(() => resolveSelfEmployeeId({ employeeId: 101 }, 5)).toThrow(expect.objectContaining({ status: 403 }));
        expect(() => resolveSelfEmployeeId({ employeeId: 0 })).toThrow(expect.objectContaining({ status: 400 }));
    });
});
