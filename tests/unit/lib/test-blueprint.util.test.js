// Recruitment Phase 3b — the pure blueprint rules: normalisation against the
// migration's ranges, the difficulty rounding rule, the pool depth report,
// most-specific-first resolution, the on-site rule and result reuse.
import { describe, it, expect } from "@jest/globals";
import {
    BLUEPRINT_DEFAULTS,
    assessmentRequirementFor,
    difficultyCounts,
    drawPlan,
    isOnsiteInterview,
    isReusableResult,
    normalizeBlueprintInput,
    pickBlueprintLink,
    poolDepthReport,
    requisitionJobFamily,
} from "../../../src/lib/test-blueprint.util.js";

const section = (over = {}) => ({ competencyKey: "domain", itemCount: 10, difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 }, ...over });
const input = (over = {}) => ({
    name: "Accounts Officer test",
    sections: [section(), section({ competencyKey: "numeracy", itemCount: 7 })],
    ...over,
});
const errorsOf = (fn) => {
    try {
        fn();
    } catch (err) {
        expect(err).toMatchObject({ status: 422, code: "HR-RECRUITMENT-BLUEPRINT-INVALID" });
        return err.details.errors;
    }
    throw new Error("expected a refusal");
};

describe("normalizeBlueprintInput", () => {
    it("applies the plan's defaults and computes the counts per section", () => {
        const v = normalizeBlueprintInput(input({ jobFamily: " finance " }));
        expect(v).toMatchObject({
            ...BLUEPRINT_DEFAULTS,
            name: "Accounts Officer test",
            jobFamily: "FINANCE",
            durationMin: 30,
            passMarkPct: 60,
            borderlineBandPct: 10,
            hardFloorPct: null,
            negativeMarking: false,
            navigation: "FREE",
            flagForReview: true,
            retakeCooldownDays: 180,
            resultValidityDays: 90,
            testWeightPct: 30,
        });
        expect(v.sections[0]).toMatchObject({ key: "s1", label: "domain", counts: { EASY: 3, MEDIUM: 5, HARD: 2 }, mustPass: false });
        expect(v.sections[1]).toMatchObject({ key: "s2", counts: { EASY: 2, MEDIUM: 4, HARD: 1 } });
    });

    it("refuses out-of-range values with every problem listed", () => {
        const errors = errorsOf(() => normalizeBlueprintInput(input({ durationMin: 4, passMarkPct: 101, retakeCooldownDays: -1, maxExtraTimePct: 150 })));
        expect(errors.join(" ")).toMatch(/durationMin/);
        expect(errors.join(" ")).toMatch(/passMarkPct/);
        expect(errors.join(" ")).toMatch(/retakeCooldownDays/);
        expect(errors.join(" ")).toMatch(/maxExtraTimePct/);
    });

    it("needs two to five sections, each its own competency, mixes summing to 100", () => {
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections: [section()] })))[0]).toMatch(/2 to 5 sections/);
        const six = Array.from({ length: 6 }, (_, i) => section({ competencyKey: `c${i}` }));
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections: six })))[0]).toMatch(/2 to 5 sections/);
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections: [section(), section()] }))).join(" ")).toMatch(/own competency/);
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections: [section({ difficultyMix: { EASY: 50, MEDIUM: 40 } }), section({ competencyKey: "x" })] }))).join(" "))
            .toMatch(/sum to 100 \(got 90\)/);
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections: [section({ itemCount: 0 }), section({ competencyKey: "x" })] }))).join(" ")).toMatch(/itemCount/);
    });

    it("keeps the hard floor below the borderline band and auto-release tied to it", () => {
        expect(errorsOf(() => normalizeBlueprintInput(input({ hardFloorPct: 55 }))).join(" ")).toMatch(/below the borderline band/);
        expect(errorsOf(() => normalizeBlueprintInput(input({ autoReleaseBelowFloor: true }))).join(" ")).toMatch(/needs a hardFloorPct/);
        expect(normalizeBlueprintInput(input({ hardFloorPct: 40, autoReleaseBelowFloor: true }))).toMatchObject({ hardFloorPct: 40, autoReleaseBelowFloor: true });
    });

    it("negative marking gets a fraction; forward-only turns flag-for-review off", () => {
        expect(normalizeBlueprintInput(input({ negativeMarking: true })).negativeMarkFraction).toBe(0.25);
        expect(normalizeBlueprintInput(input({ negativeMarkFraction: 0.5 })).negativeMarkFraction).toBeNull();
        expect(normalizeBlueprintInput(input({ navigation: "FORWARD_ONLY", flagForReview: true })).flagForReview).toBe(false);
        expect(errorsOf(() => normalizeBlueprintInput(input({ navigation: "BACKWARD" }))).join(" ")).toMatch(/navigation/);
    });

    it("section clocks cannot add up past the duration", () => {
        const sections = [section({ timeLimitMin: 20 }), section({ competencyKey: "x", timeLimitMin: 15 })];
        expect(errorsOf(() => normalizeBlueprintInput(input({ sections }))).join(" ")).toMatch(/exceed the duration/);
    });
});

