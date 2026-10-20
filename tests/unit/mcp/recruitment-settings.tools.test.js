// Phase 2 recruitment settings + source report tools: the permission method
// each tool checks, ORG-only writes, and who sees the feed token.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const getRecruitmentSettings = jest.fn(async ({ tenantId, includeFeedToken }) => ({
    id: tenantId, tenantId, feedEnabled: true, hasFeedToken: true, version: 2,
    ...(includeFeedToken ? { feedToken: TOKEN } : {}),
}));
const updateRecruitmentSettings = jest.fn(async ({ tenantId }) => ({
    id: tenantId, tenantId, feedEnabled: true, hasFeedToken: true, feedToken: TOKEN, version: 3,
}));
const getRecruitmentSourceReport = jest.fn(async () => ({ sources: [], totals: { applications: 0, hired: 0 } }));

jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({
    getRecruitmentSettings,
    updateRecruitmentSettings,
}));
jest.unstable_mockModule("../../../src/services/recruitment-source.service.js", () => ({
    getRecruitmentSourceReport,
}));

const { registerRecruitmentSettingsTools } = await import("../../../src/mcp/tools/recruitment-settings.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerRecruitmentSettingsTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { userId: "1", roles: ["RECRUITER"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const MANAGER = { userId: "2", roles: ["HIRING_MANAGER"], isAdmin: false, employeeId: 42, tenantId: TENANT };
const FINANCE = { userId: "3", roles: ["FINANCE"], isAdmin: false, employeeId: 9, tenantId: TENANT };

const call = (name, args, { user = RECRUITER, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
const grant = (action) => ({ "hr:recruitment": [action] });

beforeEach(() => jest.clearAllMocks());

describe("registration and permission method", () => {
    it.each([
        ["hr_recruitment_settings_get", "VIEW", {}],
        ["hr_recruitment_settings_set", "EDIT", { expectedVersion: 0 }],
        ["hr_recruitment_source_report", "VIEW", {}],
    ])("%s requires hr:recruitment %s", async (name, action, args) => {
        expect(handlers.has(name)).toBe(true);
        const denied = await call(name, args, { permissions: {} });
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);

        const wrongAction = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrongAction.isError).toBe(true);

        const ok = await call(name, args, { permissions: grant(action) });
        expect(ok.isError).toBeUndefined();
    });

    it("a forged isAdmin grants nothing", async () => {
        const res = await call("hr_recruitment_settings_set", { expectedVersion: 0 }, { user: { ...MANAGER, isAdmin: true } });
        expect(parse(res).status).toBe(403);
    });
});

describe("hr_recruitment_settings_get", () => {
    it("gives an ORG caller the token and the feed URLs", async () => {
        const res = parse(await call("hr_recruitment_settings_get", {}, { permissions: grant("VIEW") }));
        expect(getRecruitmentSettings).toHaveBeenCalledWith({ tenantId: TENANT, includeFeedToken: true });
        expect(res.feedToken).toBe(TOKEN);
        expect(res.feed.paths.INDEED).toBe(`/public/feeds/${TOKEN}/indeed.xml`);
        expect(res.feed.paths.LINKEDIN).toBe(`/public/feeds/${TOKEN}/linkedin.xml`);
        expect(res.feed.enabled).toBe(true);
        expect(typeof res.feed.flagEnabled).toBe("boolean");
    });

    it("never gives a hiring manager the token or URLs", async () => {
        const raw = await call("hr_recruitment_settings_get", {}, { user: MANAGER, permissions: grant("VIEW") });
        const res = parse(raw);
        expect(getRecruitmentSettings).toHaveBeenCalledWith({ tenantId: TENANT, includeFeedToken: false });
        expect(res).not.toHaveProperty("feedToken");
        expect(res).not.toHaveProperty("feed");
        expect(raw.content[0].text).not.toContain(TOKEN);
    });

    it("refuses a scope with no requisition view", async () => {
        const res = await call("hr_recruitment_settings_get", {}, { user: FINANCE, permissions: grant("VIEW") });
        expect(parse(res).status).toBe(403);
        expect(getRecruitmentSettings).not.toHaveBeenCalled();
    });
});

describe("hr_recruitment_settings_set", () => {
    it("is ORG only", async () => {
        for (const user of [MANAGER, FINANCE]) {
            const res = await call("hr_recruitment_settings_set", { expectedVersion: 2 }, { user, permissions: grant("EDIT") });
            expect(parse(res).status).toBe(403);
        }
        expect(updateRecruitmentSettings).not.toHaveBeenCalled();
    });

    it("passes the version, rotate flag and only the settings fields, and returns the feed URLs", async () => {
        const res = parse(await call("hr_recruitment_settings_set", {
            expectedVersion: 2,
            rotateFeedToken: true,
            shortlistThreshold: 75,
            portalBaseUrl: "https://careers.acme.test",
            companyLogoUrl: null,
            tenantId: "22222222-2222-4222-8222-222222222222",
        }, { permissions: grant("EDIT") }));
        expect(updateRecruitmentSettings).toHaveBeenCalledWith({
            tenantId: TENANT,
            actorId: 7,
            expectedVersion: 2,
            rotateFeedToken: true,
            input: { shortlistThreshold: 75, portalBaseUrl: "https://careers.acme.test", companyLogoUrl: null },
        });
        expect(res.version).toBe(3);
        expect(res.feed.paths.INDEED).toBe(`/public/feeds/${TOKEN}/indeed.xml`);
    });

    it("surfaces the service's version conflict", async () => {
        updateRecruitmentSettings.mockRejectedValueOnce(
            Object.assign(new Error("Recruitment settings changed; refresh before saving"), {
                status: 409, code: "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT",
            }),
        );
        const res = await call("hr_recruitment_settings_set", { expectedVersion: 1 }, { permissions: grant("EDIT") });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(409);
    });
});

describe("hr_recruitment_source_report", () => {
    it("passes the caller's resolved scope and the filters", async () => {
        await call("hr_recruitment_source_report", { requisitionId: "9", from: "2026-10-01", to: "2026-10-31" }, {
            user: MANAGER, permissions: grant("VIEW"),
        });
        const args = getRecruitmentSourceReport.mock.calls[0][0];
        expect(args).toMatchObject({ tenantId: TENANT, requisitionId: "9", from: "2026-10-01", to: "2026-10-31" });
        expect(args.scope).toMatchObject({ level: "MANAGED", employeeId: 42, unrestricted: false });
    });
});
