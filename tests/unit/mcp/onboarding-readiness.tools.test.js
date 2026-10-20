// Recruitment Phase 4 (stream M) — the readiness and survey completion tools:
// registration, GET on hr:onboarding (an HTTP method, never an action name),
// the verified tenant handed to each service, and the flag-off 503 code.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const getOnboardingReadiness = jest.fn(async () => ({ checklistId: 100, live: { status: "READY" } }));
const listOnboardingReadiness = jest.fn(async () => ({ items: [], total: 0 }));
const getOnboardingSurveyCompletion = jest.fn(async () => ({ rows: [], totals: [] }));

jest.unstable_mockModule("../../../src/services/onboarding-readiness.service.js", () => ({ getOnboardingReadiness, listOnboardingReadiness }));
jest.unstable_mockModule("../../../src/services/onboarding-survey.service.js", () => ({ getOnboardingSurveyCompletion }));

const { registerOnboardingReadinessTools } = await import("../../../src/mcp/tools/onboarding-readiness.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
registerOnboardingReadinessTools({
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
    },
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR = { userId: "1", roles: ["HR"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const grant = (action) => ({ "hr:onboarding": [action] });
const call = (name, args, { user = HR, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_onboarding_readiness_get", { checklistId: 100 }],
    ["hr_onboarding_readiness_list", {}],
    ["hr_onboarding_survey_completion_get", {}],
];

beforeEach(() => jest.clearAllMocks());

describe("registration and permission", () => {
    it("registers exactly the three tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([n]) => n).sort());
    });

    it.each(TOOLS)("%s requires hr:onboarding VIEW (GET)", async (name, args) => {
        const denied = await call(name, args);
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant("EDIT") });
        expect(wrong.isError).toBe(true);
        const ok = await call(name, args, { permissions: grant("VIEW") });
        expect(ok.isError).toBeUndefined();
    });

    it("a forged isAdmin grants nothing", async () => {
        const res = await call("hr_onboarding_readiness_get", { checklistId: 1 }, { user: { ...HR, isAdmin: true } });
        expect(parse(res).status).toBe(403);
    });
});

describe("what each tool hands its service", () => {
    it("passes the verified tenant and the arguments", async () => {
        const permissions = grant("VIEW");
        await call("hr_onboarding_readiness_get", { checklistId: 100 }, { permissions });
        expect(getOnboardingReadiness).toHaveBeenCalledWith({ tenantId: TENANT, checklistId: 100 });
        await call("hr_onboarding_readiness_list", { days: 5, status: "AT_RISK", limit: 20 }, { permissions });
        expect(listOnboardingReadiness).toHaveBeenCalledWith({ tenantId: TENANT, days: 5, status: "AT_RISK", limit: 20 });
        await call("hr_onboarding_survey_completion_get", { from: "2026-01", to: "2026-06" }, { permissions });
        expect(getOnboardingSurveyCompletion).toHaveBeenCalledWith({ tenantId: TENANT, from: "2026-01", to: "2026-06" });
    });

    it("a flag-off service error reaches the client as its domain code", async () => {
        getOnboardingReadiness.mockRejectedValueOnce(
            Object.assign(new Error("Onboarding automation is disabled"), { status: 503, code: "HR-ONBOARDING-AUTOMATION-DISABLED" }),
        );
        const res = await call("hr_onboarding_readiness_get", { checklistId: 100 }, { permissions: grant("VIEW") });
        expect(res.isError).toBe(true);
        expect(parse(res)).toMatchObject({ status: 503, code: "HR-5031" });
    });
});