describe("difficultyCounts — largest remainder, ties EASY, MEDIUM, HARD", () => {
    it.each([
        [10, { EASY: 30, MEDIUM: 50, HARD: 20 }, { EASY: 3, MEDIUM: 5, HARD: 2 }],
        [7, { EASY: 30, MEDIUM: 50, HARD: 20 }, { EASY: 2, MEDIUM: 4, HARD: 1 }],
        [1, { EASY: 34, MEDIUM: 33, HARD: 33 }, { EASY: 1, MEDIUM: 0, HARD: 0 }],
        [2, { EASY: 34, MEDIUM: 33, HARD: 33 }, { EASY: 1, MEDIUM: 1, HARD: 0 }],
        [5, { EASY: 0, MEDIUM: 100, HARD: 0 }, { EASY: 0, MEDIUM: 5, HARD: 0 }],
    ])("%i items at %j -> %j", (n, mix, expected) => {
        expect(difficultyCounts(n, mix)).toEqual(expected);
    });

    it("always keeps the total, for every count and many mixes", () => {
        for (let n = 1; n <= 50; n += 1) {
            for (let e = 0; e <= 100; e += 10) {
                for (let m = 0; m <= 100 - e; m += 10) {
                    const c = difficultyCounts(n, { EASY: e, MEDIUM: m, HARD: 100 - e - m });
                    expect(c.EASY + c.MEDIUM + c.HARD).toBe(n);
                }
            }
        }
    });
});

describe("poolDepthReport", () => {
    const sections = normalizeBlueprintInput(input()).sections;

    it("plans the draw per section and difficulty", () => {
        expect(drawPlan(sections)).toEqual([
            { sectionKey: "s1", competencyKey: "domain", counts: { EASY: 3, MEDIUM: 5, HARD: 2 }, total: 10 },
            { sectionKey: "s2", competencyKey: "numeracy", counts: { EASY: 2, MEDIUM: 4, HARD: 1 }, total: 7 },
        ]);
    });

    it("needs three times the draw in every bucket and reports each shortfall", () => {
        const deep = { domain: { EASY: 9, MEDIUM: 15, HARD: 6 }, numeracy: { EASY: 6, MEDIUM: 12, HARD: 3 } };
        expect(poolDepthReport({ sections, poolCounts: deep }).ok).toBe(true);
        const shallow = { ...deep, numeracy: { EASY: 6, MEDIUM: 11, HARD: 3 } };
        const report = poolDepthReport({ sections, poolCounts: shallow });
        expect(report.ok).toBe(false);
        expect(report.shortfalls).toEqual([{ sectionKey: "s2", competencyKey: "numeracy", difficulty: "MEDIUM", draw: 4, needed: 12, available: 11, ok: false }]);
        expect(report.sections[0].ok).toBe(true);
        expect(poolDepthReport({ sections, poolCounts: {} }).shortfalls).toHaveLength(6);
    });
});

