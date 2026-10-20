// tests/unit/services/rater-calibration.service.test.js
//
// Recruitment Phase 3b — rater calibration maths: leniency against the other
// panelists, range, agreement within one point of their median, timeliness,
// the common 1-5 footing for 1-4 forms, YES_NO excluded, and metrics withheld
// below the minimum sample of five.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb } from "./helpers/evaluation-form.fake.js";

const { db, store } = createFakeDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const cal = await import("../../../src/services/rater-calibration.service.js");
const { formFromTemplate } = await import("../../../src/lib/evaluation-form.util.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "44444444-4444-4444-8444-444444444444";
const legacy = formFromTemplate({ criteria: [] });

// n interviews; in each, reviewer 1 rates `own`, reviewer 2 rates `other`.
const panelCards = (n, own, other, { delayHours = 2 } = {}) =>
    Array.from({ length: n }, (_, i) => {
        const scheduledAt = new Date(Date.UTC(2026, 9, 1 + i, 9));
        const at = (h) => new Date(scheduledAt.getTime() + (60 + h * 60) * 60 * 1000);
        const mk = (reviewerId, ratings, delay) => ({
            id: i * 10 + reviewerId,
            interviewId: i + 1,
            reviewerId,
            submittedAt: at(delay),
            criterionScores: { criteria: Object.fromEntries(Object.entries(ratings).map(([k, r]) => [k, { rating: r, notAssessed: false, note: null }])) },
            interview: { scheduledAt, durationMinutes: 60 },
        });
        return [mk(1, own, delayHours), mk(2, other, 30)];
    }).flat();

describe("summarizeRaterCalibration", () => {
    it("measures leniency, range, agreement and timeliness per interviewer", () => {
        const rows = cal.summarizeRaterCalibration(panelCards(5, { a: 5, b: 4 }, { a: 3, b: 4 }), () => legacy);
        const lenient = rows.find((r) => r.reviewerId === 1);
        const severe = rows.find((r) => r.reviewerId === 2);
        // deviations: a +2, b 0 -> +1 mean
        expect(lenient).toMatchObject({ sampleSize: 5, sufficientSample: true, leniency: 1, tendency: "LENIENT", meanRating: 4.5, sharedComparisons: 10 });
        expect(lenient.range).toEqual({ min: 4, max: 5, sd: 0.5 });
        // a differs by 2 (disagree), b by 0 (agree)
        expect(lenient.agreement).toBe(0.5);
        expect(lenient.timeliness).toEqual({ medianHours: 2, within24hShare: 1 });
        expect(severe).toMatchObject({ leniency: -1, tendency: "SEVERE" });
        expect(severe.timeliness).toEqual({ medianHours: 30, within24hShare: 0 });
    });

    it("is BALANCED within half a point of the panel", () => {
        const rows = cal.summarizeRaterCalibration(panelCards(5, { a: 4 }, { a: 4 }), () => legacy);
        expect(rows.every((r) => r.tendency === "BALANCED" && r.leniency === 0 && r.agreement === 1)).toBe(true);
    });

    it("withholds metrics below the minimum sample of five", () => {
        const rows = cal.summarizeRaterCalibration(panelCards(4, { a: 5 }, { a: 1 }), () => legacy);
        expect(rows[0]).toMatchObject({ sampleSize: 4, sufficientSample: false, leniency: null, tendency: null, meanRating: null, range: null, agreement: null, timeliness: null });
        expect(cal.CALIBRATION_MIN_SAMPLE).toBe(5);
    });

    it("puts a 1-4 form on the 1-5 footing and leaves YES_NO checks out", () => {
        const a4 = { 1: "a", 2: "b", 3: "c", 4: "d" };
        const form = formFromTemplate({
            sections: [{ key: "s", criteria: [
                { key: "a", competencyKey: "a", weight: 1, required: true, anchors: a4 },
                { key: "permit", competencyKey: "p", weight: 1, required: true, mustHave: true, mustHaveThreshold: 0, scale: { kind: "YES_NO", min: 0, max: 1 }, anchors: { YES: "y", NO: "n" } },
            ] }],
            scale: { kind: "POINTS", min: 1, max: 4 },
            evidenceRules: { mustHave: true },
        });
        expect(cal.toFivePoint(4, form.scale)).toBe(5);
        expect(cal.toFivePoint(1, form.scale)).toBe(1);
        expect(cal.toFivePoint(1, { kind: "YES_NO", min: 0, max: 1 })).toBeNull();
        const rows = cal.summarizeRaterCalibration(panelCards(5, { a: 4, permit: 1 }, { a: 1, permit: 0 }), () => form);
        expect(rows.find((r) => r.reviewerId === 1)).toMatchObject({ leniency: 4, meanRating: 5, sharedComparisons: 5 });
    });
});

describe("getRaterCalibration", () => {
    const recruiter = { tenantId: T, employeeId: 7, roles: ["RECRUITER"] };
    beforeEach(() => {
        process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
        for (const key of Object.keys(store)) store[key].length = 0;
        for (const c of panelCards(6, { a: 5 }, { a: 3 })) {
            store.scorecards.push({ ...c, tenantId: T, interview: undefined, scores: {} });
            if (!store.interviews.find((i) => i.id === c.interviewId)) {
                store.interviews.push({ id: c.interviewId, tenantId: T, applicationId: 1, ...c.interview, formTemplateId: null });
            }
        }
        store.employees.push({ id: 1, tenant_id: T, employee_name: "One" }, { id: 2, tenant_id: T, employee_name: "Two" });
    });
    afterEach(() => {
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
    });

    it("reads the window for HR and recruiters, with names", async () => {
        const out = await mcpCtx.run({ user: recruiter }, async () => await cal.getRaterCalibration(recruiter, { from: "2026-09-01", to: "2026-11-01" }));
        expect(out.scanned).toBe(12);
        expect(out.minSample).toBe(5);
        expect(out.raters.map((r) => [r.reviewerId, r.reviewer, r.tendency])).toEqual([[1, "One", "LENIENT"], [2, "Two", "SEVERE"]]);
        const one = await mcpCtx.run({ user: recruiter }, async () => await cal.getRaterCalibration(recruiter, { from: "2026-09-01", to: "2026-11-01", interviewerId: 2, minSample: 2 }));
        expect(one.minSample).toBe(5);
        expect(one.raters.map((r) => r.reviewerId)).toEqual([2]);
    });

    it("is refused to interviewers and hiring managers", async () => {
        const panelist = { tenantId: T, employeeId: 1, roles: ["INTERVIEWER"] };
        await expect(mcpCtx.run({ user: panelist }, async () => await cal.getRaterCalibration(panelist, {}))).rejects.toMatchObject({ status: 403 });
    });
});
