// Recruitment Phase 4 — the provisioning tools: registration, the HTTP method
// each checks on hr:onboarding, the flag, and what each hands its service.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const listProvisioningRequests = jest.fn(async () => ({ items: [], total: 0, page: 1, limit: 50 }));
const getProvisioningRequest = jest.fn(async () => ({ id: 3 }));
const updateProvisioningRequest = jest.fn(async () => ({ id: 3, status: "IN_PROGRESS" }));
const assertOnboardingAutomationEnabled = jest.fn(() => {
    if (process.env.HR_ONBOARDING_AUTOMATION !== "true") {
        throw Object.assign(new Error("Onboarding automation is disabled"), { status: 503, code: "HR-ONBOARDING-AUTOMATION-DISABLED" });
    }
});

jest.unstable_mockModule("../../../src/services/onboarding-provisioning.service.js", () => ({
    listProvisioningRequests,
    getProvisioningRequest,
    updateProvisioningRequest,
    assertOnboardingAutomationEnabled,
}));

const { registerOnboardingProvisioningTools } = await import("../../../src/mcp/tools/onboarding-provisioning.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
registerOnboardingProvisioningTools({
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
    },
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR = { userId: "1", roles: ["HR_MANAGER"], employeeId: 7, tenantId: TENANT };
const IT = { userId: "2", roles: ["IT_SUPPORT"], employeeId: 61, tenantId: TENANT };
const grant = (...actions) => ({ "hr:onboarding": actions });
const call = (name, args, { user = HR, permissions = grant("VIEW", "EDIT") } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_onboarding_provisioning_requests_list", "VIEW", {}],
    ["hr_onboarding_provisioning_request_get", "VIEW", { requestId: 3 }],
    ["hr_onboarding_provisioning_request_update", "EDIT", { requestId: 3, expectedVersion: 0, status: "IN_PROGRESS" }],
];

const ORIGINAL_FLAG = process.env.HR_ONBOARDING_AUTOMATION;
afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_ONBOARDING_AUTOMATION;
    else process.env.HR_ONBOARDING_AUTOMATION = ORIGINAL_FLAG;
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_ONBOARDING_AUTOMATION = "true";
});

describe("registration, permission and flag", () => {
    it("registers exactly the three provisioning tools", () => {
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

    it.each(TOOLS)("%s answers 503 HR-ONBOARDING-AUTOMATION-DISABLED with the flag off", async (name, _action, args) => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        const res = await call(name, args);
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(503);
        expect(listProvisioningRequests).not.toHaveBeenCalled();
        expect(updateProvisioningRequest).not.toHaveBeenCalled();
    });

    it("checks the permission before the flag", async () => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(parse(await call("hr_onboarding_provisioning_requests_list", {}, { permissions: {} })).status).toBe(403);
    });
});

describe("what each tool hands its service", () => {
    it("list passes the verified tenant and the filters", async () => {
        await call("hr_onboarding_provisioning_requests_list", { status: "REQUESTED", kind: "DEVICE", overdue: true, employeeId: 500, page: 2, limit: 10 });
        expect(listProvisioningRequests).toHaveBeenCalledWith({
            status: "REQUESTED", kind: "DEVICE", overdue: true, employeeId: 500, page: 2, limit: 10, tenantId: TENANT,
        });
    });

    it("get passes the tenant and id", async () => {
        await call("hr_onboarding_provisioning_request_get", { requestId: 3 });
        expect(getProvisioningRequest).toHaveBeenCalledWith({ tenantId: TENANT, requestId: 3 });
    });

    it("update: HR may cancel, attributed to the caller's employee id", async () => {
        await call("hr_onboarding_provisioning_request_update", { requestId: 3, expectedVersion: 2, status: "CANCELLED", notes: "Role withdrawn" });
        expect(updateProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT, requestId: 3, expectedVersion: 2, status: "CANCELLED", notes: "Role withdrawn", actorId: 7, allowCancel: true,
        }));
    });

    it("update: an IT-only caller may not cancel", async () => {
        await call("hr_onboarding_provisioning_request_update", { requestId: 3, expectedVersion: 0, status: "FULFILLED", externalRef: "LT-220" }, { user: IT });
        expect(updateProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ actorId: 61, allowCancel: false, externalRef: "LT-220" }));
    });

    it("update needs an expected version; the inputs are closed vocabularies", () => {
        const schema = schemas.get("hr_onboarding_provisioning_request_update");
        expect(schema.expectedVersion.safeParse(undefined).success).toBe(false);
        expect(schema.status.safeParse("DONE").success).toBe(false);
        expect(schema.notes.safeParse("x".repeat(2001)).success).toBe(false);
        expect(schemas.get("hr_onboarding_provisioning_requests_list").kind.safeParse("PRINTER").success).toBe(false);
    });
});
