// tests/unit/recruitment-knockout.questions.test.js
//
// Recruitment Phase 2 — knockout questions:
//
//   * the rule is validated per type ({ values } for choice/BOOLEAN, { min,max }
//     for NUMBER), only on a REQUIRED question, never on an unsupported type,
//     never covering every answer — and the service answers a bad rule with
//     HR-RECRUITMENT-KNOCKOUT-RULE-INVALID;
//   * validateAnswer reports knockedOut per answer; scoreAnswers rolls the set
//     up into answerScore / answerMaxScore / knockedOut / knockoutQuestionIds.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
    jobRequisition: { findFirst: jest.fn(async () => ({ id: 42, status: "DRAFT" })) },
    applicationQuestion: {
        findFirst: jest.fn(),
        create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
        update: jest.fn(async ({ data }) => ({ id: 1, ...data })),
        aggregate: jest.fn(async () => ({ _max: { orderIndex: null } })),
    },
};
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));

const { Prisma } = await import("@prisma/client");
const { validateQuestionDefinition, validateAnswer, scoreAnswers, isKnockedOut } = await import("../../src/lib/application-questions.util.js");
const { createQuestion, updateQuestion } = await import("../../src/services/application-question.service.js");

const choice = (overrides = {}) => ({
    type: "SINGLE_CHOICE",
    prompt: "Can you work on site?",
    required: true,
    options: [{ value: "yes" }, { value: "no" }, { value: "sometimes" }],
    knockout: true,
    knockoutRule: { values: ["no"] },
    ...overrides,
});

describe("knockout rule validation", () => {
    it("accepts a choice rule naming existing options and normalizes it", () => {
        const r = validateQuestionDefinition(choice({ knockoutRule: { values: [" no ", "no"] } }));
        expect(r.ok).toBe(true);
        expect(r.normalized).toMatchObject({ knockout: true, knockoutRule: { values: ["no"] } });
    });

    it("accepts a MULTI_CHOICE rule and a BOOLEAN rule (string booleans normalized)", () => {
        expect(validateQuestionDefinition(choice({ type: "MULTI_CHOICE" })).ok).toBe(true);
        const b = validateQuestionDefinition({ type: "BOOLEAN", prompt: "Permit?", required: true, knockout: true, knockoutRule: { values: ["false"] } });
        expect(b.ok).toBe(true);
        expect(b.normalized.knockoutRule).toEqual({ values: [false] });
    });

    it("accepts a NUMBER band with either bound", () => {
        const n = (rule) => validateQuestionDefinition({ type: "NUMBER", prompt: "Years?", required: true, knockout: true, knockoutRule: rule });
        expect(n({ min: 2 }).normalized.knockoutRule).toEqual({ min: 2, max: null });
        expect(n({ max: "10" }).normalized.knockoutRule).toEqual({ min: null, max: 10 });
        expect(n({ min: 2, max: 10 }).ok).toBe(true);
    });

    it.each([
        ["an unknown option", choice({ knockoutRule: { values: ["maybe"] } })],
        ["an empty values list", choice({ knockoutRule: { values: [] } })],
        ["every answer", choice({ knockoutRule: { values: ["yes", "no", "sometimes"] } })],
        ["min/max on a choice", choice({ knockoutRule: { min: 1 } })],
        ["values on a NUMBER", { type: "NUMBER", prompt: "Y?", required: true, knockout: true, knockoutRule: { values: [1] } }],
        ["an empty NUMBER rule", { type: "NUMBER", prompt: "Y?", required: true, knockout: true, knockoutRule: {} }],
        ["min > max", { type: "NUMBER", prompt: "Y?", required: true, knockout: true, knockoutRule: { min: 5, max: 1 } }],
        ["a non-numeric bound", { type: "NUMBER", prompt: "Y?", required: true, knockout: true, knockoutRule: { min: "a" } }],
        ["both booleans", { type: "BOOLEAN", prompt: "P?", required: true, knockout: true, knockoutRule: { values: [true, false] } }],
        ["a missing rule", choice({ knockoutRule: undefined })],
        ["an optional question", choice({ required: false })],
        ["an unsupported type", { type: "TEXT_SHORT", prompt: "Why?", required: true, knockout: true, knockoutRule: { values: ["x"] } }],
        ["a rule without the flag", choice({ knockout: false })],
    ])("rejects %s", (_label, input) => {
        const r = validateQuestionDefinition(input);
        expect(r.ok).toBe(false);
        expect(r.knockoutErrors.length).toBeGreaterThan(0);
    });

    it("a plain question carries knockout false and no rule", () => {
        const r = validateQuestionDefinition({ type: "TEXT_SHORT", prompt: "Why us?" });
        expect(r.ok).toBe(true);
        expect(r.normalized).toMatchObject({ knockout: false, knockoutRule: null });
        expect(r.knockoutErrors).toEqual([]);
    });
});

