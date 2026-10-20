// tests/unit/mcp/talent-nurture.tools.test.js
//
// Recruitment Phase 5 — the talent pool nurture tools: list/get are GET on
// hr:recruitment with the caller's recruitment scope; send/dismiss are PUT,
// pass the scope (the service refuses non-ORG) and attribute the decision to
// the caller's employee id.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const service = {
    listNurtureRuns: jest.fn(async () => ({ items: [], total: 0 })),
    getNurtureRun: jest.fn(async () => ({ id: 5, members: [] })),
    sendNurtureRun: jest.fn(async () => ({ alreadySent: false, invitedCount: 2 })),
    dismissNurtureRun: jest.fn(async () => ({ alreadyDismissed: false })),
};
jest.unstable_mockModule("../../../src/services/talent-nurture.service.js", () => service);

const { registerTalentNurtureTools } = await import("../../../src/mcp/tools/talent-nurture.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerTalentNurtureTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { roles: ["RECRUITER"], employeeId: 7, tenantId: TENANT, isAdmin: false };
const MANAGER = { roles: ["HIRING_MANAGER"], employeeId: 8, tenantId: TENANT, isAdmin: false };
const PERMS = { "hr:recruitment": ["VIEW", "EDIT"] };

const call = (name, args, user = RECRUITER, permissions = PERMS) =>
    mcpCtx.run({ user, permissions }, async () => await handlers.get(name)(args));

beforeEach(() => jest.clearAllMocks());

describe("talent nurture tools", () => {
    it("registers exactly the four tools", () => {
        expect([...handlers.keys()].sort()).toEqual([
            "hr_talent_nurture_run_dismiss",
            "hr_talent_nurture_run_get",
            "hr_talent_nurture_run_send",
            "hr_talent_nurture_runs_list",
        ]);
    });

    it("list passes the filters and the caller's scope", async () => {
        const res = await call("hr_talent_nurture_runs_list", { status: "PROPOSED", requisitionId: "10" }, MANAGER);
        expect(res.isError).not.toBe(true);
        expect(service.listNurtureRuns).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT, status: "PROPOSED", requisitionId: "10", scope: expect.objectContaining({ level: "MANAGED", employeeId: 8 }),
        }));
    });

    it("get reads one run in scope", async () => {
        const res = await call("hr_talent_nurture_run_get", { runId: 5 });
        expect(JSON.parse(res.content[0].text)).toEqual({ id: 5, members: [] });
        expect(service.getNurtureRun).toHaveBeenCalledWith({ tenantId: TENANT, scope: expect.objectContaining({ level: "ORG" }), runId: 5 });
    });

    it("send attributes the decision to the recruiter and forwards the drop list", async () => {
        const res = await call("hr_talent_nurture_run_send", { runId: "5", dropCandidateIds: [3], validityDays: 14 });
        expect(res.isError).not.toBe(true);
        expect(service.sendNurtureRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT, runId: "5", dropCandidateIds: [3], validityDays: 14, actorId: 7, scope: expect.objectContaining({ unrestricted: true }),
        }));
    });

    it("dismiss forwards the reason", async () => {
        await call("hr_talent_nurture_run_dismiss", { runId: 5, reason: "Hiring paused" });
        expect(service.dismissNurtureRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 5, reason: "Hiring paused", actorId: 7 }));
    });

    it("send and dismiss need the PUT grant; list needs GET", async () => {
        const viewOnly = { "hr:recruitment": ["VIEW"] };
        expect((await call("hr_talent_nurture_run_send", { runId: 5 }, RECRUITER, viewOnly)).isError).toBe(true);
        expect((await call("hr_talent_nurture_run_dismiss", { runId: 5, reason: "x" }, RECRUITER, viewOnly)).isError).toBe(true);
        expect((await call("hr_talent_nurture_runs_list", {}, RECRUITER, {})).isError).toBe(true);
        expect(service.sendNurtureRun).not.toHaveBeenCalled();
        expect(service.dismissNurtureRun).not.toHaveBeenCalled();
        expect(service.listNurtureRuns).not.toHaveBeenCalled();
    });

    it("surfaces the service's refusal (a manager sending) as a tool error", async () => {
        service.sendNurtureRun.mockRejectedValueOnce(Object.assign(new Error("Only recruiters"), { status: 403, code: "HR-RECRUITMENT-NURTURE-FORBIDDEN" }));
        const res = await call("hr_talent_nurture_run_send", { runId: 5 }, MANAGER);
        expect(res.isError).toBe(true);
        expect(service.sendNurtureRun.mock.calls[0][0].scope).toMatchObject({ level: "MANAGED", unrestricted: false });
    });
});
