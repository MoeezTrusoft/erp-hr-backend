// Recruitment Phase 4 — the orientation session tools: registration, the HTTP
// method each one checks on hr:onboarding, and the verified tenant each passes
// to its service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const previewOnboardingSessionPlan = jest.fn(async () => ({ source: "DEFAULT", sessions: [] }));
const requeueOnboardingSessionCalendarSync = jest.fn(async () => ({ sessionId: 400, calendarSyncStatus: "PENDING" }));
const deleteSession = jest.fn(async () => ({ id: 400, deleted: true }));

jest.unstable_mockModule("../../../src/services/onboarding-session-plan.service.js", () => ({ previewOnboardingSessionPlan }));
jest.unstable_mockModule("../../../src/services/onboarding-calendar-sync.service.js", () => ({ requeueOnboardingSessionCalendarSync }));
jest.unstable_mockModule("../../../src/services/onboarding-schedule.service.js", () => ({ deleteSession }));

const { registerOnboardingSessionPlanTools } = await import("../../../src/mcp/tools/onboarding-session-plan.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerOnboardingSessionPlanTools({ tool: (name, _desc, _schema, handler) => handlers.set(name, handler) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR = { userId: "1", isAdmin: false, employeeId: 7, tenantId: TENANT };
const grant = (action) => ({ "hr:onboarding": [action] });
const call = (name, args, { user = HR, permissions } = {}) => mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_onboarding_session_plan_preview", "VIEW", { startDate: "2026-10-26" }],
    ["hr_onboarding_session_calendar_resync", "CREATE", { sessionId: 400 }],
    ["hr_onboarding_session_delete", "DELETE", { id: 400 }],
];

beforeEach(() => jest.clearAllMocks());

describe("registration and permission method", () => {
    it("registers exactly the three tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([name]) => name).sort());
    });

    it.each(TOOLS)("%s requires hr:onboarding %s", async (name, action, args) => {
        const denied = await call(name, args, { permissions: {} });
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrong.isError).toBe(true);
        const ok = await call(name, args, { permissions: grant(action) });
        expect(ok.isError).toBeUndefined();
    });

    it("a forged isAdmin grants nothing", async () => {
        const res = await call("hr_onboarding_session_delete", { id: 400 }, { user: { ...HR, isAdmin: true } });
        expect(parse(res).status).toBe(403);
    });
});

describe("what each tool hands its service", () => {
    it("the verified tenant and the inputs", async () => {
        const draft = [{ key: "d", title: "Draft", sessionType: "training", dayOffset: 1, assigneeType: "HR" }];
        const res = await call("hr_onboarding_session_plan_preview", { startDate: "2026-10-26", templateId: 4, sessions: draft }, { permissions: grant("VIEW") });
        expect(parse(res)).toEqual({ source: "DEFAULT", sessions: [] });
        expect(previewOnboardingSessionPlan).toHaveBeenCalledWith({ tenantId: TENANT, startDate: "2026-10-26", templateId: 4, sessions: draft });

        await call("hr_onboarding_session_calendar_resync", { sessionId: 400 }, { permissions: grant("CREATE") });
        expect(requeueOnboardingSessionCalendarSync).toHaveBeenCalledWith({ sessionId: 400, tenantId: TENANT });

        await call("hr_onboarding_session_delete", { id: 400 }, { permissions: grant("DELETE") });
        expect(deleteSession).toHaveBeenCalledWith(400, TENANT);
    });

    it("a service refusal comes back as a tool error with its status", async () => {
        requeueOnboardingSessionCalendarSync.mockRejectedValueOnce(Object.assign(new Error("Onboarding session not found"), { status: 404, code: "HR-ONBOARDING-SESSION-NOT-FOUND" }));
        const res = await call("hr_onboarding_session_calendar_resync", { sessionId: 401 }, { permissions: grant("CREATE") });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(404);
    });
});