describe("question service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.applicationQuestion.findFirst.mockResolvedValue(null);
    });

    it("persists the knockout flag and rule on create", async () => {
        await createQuestion(42, "t-1", choice());
        expect(prisma.applicationQuestion.create.mock.calls[0][0].data).toMatchObject({
            knockout: true,
            knockoutRule: { values: ["no"] },
        });
    });

    it("refuses a bad rule with the knockout-specific code", async () => {
        await expect(createQuestion(42, "t-1", choice({ required: false }))).rejects.toMatchObject({
            status: 400,
            code: "HR-RECRUITMENT-KNOCKOUT-RULE-INVALID",
        });
        await expect(createQuestion(42, "t-1", { type: "NOPE", prompt: "x" })).rejects.toMatchObject({
            status: 400,
            code: "HR-RECRUITMENT-QUESTION-INVALID",
        });
    });

    it("turning knockout off on update clears the stored rule", async () => {
        prisma.applicationQuestion.findFirst.mockResolvedValueOnce({
            id: 1,
            ...choice(),
            orderIndex: 0,
            isActive: true,
            _count: { answers: 0 },
        });
        await updateQuestion(42, "t-1", 1, { knockout: false });
        const data = prisma.applicationQuestion.update.mock.calls[0][0].data;
        expect(data.knockout).toBe(false);
        expect(data.knockoutRule).toBe(Prisma.DbNull);
    });

    it("making a knockout question optional is refused while knockout stays on", async () => {
        prisma.applicationQuestion.findFirst.mockResolvedValueOnce({ id: 1, ...choice(), orderIndex: 0, isActive: true, _count: { answers: 0 } });
        await expect(updateQuestion(42, "t-1", 1, { required: false })).rejects.toMatchObject({
            code: "HR-RECRUITMENT-KNOCKOUT-RULE-INVALID",
        });
    });
});

describe("answers and the roll-up", () => {
    const stored = (input) => ({ id: 9, ...validateQuestionDefinition(input).normalized });

    it("knocks out on a listed choice, a multi selection that includes one, and a listed boolean", () => {
        expect(validateAnswer(stored(choice()), "no").knockedOut).toBe(true);
        expect(validateAnswer(stored(choice()), "yes").knockedOut).toBe(false);
        expect(validateAnswer(stored(choice({ type: "MULTI_CHOICE" })), ["yes", "no"]).knockedOut).toBe(true);
        expect(validateAnswer(stored(choice({ type: "MULTI_CHOICE" })), ["yes"]).knockedOut).toBe(false);
        const permit = stored({ type: "BOOLEAN", prompt: "P?", required: true, knockout: true, knockoutRule: { values: [false] } });
        expect(validateAnswer(permit, false).knockedOut).toBe(true);
        expect(validateAnswer(permit, true).knockedOut).toBe(false);
    });

    it("knocks out a NUMBER outside the band, on either side, inclusive bounds pass", () => {
        const years = stored({ type: "NUMBER", prompt: "Y?", required: true, knockout: true, knockoutRule: { min: 2, max: 10 } });
        expect(validateAnswer(years, 1).knockedOut).toBe(true);
        expect(validateAnswer(years, 11).knockedOut).toBe(true);
        expect(validateAnswer(years, 2).knockedOut).toBe(false);
        expect(validateAnswer(years, 10).knockedOut).toBe(false);
    });

    it("never knocks out an invalid answer, or a question that is not a required knockout", () => {
        expect(validateAnswer(stored(choice()), "maybe")).toMatchObject({ ok: false, knockedOut: false });
        expect(isKnockedOut({ type: "SINGLE_CHOICE", required: false, knockout: true, knockoutRule: { values: ["no"] } }, "no")).toBe(false);
        expect(isKnockedOut({ type: "SINGLE_CHOICE", required: true, knockout: false, knockoutRule: { values: ["no"] } }, "no")).toBe(false);
    });

    it("scoreAnswers sums the scored answers against every scored question's ceiling", () => {
        const questions = [
            { id: 1, weights: { yes: 2 }, maxScore: 2 },
            { id: 2, weights: { a: 1.5, b: 3 }, maxScore: 4.5 },
            { id: 3, weights: null, maxScore: null },
        ];
        const answers = [
            { questionId: 1, score: 2, knockedOut: false },
            { questionId: 2, score: 1.5, knockedOut: true },
            { questionId: 3, score: null, knockedOut: false },
        ];
        expect(scoreAnswers(questions, answers)).toEqual({
            answerScore: 4,
            answerMaxScore: 7,
            knockedOut: true,
            knockoutQuestionIds: [2],
        });
    });

    it("scoreAnswers leaves the totals null when nothing is scored", () => {
        expect(scoreAnswers([{ id: 1, weights: null }], [{ questionId: 1, score: null }])).toEqual({
            answerScore: null,
            answerMaxScore: null,
            knockedOut: false,
            knockoutQuestionIds: [],
        });
    });
});
