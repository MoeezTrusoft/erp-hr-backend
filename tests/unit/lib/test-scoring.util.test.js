// tests/unit/lib/test-scoring.util.test.js — Phase 3b item scoring rule.
import { describe, it, expect } from "@jest/globals";

import { isAnswerShapeValid, scoreItemAnswer } from "../../../src/lib/test-scoring.util.js";

const single = { type: "SINGLE", answerKey: { optionIds: ["b"] } };
const multi = { type: "MULTI", answerKey: { optionIds: ["a", "c"] } };
const partial = { ...multi, scoringRule: { multi: "PARTIAL" } };
const numeric = { type: "NUMERIC", answerKey: { value: 12.5, tolerance: 0.5 } };

describe("scoreItemAnswer", () => {
    it("treats a missing answer as unanswered", () => {
        expect(scoreItemAnswer(single, null)).toEqual({ answered: false, correct: false, credit: 0 });
        expect(scoreItemAnswer(single, undefined).answered).toBe(false);
    });

    it("scores single-choice, image and true/false items", () => {
        expect(scoreItemAnswer(single, { optionId: "b" })).toEqual({ answered: true, correct: true, credit: 1 });
        expect(scoreItemAnswer(single, { optionId: "a" })).toEqual({ answered: true, correct: false, credit: 0 });
        expect(scoreItemAnswer({ type: "TRUE_FALSE", answerKey: { optionIds: ["true"] } }, { optionId: "true" }).correct).toBe(true);
        expect(scoreItemAnswer({ type: "IMAGE_SINGLE", answerKey: { optionIds: [3] } }, { optionId: 3 }).correct).toBe(true);
    });

    it("scores multi all-or-nothing by default", () => {
        expect(scoreItemAnswer(multi, { optionIds: ["c", "a"] }).credit).toBe(1);
        expect(scoreItemAnswer(multi, { optionIds: ["a"] })).toMatchObject({ correct: false, credit: 0 });
        expect(scoreItemAnswer(multi, { optionIds: ["a", "b", "c"] })).toMatchObject({ correct: false, credit: 0 });
    });

    it("gives partial credit when the item says so, never below zero", () => {
        expect(scoreItemAnswer(partial, { optionIds: ["a"] }).credit).toBe(0.5);
        expect(scoreItemAnswer(partial, { optionIds: ["a", "b"] }).credit).toBe(0);
        expect(scoreItemAnswer(partial, { optionIds: ["b", "d"] }).credit).toBe(0);
        expect(scoreItemAnswer(partial, { optionIds: ["a", "c"] })).toMatchObject({ correct: true, credit: 1 });
    });

    it("scores numeric answers within the tolerance", () => {
        expect(scoreItemAnswer(numeric, { value: 12.9 }).correct).toBe(true);
        expect(scoreItemAnswer(numeric, { value: 13.1 }).correct).toBe(false);
        expect(scoreItemAnswer({ type: "NUMERIC", answerKey: { value: 3 } }, { value: 3 }).correct).toBe(true);
    });

    it("scores an ill-formed answer as wrong, and validates shapes", () => {
        expect(scoreItemAnswer(single, { optionIds: ["b"] })).toEqual({ answered: true, correct: false, credit: 0 });
        expect(isAnswerShapeValid("MULTI", { optionIds: [] })).toBe(false);
        expect(isAnswerShapeValid("NUMERIC", { value: "3" })).toBe(false);
        expect(isAnswerShapeValid("NUMERIC", { value: Number.NaN })).toBe(false);
        expect(isAnswerShapeValid("SINGLE", [])).toBe(false);
        expect(isAnswerShapeValid("ESSAY", { text: "x" })).toBe(false);
    });
});