describe("pickBlueprintLink — most specific first", () => {
    const bp = (id, status = "PUBLISHED") => ({ id, status });
    const links = [
        { scopeType: "JOB_FAMILY", scopeKey: "FINANCE", scopeId: null, isActive: true, blueprint: bp(3) },
        { scopeType: "JOB_FAMILY_GRADE", scopeKey: "FINANCE", scopeId: 4, isActive: true, blueprint: bp(2) },
        { scopeType: "REQUISITION", scopeId: 21, scopeKey: null, isActive: true, blueprint: bp(1) },
    ];
    const ctx = { requisitionId: 21, jobFamily: "finance", gradeLevelId: 4 };

    it("requisition, then family and grade, then family", () => {
        expect(pickBlueprintLink(links, ctx)).toMatchObject({ matchedScope: "REQUISITION", blueprint: { id: 1 } });
        expect(pickBlueprintLink(links, { ...ctx, requisitionId: 22 })).toMatchObject({ matchedScope: "JOB_FAMILY_GRADE", blueprint: { id: 2 } });
        expect(pickBlueprintLink(links, { ...ctx, requisitionId: 22, gradeLevelId: 5 })).toMatchObject({ matchedScope: "JOB_FAMILY", blueprint: { id: 3 } });
        expect(pickBlueprintLink(links, { requisitionId: 22, jobFamily: "SALES", gradeLevelId: 4 })).toBeNull();
    });

    it("ignores inactive links and unpublished blueprints", () => {
        const draft = [{ ...links[2], blueprint: bp(1, "APPROVED") }, { ...links[1], isActive: false }, links[0]];
        expect(pickBlueprintLink(draft, ctx)).toMatchObject({ matchedScope: "JOB_FAMILY" });
    });
});

describe("requisitionJobFamily", () => {
    it("jobContent.jobFamily, else the position's jobCode, else null", () => {
        expect(requisitionJobFamily({ jobContent: { jobFamily: "finance" }, position: { jobCode: "ACC" } })).toBe("FINANCE");
        expect(requisitionJobFamily({ jobContent: { summary: "x" }, position: { jobCode: "acc-01" } })).toBe("ACC-01");
        expect(requisitionJobFamily({ jobContent: null, position: null })).toBeNull();
    });
});

describe("isOnsiteInterview", () => {
    it.each([
        ["VIDEO", "Room 4", false],
        ["PHONE_SCREEN", "Head office", false],
        ["ONSITE", null, true],
        ["ONSITE", "https://zoom.us/j/1", true],
        ["TECHNICAL", "Head office, floor 3", true],
        ["PANEL", "https://meet.google.com/abc", false],
        ["FINAL", "Microsoft Teams", false],
        ["BEHAVIORAL", "Online", false],
        ["TECHNICAL", "", false],
        ["PANEL", null, false],
    ])("%s at %j -> %s", (interviewType, location, expected) => {
        expect(isOnsiteInterview({ interviewType, location })).toBe(expected);
    });
});

describe("assessmentRequirementFor", () => {
    const NOW = new Date("2026-10-20T09:00:00Z");
    const days = (n) => new Date(NOW.getTime() + n * 86400000);

    it("reuses a valid passed, borderline or proceeded result", () => {
        expect(isReusableResult({ band: "PASSED", validUntil: days(10) }, NOW)).toBe(true);
        expect(isReusableResult({ band: "BORDERLINE", validUntil: days(1) }, NOW)).toBe(true);
        expect(isReusableResult({ band: "FAILED", decision: "OVERRIDE", validUntil: days(1) }, NOW)).toBe(true);
        expect(isReusableResult({ band: "REVIEW", decision: "PROCEED", validUntil: days(1) }, NOW)).toBe(true);
        expect(isReusableResult({ band: "PASSED", validUntil: days(-1) }, NOW)).toBe(false);
        expect(isReusableResult({ band: "PASSED", validUntil: null }, NOW)).toBe(false);
        expect(isReusableResult({ band: "FAILED", validUntil: days(10) }, NOW)).toBe(false);
        expect(isReusableResult({ band: "PASSED", decision: "RETEST", validUntil: days(10) }, NOW)).toBe(false);
        const r = assessmentRequirementFor({ results: [{ id: 7, band: "PASSED", validUntil: days(5), createdAt: days(-85) }], now: NOW });
        expect(r).toEqual({ assessmentStatus: "PASSED", reusedResultId: 7, cooldownActive: false, cooldownResultId: null });
    });

    it("requires the test, flagging a failure inside the cooldown", () => {
        const failed = { id: 8, band: "FAILED", validUntil: days(20), createdAt: days(-70) };
        expect(assessmentRequirementFor({ results: [failed], now: NOW, retakeCooldownDays: 180 }))
            .toEqual({ assessmentStatus: "REQUIRED", reusedResultId: null, cooldownActive: true, cooldownResultId: 8 });
        expect(assessmentRequirementFor({ results: [failed], now: NOW, retakeCooldownDays: 30 }).cooldownActive).toBe(false);
        expect(assessmentRequirementFor({ results: [], now: NOW })).toMatchObject({ assessmentStatus: "REQUIRED", cooldownActive: false });
    });
});
