// Phase 3b — the item bank tools: registration, the HTTP method each checks on
// hr:recruitment, and the tenant and assessment access each hands its service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { z } from "zod";

const ok = (name) => jest.fn(async () => ({ ok: name }));
const services = {
    listTestItems: ok("list"),
    getTestItem: ok("get"),
    createTestItem: ok("create"),
    updateTestItem: ok("update"),
    submitTestItemForReview: ok("submit"),
    decideTestItemReview: ok("decide"),
    retireTestItem: ok("retire"),
    getTestItemStats: ok("stats"),
    draftTestItemsWithAi: ok("draft"),
};
const importTestItems = ok("import");

jest.unstable_mockModule("../../../src/services/test-item.service.js", () => ({ REVIEW_DECISIONS: ["PUBLISH", "RETURN"], ...services }));
jest.unstable_mockModule("../../../src/services/test-item-import.service.js", () => ({ importTestItems }));

const { registerTestItemTools } = await import("../../../src/mcp/tools/test-item.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
registerTestItemTools({
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, z.object(schema));
    },
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTHOR = { userId: "1", roles: ["ASSESSMENT_AUTHOR"], isAdmin: false, employeeId: 11, tenantId: TENANT };
const grant = (action) => ({ "hr:recruitment": [action] });
const call = (name, args, { user = AUTHOR, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_test_items_list", "VIEW", {}, services.listTestItems],
    ["hr_test_item_get", "VIEW", { itemId: 5 }, services.getTestItem],
    ["hr_test_item_create", "CREATE", { type: "SINGLE", stem: "Q" }, services.createTestItem],
    ["hr_test_item_update", "EDIT", { itemId: 5, stem: "Q2" }, services.updateTestItem],
    ["hr_test_item_submit_review", "EDIT", { itemId: 5 }, services.submitTestItemForReview],
    ["hr_test_item_review_decide", "EDIT", { itemId: 5, decision: "PUBLISH" }, services.decideTestItemReview],
    ["hr_test_item_retire", "EDIT", { itemId: 5, reason: "Old" }, services.retireTestItem],
    ["hr_test_items_import", "CREATE", { contentBase64: "YQ==" }, importTestItems],
    ["hr_test_item_draft_ai", "CREATE", { competencyKeys: ["x"] }, services.draftTestItemsWithAi],
    ["hr_test_item_stats_get", "VIEW", { itemId: 5 }, services.getTestItemStats],
];

beforeEach(() => jest.clearAllMocks());

describe("registration and permission method", () => {
    it("registers exactly the ten item bank tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([name]) => name).sort());
    });

    it.each(TOOLS)("%s requires hr:recruitment %s", async (name, action, args, service) => {
        const denied = await call(name, args, { permissions: {} });
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrong.isError).toBe(true);
        expect(service).not.toHaveBeenCalled();
        const res = await call(name, args, { permissions: grant(action) });
        expect(res.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT,
            access: expect.objectContaining({ author: true, reviewer: false, employeeId: 11 }),
        }));
    });
});

describe("input schemas", () => {
    it("accept a full item and refuse out-of-range values", () => {
        const create = schemas.get("hr_test_item_create");
        const parsed = create.parse({
            type: "MULTI", stem: "Q", options: [{ id: "a", text: "1", feedback: "f" }, { id: 2, text: "2" }], answerKey: { optionIds: ["a", 2] },
            scoringRule: { multi: "PARTIAL" }, difficulty: "HARD", competencyKey: "x", gradeLevelIds: ["3"], timeEstimateSec: "60", mediaId: null,
        });
        expect(parsed).toMatchObject({ gradeLevelIds: [3], timeEstimateSec: 60, mediaId: null });
        expect(create.safeParse({ type: "ESSAY" }).success).toBe(false);
        expect(schemas.get("hr_test_item_draft_ai").safeParse({ count: 11 }).success).toBe(false);
        expect(schemas.get("hr_test_item_draft_ai").safeParse({ types: ["IMAGE_SINGLE"] }).success).toBe(false);
        expect(schemas.get("hr_test_item_review_decide").safeParse({ itemId: 1, decision: "MAYBE" }).success).toBe(false);
        expect(schemas.get("hr_test_items_import").safeParse({ contentBase64: "x".repeat(3_000_000) }).success).toBe(false);
    });
});

describe("what each tool hands its service", () => {
    it("update splits the id from the patch; create passes the input", async () => {
        await call("hr_test_item_update", { itemId: 5, stem: "Q2", difficulty: "HARD" }, { permissions: grant("EDIT") });
        expect(services.updateTestItem).toHaveBeenCalledWith(expect.objectContaining({ itemId: 5, patch: { stem: "Q2", difficulty: "HARD" } }));
        await call("hr_test_item_create", { type: "NUMERIC", stem: "Q", answerKey: { value: 3 } }, { permissions: grant("CREATE") });
        expect(services.createTestItem).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ type: "NUMERIC", answerKey: { value: 3 } }) }));
    });

    it("import defaults dryRun to false; a service refusal is a tool error", async () => {
        await call("hr_test_items_import", { contentBase64: "YQ==", format: "csv" }, { permissions: grant("CREATE") });
        expect(importTestItems).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, format: "csv" }));
        services.decideTestItemReview.mockRejectedValueOnce(Object.assign(new Error("You cannot review an item you wrote"), { status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FOUR-EYES" }));
        const res = await call("hr_test_item_review_decide", { itemId: 5, decision: "PUBLISH" }, { permissions: grant("EDIT") });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(403);
    });
});
