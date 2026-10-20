// tests/unit/mcp/candidate-duplicate.tools.test.js
//
// Recruitment Phase 2 — the duplicate-candidate tools: registration, the
// hr:recruitment method gate, dispatch with the caller's tenant/scope/actor,
// and the flag/scope errors surfacing as tool errors. Services are mocked.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const listDuplicateSuggestions = jest.fn(async () => ({ items: [{ id: 5 }], total: 1, page: 1, pageSize: 20 }));
const resolveDuplicateSuggestion = jest.fn(async () => ({ id: 5, status: "DISMISSED" }));
const detectCandidateDuplicates = jest.fn(async () => ({ candidateId: 10, created: 1 }));

jest.unstable_mockModule("../../../src/services/candidate-duplicate.service.js", () => ({
    listDuplicateSuggestions,
    resolveDuplicateSuggestion,
    detectCandidateDuplicates,
}));

const { registerCandidateDuplicateTools } = await import("../../../src/mcp/tools/candidate-duplicate.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerCandidateDuplicateTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = { userId: "7", roles: ["HR_ADMIN"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const call = (name, args, permissions, user = USER) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    { name: "hr_candidate_duplicate_list", action: "VIEW", args: {} },
    { name: "hr_candidate_duplicate_resolve", action: "EDIT", args: { id: 5, action: "DISMISS" } },
    { name: "hr_candidate_duplicate_detect", action: "CREATE", args: { candidateId: 10 } },
];

beforeEach(() => jest.clearAllMocks());

describe("registration and gate", () => {
    it("registers exactly the three tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map((t) => t.name).sort());
    });

    it.each(TOOLS)("$name is denied without the hr:recruitment grant", async ({ name, args }) => {
        const res = await call(name, args, {});
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(403);
    });

    it.each(TOOLS)("$name dispatches with its method's grant", async ({ name, action, args }) => {
        const res = await call(name, args, { "hr:recruitment": [action] });
        expect(res.isError).toBeFalsy();
    });
});

describe("dispatch", () => {
    it("list passes the tenant, ORG scope and filters and returns the list envelope", async () => {
        const res = await call("hr_candidate_duplicate_list", { candidateId: 10 }, { "hr:recruitment": ["VIEW"] });
        expect(listDuplicateSuggestions).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT, status: "OPEN", candidateId: 10, scope: expect.objectContaining({ level: "ORG" }),
        }));
        expect(parse(res)).toMatchObject({ items: [{ id: 5 }], total: 1 });
    });

    it("resolve passes the verified actor, never a tool argument", async () => {
        await call("hr_candidate_duplicate_resolve", { id: 5, action: "MERGE", survivorId: 3, actorId: 999 }, { "hr:recruitment": ["EDIT"] });
        expect(resolveDuplicateSuggestion).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT, id: 5, action: "MERGE", survivorId: 3, actorId: 7, keepSurvivorOnConflict: false, expectedStatus: "OPEN",
        }));
    });

    it("resolve MERGE without a survivor is a 400 before the service", async () => {
        const res = await call("hr_candidate_duplicate_resolve", { id: 5, action: "MERGE" }, { "hr:recruitment": ["EDIT"] });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(400);
        expect(resolveDuplicateSuggestion).not.toHaveBeenCalled();
    });

    it("a narrower scope reaches the service as non-ORG (the service refuses it)", async () => {
        const manager = { ...USER, roles: ["HIRING_MANAGER"] };
        await call("hr_candidate_duplicate_detect", { candidateId: 10 }, { "hr:recruitment": ["CREATE"] }, manager);
        expect(detectCandidateDuplicates.mock.calls[0][0].scope).toMatchObject({ level: "MANAGED", unrestricted: false });
    });

    it("detect surfaces the flag-off 503", async () => {
        detectCandidateDuplicates.mockRejectedValueOnce(
            Object.assign(new Error("Duplicate candidate detection is disabled"), { status: 503, code: "HR-RECRUITMENT-DUPLICATES-DISABLED" }),
        );
        const res = await call("hr_candidate_duplicate_detect", { candidateId: 10 }, { "hr:recruitment": ["CREATE"] });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(503);
    });
});
