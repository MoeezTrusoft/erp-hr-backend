// Phase 2 — HR's ai:tasks writer emits the strict AiTaskV1 of
// @trusoft/contracts/ai-tasks (module "hr", a uuid tenant, the type grammar,
// no extra field), validated before the XADD; and a result that missed the
// wait window can be collected later by task id.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";

const added = [];
let results = [];
const client = {
    on: jest.fn(),
    connect: jest.fn(async () => {}),
    quit: jest.fn(async () => {}),
    xInfoStream: jest.fn(async () => ({ lastGeneratedId: "100-0" })),
    xAdd: jest.fn(async (stream, id, fields) => {
        added.push({ stream, fields });
        return "101-0";
    }),
    xRead: jest.fn(async () => {
        const taskId = added.at(-1)?.fields.taskId;
        return [{ name: "ai:results", messages: [{ id: "102-0", message: { taskId, tenantId: TENANT, status: "ok", output: JSON.stringify({ result: "```json\n{\"skills\":[]}\n```" }), tokensUsed: "12" } }] }];
    }),
    xRange: jest.fn(async () => results),
};

jest.unstable_mockModule("redis", () => ({ createClient: () => client }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { AiTaskV1 } = await import("@trusoft/contracts/ai-tasks");
const plane = await import("../../../src/lib/aiPlaneClient.js");

const asTask = (fields) => ({ ...fields, input: JSON.parse(fields.input) });

beforeEach(() => {
    process.env.REDIS_URL = "redis://test";
    added.length = 0;
    results = [];
    jest.clearAllMocks();
});

afterAll(async () => {
    await plane.closeAiPlaneTransport();
    delete process.env.REDIS_URL;
});

describe("the task HR writes to ai:tasks", () => {
    it("parses as a strict AiTaskV1 with module hr", async () => {
        const res = await plane.runAiTask({
            promptKey: "hr.resume.parse.v1",
            type: "hr.resume.parse",
            tenantId: TENANT,
            input: { resumeText: "some text" },
            correlationId: "a".repeat(64),
        });
        expect(added).toHaveLength(1);
        const task = AiTaskV1.parse(asTask(added[0].fields));
        expect(task).toMatchObject({ module: "hr", tenantId: TENANT, type: "hr.resume.parse", promptKey: "hr.resume.parse.v1", correlationId: "a".repeat(64) });
        expect(Object.keys(added[0].fields).sort()).toEqual(["correlationId", "input", "module", "promptKey", "taskId", "tenantId", "type"]);
        // The answer is matched by task id and de-fenced.
        expect(res).toMatchObject({ status: "ok", tokensUsed: 12, output: { result: { skills: [] } } });
    });

    it("folds a legacy type onto the contract grammar (candidate match)", async () => {
        await plane.runAiTask({ promptKey: "hr.candidate.match.v1", type: "hr.candidate-match", tenantId: TENANT, input: {}, correlationId: "match:1:2" });
        expect(AiTaskV1.parse(asTask(added[0].fields)).type).toBe("hr.candidate_match");
    });

    it("refuses a task without a uuid tenant BEFORE anything is published", async () => {
        await expect(plane.runAiTask({ promptKey: "hr.resume.parse.v1", tenantId: null, input: {} }))
            .rejects.toMatchObject({ status: 400, code: "HR-AI-PLANE-BAD-REQUEST" });
        await expect(plane.runAiTask({ promptKey: "hr.resume.parse.v1", tenantId: "tenant-a", input: {} }))
            .rejects.toMatchObject({ code: "HR-AI-PLANE-BAD-REQUEST" });
        expect(client.xAdd).not.toHaveBeenCalled();
    });

    it("returns the results cursor with a pending answer so it can be collected later", async () => {
        client.xRead.mockResolvedValue(null);
        const res = await plane.runAiTask({ promptKey: "hr.resume.parse.v1", tenantId: TENANT, input: {}, waitMs: 1 });
        expect(res).toMatchObject({ status: "pending", pending: true, sinceId: "100-0" });
        expect(res.taskId).toBe(added[0].fields.taskId);
    });
});

describe("collectAiResult", () => {
    it("finds a late answer by task id from the stored cursor", async () => {
        results = [
            { id: "100-0", message: { taskId: "other", status: "ok" } },
            { id: "103-0", message: { taskId: "t-late", status: "ok", output: JSON.stringify({ result: { skills: [{ name: "Go" }] } }), tokensUsed: "9" } },
        ];
        const res = await plane.collectAiResult({ taskId: "t-late", sinceId: "100-0" });
        expect(client.xRange).toHaveBeenCalledWith("ai:results", "100-0", "+", { COUNT: 200 });
        expect(res).toMatchObject({ taskId: "t-late", status: "ok", output: { result: { skills: [{ name: "Go" }] } } });
    });

    it("reports pending when the answer is not (or no longer) on the stream", async () => {
        results = [{ id: "100-0", message: { taskId: "other", status: "ok" } }];
        await expect(plane.collectAiResult({ taskId: "t-gone", sinceId: "100-0" })).resolves.toMatchObject({ pending: true });
    });
});
