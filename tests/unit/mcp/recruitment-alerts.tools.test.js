// Phase 5 analytics alert tools: the permission method each tool checks, the
// analyticsAlerts flag (503, HR-5031 family), ORG-only scope, and the
// arguments passed through to the service.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const getAlertThresholds = jest.fn(async ({ tenantId }) => ({ tenantId, thresholds: {}, version: 0 }));
const setAlertThresholds = jest.fn(async ({ tenantId }) => ({ tenantId, thresholds: { slaBreaches: 2 }, version: 1 }));
const listRecruitmentAlerts = jest.fn(async () => ({ alerts: [], count: 0 }));
const acknowledgeRecruitmentAlert = jest.fn(async ({ alertId }) => ({ id: alertId, status: "ACKNOWLEDGED" }));

jest.unstable_mockModule("../../../src/services/recruitment-alerts.service.js", () => ({
    getAlertThresholds,
    setAlertThresholds,
    listRecruitmentAlerts,
    acknowledgeRecruitmentAlert,
    assertAlertsEnabled: () => {
        if (process.env.HR_RECRUITMENT_ANALYTICS_ALERTS !== "true") {
            throw Object.assign(new Error("Recruitment analytics alerts are disabled"), {
                status: 503,
                code: "HR-RECRUITMENT-ANALYTICS-ALERTS-DISABLED",
            });
        }
    },
}));

const { registerRecruitmentAlertTools } = await import("../../../src/mcp/tools/recruitment-alerts.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerRecruitmentAlertTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { userId: "1", roles: ["RECRUITER"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const MANAGER = { userId: "2", roles: ["HIRING_MANAGER"], isAdmin: false, employeeId: 42, tenantId: TENANT };

const call = (name, args, { user = RECRUITER, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
const grant = (action) => ({ "hr:recruitment": [action] });

let savedFlag;
beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.HR_RECRUITMENT_ANALYTICS_ALERTS;
    process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = "true";
});
afterEach(() => {
    if (savedFlag === undefined) delete process.env.HR_RECRUITMENT_ANALYTICS_ALERTS;
    else process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = savedFlag;
});

const TOOLS = [
    ["hr_recruitment_alert_thresholds_get", "VIEW", {}],
    ["hr_recruitment_alert_thresholds_set", "EDIT", { expectedVersion: 0, thresholds: { slaBreaches: 2 } }],
    ["hr_recruitment_alerts_list", "VIEW", {}],
    ["hr_recruitment_alert_acknowledge", "EDIT", { alertId: 3 }],
];

describe("registration, permission method, flag and scope", () => {
    it.each(TOOLS)("%s requires hr:recruitment %s", async (name, action, args) => {
        expect(handlers.has(name)).toBe(true);
        const denied = await call(name, args, { permissions: {} });
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrong.isError).toBe(true);
        const ok = await call(name, args, { permissions: grant(action) });
        expect(ok.isError).toBeUndefined();
    });

    it.each(TOOLS)("%s answers 503 with the flag off", async (name, action, args) => {
        process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = "false";
        const res = await call(name, args, { permissions: grant(action) });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(503);
    });

    it.each(TOOLS)("%s is ORG-only (a hiring manager gets 403)", async (name, action, args) => {
        const res = await call(name, args, { user: MANAGER, permissions: grant(action) });
        expect(parse(res).status).toBe(403);
        expect([getAlertThresholds, setAlertThresholds, listRecruitmentAlerts, acknowledgeRecruitmentAlert].every((f) => f.mock.calls.length === 0)).toBe(true);
    });

    it("exactly these four tools are registered", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([n]) => n).sort());
    });
});

describe("pass-through", () => {
    it("set passes the version, thresholds, recipient and the acting employee", async () => {
        await call("hr_recruitment_alert_thresholds_set", { expectedVersion: 4, thresholds: { failedHandoffs: 0 }, alertRecipientId: 9 }, { permissions: grant("EDIT") });
        expect(setAlertThresholds).toHaveBeenCalledWith({
            tenantId: TENANT, actorId: 7, expectedVersion: 4, thresholds: { failedHandoffs: 0 }, alertRecipientId: 9,
        });
    });

    it("list and acknowledge are tenant-scoped", async () => {
        await call("hr_recruitment_alerts_list", { status: "OPEN", metric: "TIME_TO_FILL", limit: 5 }, { permissions: grant("VIEW") });
        expect(listRecruitmentAlerts).toHaveBeenCalledWith({ tenantId: TENANT, status: "OPEN", metric: "TIME_TO_FILL", limit: 5 });
        const res = parse(await call("hr_recruitment_alert_acknowledge", { alertId: 3 }, { permissions: grant("EDIT") }));
        expect(acknowledgeRecruitmentAlert).toHaveBeenCalledWith({ tenantId: TENANT, alertId: 3, actorId: 7 });
        expect(res.status).toBe("ACKNOWLEDGED");
    });
});
