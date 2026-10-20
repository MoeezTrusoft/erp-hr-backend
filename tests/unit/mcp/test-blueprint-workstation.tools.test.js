// Recruitment Phase 3b — the blueprint and workstation tools: registration,
// the HTTP method each checks on hr:recruitment, and the tenant, assessment
// access and actor each hands its service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { z } from "zod";

const blueprintFns = {
    listTestBlueprints: jest.fn(async () => ({ items: [], total: 0 })),
    getTestBlueprint: jest.fn(async () => ({ id: 1 })),
    createTestBlueprint: jest.fn(async () => ({ id: 1 })),
    updateTestBlueprint: jest.fn(async () => ({ id: 1 })),
    approveTestBlueprint: jest.fn(async () => ({ id: 1 })),
    publishTestBlueprint: jest.fn(async () => ({ blueprint: { id: 1 } })),
    linkTestBlueprint: jest.fn(async () => ({ link: { id: 1 } })),
    resolveTestBlueprint: jest.fn(async () => ({ blueprint: null })),
    previewTestBlueprint: jest.fn(async () => ({ sections: [] })),
};
const workstationFns = {
    registerTestWorkstation: jest.fn(async () => ({ workstation: { id: 1 }, deviceToken: "t" })),
    listTestWorkstations: jest.fn(async () => ({ items: [] })),
    revokeTestWorkstation: jest.fn(async () => ({ revoked: true })),
    rotateTestWorkstationToken: jest.fn(async () => ({ deviceToken: "t2" })),
};

jest.unstable_mockModule("../../../src/services/test-blueprint.service.js", () => ({ APPROVAL_ROLES: ["HIRING_MANAGER", "HR"], ...blueprintFns }));
jest.unstable_mockModule("../../../src/services/test-workstation.service.js", () => ({ WORKSTATION_STATUS: { ACTIVE: "ACTIVE", REVOKED: "REVOKED" }, ...workstationFns }));

const { registerTestBlueprintTools } = await import("../../../src/mcp/tools/test-blueprint.tools.js");
const { registerTestWorkstationTools } = await import("../../../src/mcp/tools/test-workstation.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
const server = {
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, z.object(schema));
    },
};
registerTestBlueprintTools(server);
registerTestWorkstationTools(server);

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTHOR = { userId: "5", roles: ["ASSESSMENT_AUTHOR"], isAdmin: false, employeeId: 50, tenantId: TENANT };
const grant = (action) => ({ "hr:recruitment": [action] });
const call = (name, args, { user = AUTHOR, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const sections = [{ competencyKey: "a", itemCount: 2 }, { competencyKey: "b", itemCount: 2 }];
const TOOLS = [
    ["hr_test_blueprints_list", "VIEW", {}, "listTestBlueprints"],
    ["hr_test_blueprint_get", "VIEW", { blueprintId: 1 }, "getTestBlueprint"],
    ["hr_test_blueprint_create", "CREATE", { name: "T", sections }, "createTestBlueprint"],
    ["hr_test_blueprint_update", "EDIT", { blueprintId: 1, passMarkPct: 70 }, "updateTestBlueprint"],
    ["hr_test_blueprint_approve", "EDIT", { blueprintId: 1, as: "HR" }, "approveTestBlueprint"],
    ["hr_test_blueprint_publish", "EDIT", { blueprintId: 1 }, "publishTestBlueprint"],
    ["hr_test_blueprint_link", "EDIT", { blueprintId: 1, scopeType: "REQUISITION", scopeId: 21 }, "linkTestBlueprint"],
    ["hr_test_blueprint_resolve", "VIEW", { requisitionId: 21 }, "resolveTestBlueprint"],
    ["hr_test_blueprint_preview", "VIEW", { blueprintId: 1 }, "previewTestBlueprint"],
    ["hr_test_workstation_register", "CREATE", { label: "Desk", siteRef: "LHR" }, "registerTestWorkstation"],
    ["hr_test_workstations_list", "VIEW", {}, "listTestWorkstations"],
    ["hr_test_workstation_revoke", "EDIT", { workstationId: 1, reason: "lost" }, "revokeTestWorkstation"],
    ["hr_test_workstation_rotate", "EDIT", { workstationId: 1 }, "rotateTestWorkstationToken"],
];
const fns = { ...blueprintFns, ...workstationFns };

beforeEach(() => jest.clearAllMocks());

describe("registration and permission method", () => {
    it("registers exactly the thirteen Phase 3b blueprint and workstation tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([name]) => name).sort());
    });

    it.each(TOOLS)("%s requires hr:recruitment %s", async (name, action, args, fn) => {
        const denied = await call(name, args, { permissions: {} });
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrong.isError).toBe(true);
        expect(fns[fn]).not.toHaveBeenCalled();
        const ok = await call(name, args, { permissions: grant(action) });
        expect(ok.isError).toBeUndefined();
        expect(fns[fn]).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT,
            access: expect.objectContaining({ author: true, recruiter: false, admin: false }),
        }));
    });
});

describe("what the tools hand their services", () => {
    it("create passes the input, actor and access", async () => {
        await call("hr_test_blueprint_create", { name: "T", sections, jobFamily: "Finance" }, { permissions: grant("CREATE") });
        expect(blueprintFns.createTestBlueprint).toHaveBeenCalledWith(expect.objectContaining({
            actorId: 50,
            input: expect.objectContaining({ name: "T", jobFamily: "Finance", sections: expect.any(Array) }),
        }));
    });

    it("update separates the id from the fields", async () => {
        const args0 = schemas.get("hr_test_blueprint_update").parse({ blueprintId: "4", durationMin: "45" });
        await call("hr_test_blueprint_update", args0, { permissions: grant("EDIT") });
        const [[args]] = blueprintFns.updateTestBlueprint.mock.calls;
        expect(args).toMatchObject({ blueprintId: 4, input: { durationMin: 45 } });
        expect(args.input).not.toHaveProperty("blueprintId");
    });

    it("the input schemas refuse an unknown approval role, scope or a single section", () => {
        expect(schemas.get("hr_test_blueprint_approve").safeParse({ blueprintId: 1, as: "CEO" }).success).toBe(false);
        expect(schemas.get("hr_test_blueprint_link").safeParse({ blueprintId: 1, scopeType: "STAGE" }).success).toBe(false);
        expect(schemas.get("hr_test_blueprint_create").safeParse({ name: "T", sections: [sections[0]] }).success).toBe(false);
        expect(schemas.get("hr_test_blueprint_create").safeParse({ name: "T", sections }).success).toBe(true);
    });

    it("an admin's register reaches the service with the admin capability", async () => {
        const ADMIN = { ...AUTHOR, roles: ["HR_ADMIN"], employeeId: 8 };
        const res = await call("hr_test_workstation_register", { label: "Desk", siteRef: "LHR" }, { user: ADMIN, permissions: grant("CREATE") });
        expect(parse(res)).toEqual({ workstation: { id: 1 }, deviceToken: "t" });
        expect(workstationFns.registerTestWorkstation).toHaveBeenCalledWith(expect.objectContaining({ actorId: 8, access: expect.objectContaining({ admin: true }) }));
    });
});
