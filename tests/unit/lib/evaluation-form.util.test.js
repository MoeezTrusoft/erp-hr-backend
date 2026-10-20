// tests/unit/lib/evaluation-form.util.test.js
//
// Recruitment Phase 3b — the pure rules of the evaluation form and report:
// weighted score with not-assessed exclusion and must-haves, submission
// validation, the template definition validator, old templates read as one
// section, consolidation and divergence, the composite, the rank, the
// assessment gate and the test sections.
import { describe, it, expect } from "@jest/globals";

import {
    ASSESSMENT_PROCEED_STATES,
    assertAssessmentGate,
    assessmentGateOpen,
    compositeScore,
    computeWeightedScore,
    consolidateForm,
    divergenceThreshold,
    formForPanelRole,
    formFromTemplate,
    interviewScoreOf,
    mergeCriterionScores,
    normalizeScale,
    parseRating,
    rankAmong,
    testSectionsOf,
    validateFormDefinition,
    validateSubmission,
    weakCompetencies,
} from "../../../src/lib/evaluation-form.util.js";

const a5 = { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" };
const def = (overrides = {}) => ({
    scale: "1-5",
    sections: [
        {
            key: "tech",
            label: "Technical",
            panelRoles: ["TECHNICAL"],
            criteria: [
                { key: "sql", competencyKey: "sql", weight: 3, mustHave: true, mustHaveThreshold: 2, anchors: a5 },
                { key: "design", competencyKey: "design", weight: 1, required: false, anchors: a5 },
            ],
        },
        {
            key: "fit",
            label: "Values",
            panelRoles: ["CULTURE"],
            criteria: [
                { key: "values", competencyKey: "values", weight: 2, anchors: a5 },
                { key: "permit", competencyKey: "work_permit", scale: "YES_NO", mustHave: true, anchors: { YES: "Has permit", NO: "No permit" } },
            ],
        },
    ],
    ...overrides,
});

const built = () => {
    const v = validateFormDefinition(def());
    if (!v.ok) throw new Error(v.error);
    return v.form;
};

describe("validateFormDefinition", () => {
    it("normalises a valid form and keeps a flattened criteria list for old readers", () => {
        const v = validateFormDefinition(def());
        expect(v.ok).toBe(true);
        expect(v.form.scale).toEqual({ kind: "POINTS", min: 1, max: 5 });
        expect(v.form.sections[0].criteria[0]).toMatchObject({ key: "sql", required: true, mustHave: true, mustHaveThreshold: 2, weight: 3 });
        expect(v.form.sections[1].criteria[1].scale).toEqual({ kind: "YES_NO", min: 0, max: 1 });
        expect(v.form.sections[1].criteria[1].mustHaveThreshold).toBe(0);
        expect(v.criteria.map((c) => c.key)).toEqual(["sql", "design", "values", "permit"]);
        expect(v.form.evidenceRules).toEqual({ extremeRatings: null, mustHave: true });
    });

    it("refuses missing sections, empty sections, weights <= 0 and duplicate keys", () => {
        expect(validateFormDefinition({ sections: [] }).ok).toBe(false);
        expect(validateFormDefinition({ sections: [{ key: "s", criteria: [] }] }).ok).toBe(false);
        const zero = def();
        zero.sections[0].criteria[0].weight = 0;
        expect(validateFormDefinition(zero)).toMatchObject({ ok: false, error: expect.stringMatching(/weight/) });
        const dup = def();
        dup.sections[1].criteria[0].key = "sql";
        expect(validateFormDefinition(dup)).toMatchObject({ ok: false, error: expect.stringMatching(/Duplicate/) });
    });

    it("needs an anchor for every level of the criterion's scale", () => {
        const missing = def();
        missing.sections[0].criteria[1].anchors = { 1: "a", 5: "e" };
        expect(validateFormDefinition(missing)).toMatchObject({ ok: false, error: expect.stringMatching(/missing 2, 3, 4/) });
        const yesNo = def();
        yesNo.sections[1].criteria[1].anchors = { YES: "y" };
        expect(validateFormDefinition(yesNo)).toMatchObject({ ok: false, error: expect.stringMatching(/missing NO/) });
    });

    it("keeps must-have thresholds inside the scale (the top rating must pass)", () => {
        for (const bad of [0, 5, 7, 2.5]) {
            const f = def();
            f.sections[0].criteria[0].mustHaveThreshold = bad;
            expect(validateFormDefinition(f).ok).toBe(false);
        }
        const f = def();
        f.sections[0].criteria[0].mustHaveThreshold = 4;
        expect(validateFormDefinition(f).ok).toBe(true);
    });

    it("accepts only the 1-5, 1-4 and YES_NO scales and the closed panel roles", () => {
        expect(normalizeScale("1-4")).toMatchObject({ min: 1, max: 4, forcedChoice: true });
        expect(normalizeScale({ min: 0, max: 10 })).toBeNull();
        expect(validateFormDefinition(def({ scale: "1-10" })).ok).toBe(false);
        const role = def();
        role.sections[0].panelRoles = ["JANITOR"];
        expect(validateFormDefinition(role).ok).toBe(false);
    });

    it("a must-have criterion can never be optional", () => {
        const f = def();
        f.sections[0].criteria[0].required = false;
        expect(validateFormDefinition(f).form.sections[0].criteria[0].required).toBe(true);
    });
});

describe("old templates (no sections)", () => {
    it("read as one section on the 1-5 scale with weight 1 where unset", () => {
        const form = formFromTemplate({ name: "Engineering", criteria: [{ key: "a", required: true }, { key: "b", weight: 3, required: false }] });
        expect(form.legacy).toBe(true);
        expect(form.sections).toHaveLength(1);
        expect(form.sections[0].criteria.map((c) => [c.key, c.weight, c.required])).toEqual([["a", 1, true], ["b", 3, false]]);
        // a 4, b 2: (4 + 6) / (5 + 15) = 50%
        expect(computeWeightedScore({ criteria: [{ key: "a" }, { key: "b", weight: 3, required: false }] }, { a: 4, b: 2 }).weightedScore).toBe(50);
    });
});

describe("computeWeightedScore", () => {
    it("is sum(rating x weight) / sum(max x weight) over assessed criteria", () => {
        const form = built();
        const s = computeWeightedScore(form, [
            { key: "sql", rating: 4, note: "n" },
            { key: "design", rating: 3 },
            { key: "values", rating: 5, note: "n" },
            { key: "permit", rating: "YES", note: "seen" },
        ]);
        // (4x3 + 3x1 + 5x2 + 1x1) / (5x3 + 5x1 + 5x2 + 1x1) = 26 / 31
        expect(s.weightedScore).toBeCloseTo(83.87, 2);
        expect(s.assessedWeight).toBe(7);
        expect(s.mustHaveFailed).toBe(false);
        expect(s.missingRequired).toEqual([]);
        expect(s.meanRating).toBeCloseTo((12 + 3 + 10) / 6, 2);
    });

    it("excludes a not-assessed optional criterion from both sums", () => {
        const form = built();
        const base = [{ key: "sql", rating: 4, note: "n" }, { key: "values", rating: 4 }, { key: "permit", rating: 1, note: "ok" }];
        const s = computeWeightedScore(form, [...base, { key: "design", notAssessed: true }]);
        // (12 + 8 + 1) / (15 + 10 + 1) = 21 / 26
        expect(s.weightedScore).toBeCloseTo(80.77, 2);
        expect(s.assessedWeight).toBe(6);
    });

    it("refuses not assessed on a required criterion (it counts as missing)", () => {
        const s = computeWeightedScore(built(), [{ key: "sql", notAssessed: true }]);
        expect(s.missingRequired).toEqual(expect.arrayContaining(["sql", "values", "permit"]));
    });

    it("fails a must-have at or below its threshold whatever the weighted score", () => {
        const form = built();
        const s = computeWeightedScore(form, [
            { key: "sql", rating: 2, note: "n" },
            { key: "design", rating: 5, note: "n" },
            { key: "values", rating: 5, note: "n" },
            { key: "permit", rating: "NO", note: "none" },
        ]);
        expect(s.mustHaveFailed).toBe(true);
        expect(s.mustHaveFailures).toEqual(["sql", "permit"]);
        expect(s.suggestion).toBe("NOT_RECOMMENDED");
        expect(computeWeightedScore(form, [{ key: "sql", rating: 3, note: "n" }]).mustHaveFailed).toBe(false);
    });

    it("needs evidence for 1, 2 and 5 and for every must-have; 3 and 4 on a plain criterion need none", () => {
        const form = built();
        const s = computeWeightedScore(form, [
            { key: "sql", rating: 3 },
            { key: "design", rating: 1 },
            { key: "values", rating: 4 },
            { key: "permit", rating: "YES" },
        ]);
        expect(s.missingEvidence).toEqual(["sql", "design", "permit"]);
        expect(computeWeightedScore(form, [{ key: "values", rating: 2 }]).missingEvidence).toEqual(["values"]);
        expect(computeWeightedScore(form, [{ key: "values", rating: 5, note: " " }]).missingEvidence).toEqual(["values"]);
    });

    it("reports ratings off the scale and unknown criteria", () => {
        const s = computeWeightedScore(built(), [{ key: "sql", rating: 6 }, { key: "permit", rating: "MAYBE" }, { key: "nope", rating: 3 }]);
        expect(s.invalidRatings).toEqual(["sql", "permit"]);
        expect(s.unknownCriteria).toEqual(["nope"]);
        expect(parseRating("4", { kind: "POINTS", min: 1, max: 4 })).toBe(4);
        expect(parseRating(5, { kind: "POINTS", min: 1, max: 4 })).toBeUndefined();
    });

    it("scores only the panelist's sections when the form is cut to a panel role", () => {
        const tech = formForPanelRole(built(), "TECHNICAL");
        expect(tech.sections.map((x) => x.key)).toEqual(["tech"]);
        const s = computeWeightedScore(tech, [{ key: "sql", rating: 5, note: "n" }]);
        expect(s.missingRequired).toEqual([]);
        expect(s.weightedScore).toBe(100);
        expect(formForPanelRole(built(), null).sections).toHaveLength(2);
    });
});

describe("validateSubmission", () => {
    const full = [
        { key: "sql", rating: 4, note: "n" },
        { key: "values", rating: 4 },
        { key: "permit", rating: "YES", note: "seen" },
    ];

    it("passes a complete, declared, recommended form", () => {
        expect(validateSubmission(built(), { criterionScores: full, recommendation: "HIRE", coiDeclared: true }).ok).toBe(true);
    });

    it("lists every reason it fails", () => {
        const v = validateSubmission(built(), { criterionScores: [{ key: "sql", rating: 5 }], recommendation: "MAYBE", coiDeclared: false });
        expect(v.ok).toBe(false);
        expect(v.errors.map((e) => e.code)).toEqual(["REQUIRED_MISSING", "EVIDENCE_MISSING", "COI_NOT_DECLARED", "RECOMMENDATION_MISSING"]);
        expect(v.errors[0].criteria).toEqual(["values", "permit"]);
    });

    it("has no neutral recommendation", () => {
        for (const r of ["STRONG_HIRE", "HIRE", "NO_HIRE", "STRONG_NO_HIRE"]) {
            expect(validateSubmission(built(), { criterionScores: full, recommendation: r, coiDeclared: true }).ok).toBe(true);
        }
        expect(validateSubmission(built(), { criterionScores: full, recommendation: "HOLD", coiDeclared: true }).ok).toBe(false);
    });
});

describe("mergeCriterionScores", () => {
    it("keeps stored fields the input leaves out", () => {
        const stored = { sql: { rating: 4, notAssessed: false, note: "evidence" } };
        expect(mergeCriterionScores(stored, [{ key: "sql", rating: 3 }]).sql).toEqual({ rating: 3, notAssessed: false, note: "evidence" });
        expect(mergeCriterionScores(stored, [{ key: "sql", notAssessed: true }]).sql).toEqual({ rating: null, notAssessed: true, note: "evidence" });
        expect(mergeCriterionScores(stored, { design: 2 }).design).toEqual({ rating: 2, notAssessed: false, note: null });
    });
});

describe("consolidation", () => {
    const card = (reviewerId, ratings, extra = {}) => ({
        reviewerId,
        criterionScores: { criteria: Object.fromEntries(Object.entries(ratings).map(([k, r]) => [k, { rating: r, notAssessed: false, note: "n" }])), decision: extra.decision ?? "NEXT_ROUND" },
        weightedScore: extra.weightedScore ?? null,
        mustHaveFailed: extra.mustHaveFailed ?? false,
        recommendation: extra.recommendation ?? "HIRE",
    });

    it("gives average, min, max and spread, and marks a spread of 2+ on 1-5 divergent", () => {
        const out = consolidateForm(built(), [
            card(1, { sql: 5, values: 3, permit: "YES" }, { weightedScore: 90 }),
            card(2, { sql: 3, values: 4, permit: "NO" }, { weightedScore: 60, mustHaveFailed: true, recommendation: "NO_HIRE", decision: "REJECTED" }),
        ]);
        expect(out.criteria.sql).toMatchObject({ average: 4, min: 3, max: 5, spread: 2, divergent: true, count: 2 });
        expect(out.criteria.values).toMatchObject({ spread: 1, divergent: false });
        // YES vs NO on a must-have check diverges too.
        expect(out.divergentCriteria).toEqual(["sql", "permit"]);
        expect(out.interviewScorePct).toBe(75);
        expect(out.recommendationTally).toEqual({ STRONG_HIRE: 0, HIRE: 1, NO_HIRE: 1, STRONG_NO_HIRE: 0 });
        expect(out.decisionTally).toEqual({ NEXT_ROUND: 1, HOLD: 0, REJECTED: 1 });
        expect(out.mustHaveAlerts).toEqual([{ reviewerId: 2, reviewer: null, criteria: ["permit"] }]);
        expect(out.suggestion).toBe("NOT_RECOMMENDED");
    });

    it("uses half the range for other scales", () => {
        expect(divergenceThreshold({ kind: "POINTS", min: 1, max: 5 })).toBe(2);
        expect(divergenceThreshold({ kind: "POINTS", min: 1, max: 4 })).toBe(2);
        expect(divergenceThreshold({ kind: "YES_NO", min: 0, max: 1 })).toBe(1);
    });

    it("reads a pre-form scorecard by its 1-5 overall", () => {
        expect(interviewScoreOf([{ overallScore: 4 }, { weightedScore: 60 }])).toBe(70);
        expect(interviewScoreOf([])).toBeNull();
    });
});

describe("composite and rank", () => {
    it("is test weight x test + interview weight x interview, 30/70 by default", () => {
        expect(compositeScore({ testScorePct: 80, interviewScorePct: 60 })).toEqual({ compositeScore: 66, weights: { testPct: 30, interviewPct: 70 }, testIncluded: true });
        expect(compositeScore({ testScorePct: 80, interviewScorePct: 60, testWeightPct: 50 }).compositeScore).toBe(70);
    });

    it("drops the test when it was waived or not required", () => {
        expect(compositeScore({ testScorePct: 10, interviewScorePct: 60, testIncluded: false })).toEqual({ compositeScore: 60, weights: { testPct: 0, interviewPct: 100 }, testIncluded: false });
        expect(compositeScore({ testScorePct: null, interviewScorePct: 60 }).compositeScore).toBe(60);
        expect(compositeScore({ testScorePct: 80, interviewScorePct: null }).compositeScore).toBeNull();
    });

    it("ranks by composite, 1 is the highest", () => {
        expect(rankAmong(70, [80, 60, null])).toEqual({ rank: 2, of: 3 });
        expect(rankAmong(null, [80])).toEqual({ rank: null, of: 2 });
    });
});

describe("assessment gate", () => {
    it("is open when the test is not required or the status lets the interview proceed", () => {
        expect(ASSESSMENT_PROCEED_STATES).toEqual(["NOT_REQUIRED", "PASSED", "BORDERLINE", "OVERRIDDEN", "WAIVED"]);
        expect(assessmentGateOpen({ assessmentRequired: false, assessmentStatus: "FAILED" })).toBe(true);
        expect(assessmentGateOpen({})).toBe(true);
        for (const s of ASSESSMENT_PROCEED_STATES) expect(assessmentGateOpen({ assessmentRequired: true, assessmentStatus: s })).toBe(true);
        for (const s of ["REQUIRED", "CHECKED_IN", "IN_PROGRESS", "FAILED", "REVIEW", "INCOMPLETE", "RELEASED"]) {
            expect(() => assertAssessmentGate({ assessmentRequired: true, assessmentStatus: s })).toThrow(expect.objectContaining({ status: 409, code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED" }));
        }
    });
});

describe("test sections", () => {
    it("reads list or map section scores against the blueprint's pass marks", () => {
        const blueprint = { passMarkPct: 60, sections: [{ key: "num", competencyKey: "numeracy", sectionPassMarkPct: 50, mustPass: true }, { key: "safety", competencyKey: "safety" }] };
        const fromList = testSectionsOf([{ key: "num", rawScore: 4, maxScore: 10 }, { key: "safety", scorePct: 70 }], blueprint);
        expect(fromList).toEqual([
            { key: "num", label: "num", competencyKey: "numeracy", scorePct: 40, passMarkPct: 50, passed: false, mustPass: true },
            { key: "safety", label: "safety", competencyKey: "safety", scorePct: 70, passMarkPct: 60, passed: true, mustPass: false },
        ]);
        const fromMap = testSectionsOf({ num: { scorePct: 55 } }, blueprint);
        expect(fromMap[0]).toMatchObject({ competencyKey: "numeracy", scorePct: 55, passed: true });
        expect(weakCompetencies(fromList).map((s) => s.competencyKey)).toEqual(["numeracy"]);
        expect(testSectionsOf(null)).toEqual([]);
    });
});
