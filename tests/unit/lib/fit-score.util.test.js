// tests/unit/lib/fit-score.util.test.js
//
// Recruitment Phase 2 (§6.4) — the deterministic fit score: coverage maths,
// renormalisation when a component is not assessed, the knockout cap, the
// bands, determinism and the inputsHash.
import { describe, it, expect } from "@jest/globals";

import {
    computeFitScore,
    componentsAssessed,
    fitBand,
    FIT_MODEL_VERSION,
    KNOCKOUT_SCORE_CAP,
} from "../../../src/lib/fit-score.util.js";
import { buildAliasIndex } from "../../../src/lib/skill-normalization.util.js";

const INDEX = buildAliasIndex(
    [{ alias: "JS", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null }],
    [
        { id: 1, name: "JavaScript", tenantId: null },
        { id: 2, name: "React", tenantId: null },
        { id: 3, name: "SQL", tenantId: null },
        { id: 4, name: "Kubernetes", tenantId: null },
    ],
    "t-1",
);

const BASE = {
    requiredSkills: ["JavaScript", "SQL"],
    preferredSkills: ["React", "Kubernetes"],
    candidateSkills: ["JS", "SQL", "React"],
    candidateYears: 4,
    minYears: 5,
    knockedOut: false,
    answerScore: 6,
    answerMaxScore: 10,
};

const component = (result, key) => result.components.find((c) => c.key === key);

describe("computeFitScore — the formula", () => {
    it("weights required 50, preferred 20, experience 15 and answers 15", () => {
        const result = computeFitScore(BASE, { aliasIndex: INDEX });
        // required 2/2, preferred 1/2, experience 4/5, answers 6/10
        // (50*1 + 20*0.5 + 15*0.8 + 15*0.6) / 100 = 0.81
        expect(result.score).toBe(81);
        expect(result.band).toBe("STRONG");
        expect(result.modelVersion).toBe(FIT_MODEL_VERSION);
        expect(component(result, "requiredSkills")).toMatchObject({ weight: 50, value: 1, assessed: true });
        expect(component(result, "preferredSkills")).toMatchObject({ weight: 20, value: 0.5, assessed: true });
        expect(component(result, "experience")).toMatchObject({ weight: 15, value: 0.8, assessed: true });
        expect(component(result, "screeningAnswers")).toMatchObject({ weight: 15, value: 0.6, assessed: true });
        expect(result.assessed).toBe(true);
    });

    it("matches through the taxonomy aliases (JS is JavaScript)", () => {
        const result = computeFitScore({ ...BASE, requiredSkills: ["JavaScript"], candidateSkills: ["js"] }, { aliasIndex: INDEX });
        expect(component(result, "requiredSkills").value).toBe(1);
    });

    it("compares names the taxonomy does not know by their normalised key, never fuzzily", () => {
        const exact = computeFitScore({ ...BASE, requiredSkills: ["Domain  Modelling"], candidateSkills: ["domain modelling"] }, { aliasIndex: INDEX });
        expect(component(exact, "requiredSkills").value).toBe(1);
        const near = computeFitScore({ ...BASE, requiredSkills: ["Domain Modelling"], candidateSkills: ["Domain Modeling"] }, { aliasIndex: INDEX });
        expect(component(near, "requiredSkills").value).toBe(0);
    });

    it("explains matched and missing skills by requisition skill name", () => {
        const result = computeFitScore(BASE, { aliasIndex: INDEX });
        expect(component(result, "requiredSkills").explanation).toBe("Required skills: 2 of 2 matched (JavaScript, SQL)");
        expect(component(result, "preferredSkills").explanation).toBe("Preferred skills: 1 of 2 matched (React); missing: Kubernetes");
        expect(component(result, "experience").explanation).toBe("4 years of experience against a 5-year minimum");
        expect(component(result, "screeningAnswers").explanation).toBe("Screening answers: 6 of 10 points");
    });

    it("counts a skill listed as required and preferred once, as required", () => {
        const result = computeFitScore({ ...BASE, requiredSkills: ["JavaScript"], preferredSkills: ["JS", "React"] }, { aliasIndex: INDEX });
        expect(component(result, "preferredSkills").explanation).toMatch(/1 of 1 matched \(React\)/);
    });

    it("caps experience at 1 when the candidate exceeds the minimum", () => {
        const result = computeFitScore({ ...BASE, candidateYears: 12 }, { aliasIndex: INDEX });
        expect(component(result, "experience").value).toBe(1);
    });
});

