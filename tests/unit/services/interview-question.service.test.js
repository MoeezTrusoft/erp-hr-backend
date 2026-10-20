// tests/unit/services/interview-question.service.test.js
//
// Recruitment Phase 3b — the interview question bank: drafts change in place,
// a published version is immutable (a change is the next version), retiring
// retires every version of the key, and lists show the latest version.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createFakeDb } from "./helpers/evaluation-form.fake.js";

const { db, store } = createFakeDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const bank = await import("../../../src/services/interview-question.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "66666666-6666-4666-8666-666666666666";
const as = (fn) => mcpCtx.run({ user: { tenantId: T } }, async () => await fn());

beforeEach(() => {
    for (const key of Object.keys(store)) store[key].length = 0;
});

describe("interview question bank", () => {
    it("creates DRAFT or PUBLISHED questions with a minted key; a taken key is a conflict", async () => {
        const q = await as(() => bank.createQuestion({ tenantId: T, competencyKey: "SQL Skills", prompt: "Explain a join", followUps: ["Outer?"], level: "mid" }));
        expect(q).toMatchObject({ version: 1, status: "DRAFT", level: "MID", followUps: ["Outer?"] });
        expect(q.questionKey).toMatch(/^sql-skills-[0-9a-f]{6}$/);
        const p = await as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "Index?", questionKey: "q-idx", publish: true }));
        expect(p.status).toBe("PUBLISHED");
        await expect(as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "x", questionKey: "q-idx" }))).rejects.toMatchObject({ status: 409 });
        await expect(as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: " " }))).rejects.toMatchObject({ status: 400 });
    });

    it("a DRAFT changes in place; a PUBLISHED version is immutable and a change is the next version", async () => {
        const d = await as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "v1", questionKey: "q1" }));
        await as(() => bank.updateQuestion({ tenantId: T, questionId: d.id, prompt: "v1b", status: "PUBLISHED" }));
        expect(store.questions).toHaveLength(1);
        expect(store.questions[0]).toMatchObject({ prompt: "v1b", status: "PUBLISHED" });
        expect(await as(() => bank.updateQuestion({ tenantId: T, questionId: d.id, prompt: "v1b" }))).toMatchObject({ id: d.id });
        const v2 = await as(() => bank.updateQuestion({ tenantId: T, questionId: d.id, prompt: "v2" }));
        expect(v2).toMatchObject({ newVersion: true, version: 2, status: "DRAFT", questionKey: "q1", prompt: "v2", previousVersionId: d.id });
        expect(store.questions.find((x) => x.id === d.id).prompt).toBe("v1b");
        const latest = await as(() => bank.listQuestions({ tenantId: T }));
        expect(latest.items.map((x) => x.version)).toEqual([2]);
        expect((await as(() => bank.listQuestions({ tenantId: T, latestOnly: false }))).total).toBe(2);
    });

    it("retiring retires every version, and a retired question cannot change", async () => {
        const d = await as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "v1", questionKey: "q1", publish: true }));
        await as(() => bank.updateQuestion({ tenantId: T, questionId: d.id, prompt: "v2", status: "PUBLISHED" }));
        expect(await as(() => bank.retireQuestion({ tenantId: T, questionId: d.id }))).toEqual({ questionKey: "q1", retiredVersions: 2 });
        expect(store.questions.every((x) => x.status === "RETIRED")).toBe(true);
        await expect(as(() => bank.updateQuestion({ tenantId: T, questionId: d.id, prompt: "v3" }))).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-QUESTION-RETIRED" });
    });

    it("publishedQuestionsFor returns the latest PUBLISHED version by key and per competency", async () => {
        const a = await as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "a1", questionKey: "qa", publish: true }));
        await as(() => bank.updateQuestion({ tenantId: T, questionId: a.id, prompt: "a2", status: "PUBLISHED" }));
        await as(() => bank.createQuestion({ tenantId: T, competencyKey: "sql", prompt: "draft", questionKey: "qd" }));
        const out = await as(() => bank.publishedQuestionsFor(db, T, { keys: ["qa", "qd"], competencyKeys: ["sql"] }));
        expect(out.byKey.qa.prompt).toBe("a2");
        expect(out.byKey).not.toHaveProperty("qd");
        expect(out.byCompetency.sql.map((q) => q.prompt)).toEqual(["a2"]);
    });
});
