// Recruitment Phase 5 (plan 6.9) — the privacy operations tools: registration,
// the HTTP method each checks on hr:recruitment, the ORG scope it resolves,
// and what each hands its service (tenant and actor from the verified context).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const listRetentionRuns = jest.fn(async () => ({ items: [] }));
const getRetentionRun = jest.fn(async () => ({ id: 10 }));
const signOffRetentionRun = jest.fn(async () => ({ runId: 10 }));
const disableRetentionApply = jest.fn(async () => ({ changed: true }));
const setDataPolicyOwner = jest.fn(async () => ({ changed: true }));
const generateDsrAccessExport = jest.fn(async () => ({ requestId: 900 }));

jest.unstable_mockModule("../../../src/services/retention-run.service.js", () => ({
    listRetentionRuns, getRetentionRun, signOffRetentionRun, disableRetentionApply, setDataPolicyOwner,
}));
jest.unstable_mockModule("../../../src/services/dsr-export.service.js", () => ({ generateDsrAccessExport }));

const { registerPrivacyOperationsTools, PRIVACY_OPERATIONS_TOOL_NAMES } = await import("../../../src/mcp/tools/privacy-operations.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
registerPrivacyOperationsTools({
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
    },
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR = { userId: "1", roles: ["HR_ADMIN"], employeeId: 42, tenantId: TENANT, isAdmin: false };
const grant = (...actions) => ({ "hr:recruitment": actions });
const call = (name, args, { user = HR, permissions = grant("VIEW", "EDIT", "CREATE") } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_candidate_retention_runs_list", "VIEW", {}],
    ["hr_candidate_retention_run_get", "VIEW", { runId: 10 }],
    ["hr_candidate_retention_signoff", "EDIT", { runId: 10 }],
    ["hr_candidate_retention_apply_disable", "EDIT", {}],
    ["hr_candidate_retention_owner_set", "EDIT", { employeeId: 42 }],
    ["hr_candidate_request_export_generate", "CREATE", { requestId: 900 }],
];

beforeEach(() => jest.clearAllMocks());

describe("registration and permission", () => {
    it("registers exactly the six tools, all with an HR-side name", () => {
        expect([...handlers.keys()].sort()).toEqual([...PRIVACY_OPERATIONS_TOOL_NAMES].sort());
        expect(PRIVACY_OPERATIONS_TOOL_NAMES).toEqual(TOOLS.map(([name]) => name));
        expect(PRIVACY_OPERATIONS_TOOL_NAMES.every((n) => n.startsWith("hr_candidate_"))).toBe(true);
    });

    it.each(TOOLS)("%s requires hr:recruitment %s", async (name, action, args) => {
        expect(parse(await call(name, args, { permissions: {} })).status).toBe(403);
        const other = action === "VIEW" ? grant("EDIT") : grant("VIEW");
        expect((await call(name, args, { permissions: other })).isError).toBe(true);
        expect((await call(name, args, { permissions: grant(action) })).isError).toBeUndefined();
    });
});

describe("what each tool hands its service", () => {
    it("reads pass the tenant and the resolved ORG scope", async () => {
        await call("hr_candidate_retention_runs_list", { mode: "DRY_RUN", page: 2, limit: 5 });
        expect(listRetentionRuns).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, mode: "DRY_RUN", page: 2, limit: 5, scope: expect.objectContaining({ level: "ORG" }) }));
        await call("hr_candidate_retention_run_get", { runId: 10 });
        expect(getRetentionRun).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, runId: 10 }));
    });

    it("writes pass the verified user (never an argument) for the owner check", async () => {
        await call("hr_candidate_retention_signoff", { runId: 10, expectedVersion: 3 });
        expect(signOffRetentionRun).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, runId: 10, expectedVersion: 3, user: expect.objectContaining({ employeeId: 42 }) }));
        await call("hr_candidate_retention_apply_disable", { reason: "review" });
        expect(disableRetentionApply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, reason: "review", user: expect.objectContaining({ employeeId: 42 }) }));
        await call("hr_candidate_retention_owner_set", { employeeId: 77 });
        expect(setDataPolicyOwner).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, employeeId: 77 }));
        await call("hr_candidate_request_export_generate", { requestId: 900 });
        expect(generateDsrAccessExport).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, requestId: 900, actorId: 42 }));
    });

    it("a hiring manager resolves to a narrower scope, which the services refuse", async () => {
        await call("hr_candidate_retention_runs_list", {}, { user: { ...HR, roles: ["HIRING_MANAGER"] } });
        expect(listRetentionRuns.mock.calls[0][0].scope.level).toBe("MANAGED");
    });

    it("inputs are closed vocabularies with bounds", () => {
        expect(schemas.get("hr_candidate_retention_runs_list").mode.safeParse("ALL").success).toBe(false);
        expect(schemas.get("hr_candidate_retention_signoff").runId.safeParse(0).success).toBe(false);
        expect(schemas.get("hr_candidate_retention_apply_disable").reason.safeParse("x".repeat(501)).success).toBe(false);
    });
});