describe("computeFitScore — not assessed is excluded, never zero", () => {
    it("drops unknown experience and renormalises the remaining weights", () => {
        const result = computeFitScore({ ...BASE, candidateYears: null }, { aliasIndex: INDEX });
        expect(component(result, "experience")).toMatchObject({ assessed: false, value: null });
        expect(component(result, "experience").explanation).toMatch(/^Not assessed/);
        // (50*1 + 20*0.5 + 15*0.6) / 85 = 0.8118
        expect(result.score).toBe(81.2);
    });

    it("drops a missing requisition minimum the same way", () => {
        const result = computeFitScore({ ...BASE, minYears: null }, { aliasIndex: INDEX });
        expect(component(result, "experience").assessed).toBe(false);
        expect(result.score).toBe(81.2);
    });

    it("drops unscored answers and an empty preferred list", () => {
        const result = computeFitScore(
            { ...BASE, preferredSkills: [], answerScore: null, answerMaxScore: null, candidateYears: null },
            { aliasIndex: INDEX },
        );
        expect(component(result, "preferredSkills").assessed).toBe(false);
        expect(component(result, "screeningAnswers").assessed).toBe(false);
        expect(result.score).toBe(100); // required coverage alone, 2 of 2
    });

    it("an answer ceiling of 0 is unscored, not a division by zero", () => {
        const result = computeFitScore({ ...BASE, answerScore: 0, answerMaxScore: 0 }, { aliasIndex: INDEX });
        expect(component(result, "screeningAnswers").assessed).toBe(false);
    });

    it("scores 0 and reports assessed:false when no component has data", () => {
        const result = computeFitScore({}, { aliasIndex: INDEX });
        expect(result.score).toBe(0);
        expect(result.band).toBe("WEAK");
        expect(result.assessed).toBe(false);
        expect(componentsAssessed(result.components)).toBe(false);
    });
});

describe("computeFitScore — knockout", () => {
    it("still scores a knocked-out application but caps it below FAIR", () => {
        const result = computeFitScore({ ...BASE, knockedOut: true }, { aliasIndex: INDEX });
        expect(result.score).toBe(KNOCKOUT_SCORE_CAP);
        expect(result.band).toBe("WEAK");
        expect(component(result, "knockout")).toMatchObject({ weight: 0, value: 0, assessed: true });
        expect(component(result, "knockout").explanation).toMatch(/uncapped 81/);
    });

    it("leaves a low score under the cap as it is", () => {
        const result = computeFitScore({ ...BASE, candidateSkills: [], knockedOut: true }, { aliasIndex: INDEX });
        expect(result.score).toBeLessThan(KNOCKOUT_SCORE_CAP);
        expect(result.band).toBe("WEAK");
    });
});

describe("fitBand", () => {
    it.each([
        [100, "STRONG"], [80, "STRONG"], [79.9, "GOOD"], [65, "GOOD"],
        [64.9, "FAIR"], [50, "FAIR"], [49.9, "WEAK"], [0, "WEAK"],
    ])("%s → %s", (score, band) => {
        expect(fitBand(score)).toBe(band);
    });
});

describe("computeFitScore — determinism and inputsHash", () => {
    it("returns identical output for identical inputs", () => {
        expect(computeFitScore(BASE, { aliasIndex: INDEX })).toEqual(computeFitScore(BASE, { aliasIndex: INDEX }));
    });

    it("the hash ignores ordering, case and aliases of the same skills", () => {
        const a = computeFitScore(BASE, { aliasIndex: INDEX });
        const b = computeFitScore({ ...BASE, candidateSkills: ["react", "sql", "JavaScript"] }, { aliasIndex: INDEX });
        expect(b.inputsHash).toBe(a.inputsHash);
        expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("the hash changes when any feature changes", () => {
        const base = computeFitScore(BASE, { aliasIndex: INDEX }).inputsHash;
        for (const change of [
            { candidateSkills: ["JS"] },
            { candidateYears: 5 },
            { minYears: 3 },
            { knockedOut: true },
            { answerScore: 7 },
            { answerMaxScore: 12 },
            { requiredSkills: ["JavaScript"] },
            { preferredSkills: ["React"] },
        ]) {
            expect(computeFitScore({ ...BASE, ...change }, { aliasIndex: INDEX }).inputsHash).not.toBe(base);
        }
    });

    it("ignores every key that is not a feature (no protected attribute can enter)", () => {
        const plain = computeFitScore(BASE, { aliasIndex: INDEX });
        const withExtras = computeFitScore(
            {
                ...BASE,
                firstName: "Ada",
                email: "ada@example.com",
                gender: "F",
                dateOfBirth: "1990-01-01",
                nationality: "PK",
                photoUrl: "x",
                address: "Lahore",
                notes: "free text",
            },
            { aliasIndex: INDEX },
        );
        expect(withExtras).toEqual(plain);
        const text = JSON.stringify(withExtras.components);
        for (const value of ["Ada", "ada@example.com", "Lahore", "free text"]) expect(text).not.toContain(value);
    });
});
