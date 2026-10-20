// tests/unit/services/evaluation-summary.service.test.js
//
// Recruitment Phase 3b — the candidate evaluation report: composite with the
// blueprint's test weight (test dropped when waived), the advisory rank, the
// snapshot frozen when the hiring manager records a decisive outcome (once per
// interview, never rewritten), the assessment gate on the outcome, who may
// read the report, the PDF export to DAM and the consolidation extensions.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb } from "./helpers/evaluation-form.fake.js";

const { db, store } = createFakeDb();
const uploadFileToDAM = jest.fn(async () => [{ id: 555 }]);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM }));

const summary = await import("../../../src/services/evaluation-summary.service.js");
const { setInterviewOutcome, consolidateInterviewFeedback } = await import("../../../src/services/interviewMgmt.service.js");
const { generateEvaluationReportPdf } = await import("../../../src/services/evaluation-report-pdf.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "33333333-3333-4333-8333-333333333333";
const recruiter = { tenantId: T, employeeId: 7, roles: ["RECRUITER"] };
const panelA = { tenantId: T, employeeId: 21, roles: ["INTERVIEWER"] };
const manager = { tenantId: T, employeeId: 30, roles: ["HIRING_MANAGER"] };
const as = (user, fn) => mcpCtx.run({ user }, async () => await fn());

const a5 = { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" };
const card = (id, reviewerId, sql, comm, extra = {}) => ({
    id, tenantId: T, interviewId: 100, reviewerId, status: "SUBMITTED", submittedAt: new Date("2026-10-19T11:00:00Z"),
    scores: { sql, communication: comm }, overallScore: (sql + comm) / 2,
    criterionScores: { criteria: { sql: { rating: sql, notAssessed: false, note: "e" }, communication: { rating: comm, notAssessed: false, note: "e" } }, decision: "NEXT_ROUND" },
    weightedScore: ((sql * 2 + comm) / 15) * 100, mustHaveFailed: sql <= 2, recommendation: "HIRE", notes: "fine", coiDeclared: true,
    notesFlagged: false, notesFlagTerms: [], templateId: 50, templateVersion: 1, amendmentLog: null, lastAmendedAt: null, ...extra,
});

function seed() {
    for (const key of Object.keys(store)) store[key].length = 0;
    store.employees.push({ id: 21, tenant_id: T, employee_name: "Ali" }, { id: 22, tenant_id: T, employee_name: "Sara" }, { id: 30, tenant_id: T, employee_name: "Hamid" });
    store.requisitions.push({ id: 5, tenantId: T, title: "Data Analyst", requestedById: 30, positionId: 9 });
    store.candidates.push({ id: 3, tenantId: T, firstName: "Ayesha", lastName: "Khan" }, { id: 4, tenantId: T, firstName: "Bilal", lastName: "Ahmed" });
    store.applications.push({ id: 11, tenantId: T, candidateId: 3, jobRequisitionId: 5, stage: "interview" }, { id: 12, tenantId: T, candidateId: 4, jobRequisitionId: 5, stage: "interview" });
    store.interviews.push({
        id: 100, tenantId: T, applicationId: 11, interviewType: "TECHNICAL", scheduledAt: new Date("2026-10-19T09:00:00Z"), durationMinutes: 60,
        status: "SCHEDULED", decision: null, notes: null, assessmentRequired: true, assessmentStatus: "PASSED", assessmentBlueprintId: 80,
        assessmentWaivedReason: null, formTemplateId: 50, formTemplateVersion: 1,
    });
    store.interviewers.push(
        { interviewId: 100, employeeId: 21, panelRole: "TECHNICAL", status: "accepted", tenantId: T },
        { interviewId: 100, employeeId: 22, panelRole: "TECHNICAL", status: "accepted", tenantId: T },
    );
    store.templates.push({
        id: 50, tenantId: T, name: "Analyst form", templateKey: "af", version: 1, status: "PUBLISHED", isActive: true,
        criteria: [{ key: "sql" }, { key: "communication" }], scale: { kind: "POINTS", min: 1, max: 5 }, evidenceRules: { extremeRatings: null, mustHave: true },
        sections: [{ key: "all", label: "All", panelRoles: [], criteria: [
            { key: "sql", label: "SQL", competencyKey: "sql", weight: 2, required: true, mustHave: true, mustHaveThreshold: 2, anchors: a5, questionKeys: [] },
            { key: "communication", label: "Communication", competencyKey: "communication", weight: 1, required: true, mustHave: false, mustHaveThreshold: null, anchors: a5, questionKeys: [] },
        ] }],
    });
    // sql 5 / comm 4 -> 93.33; sql 3 / comm 4 -> 66.67; interview 80
    store.scorecards.push(card(201, 21, 5, 4, { notesFlagged: true, notesFlagTerms: ["AGE:age"] }), card(202, 22, 3, 4, { recommendation: "NO_HIRE" }));
    store.blueprints.push({ id: 80, tenantId: T, name: "Analyst test", testWeightPct: 40, passMarkPct: 60, sections: [] });
    store.testResults.push({ id: 90, tenantId: T, interviewId: 100, blueprintId: 80, scorePct: 50, band: "BORDERLINE", decision: "PROCEED", sectionScores: [], createdAt: new Date() });
    db.contextLog.length = 0;
}

const events = (name) => store.outbox.filter((e) => e.eventName === name);
const decide = (decision, extra = {}) => as(manager, () => setInterviewOutcome({ interviewId: 100, decision, tenantId: T, actorId: 30, ...extra }));

beforeEach(() => {
    process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
    uploadFileToDAM.mockClear();
    seed();
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
    expect(db.contextLog.every((q) => q.system || q.tenantId)).toBe(true);
});

describe("the live report", () => {
    it("combines the test and the panel: composite with the blueprint's weight, tally, divergence, must-haves", async () => {
        const report = await as(manager, () => summary.buildEvaluationReport(db, { tenantId: T, interviewId: 100 }));
        expect(report.interviewScorePct).toBe(80);
        expect(report.test).toMatchObject({ included: true, scorePct: 50, band: "BORDERLINE", testWeightPct: 40 });
        // 0.4 x 50 + 0.6 x 80
        expect(report.compositeScore).toBe(68);
        expect(report.weights).toEqual({ testPct: 40, interviewPct: 60 });
        expect(report.recommendationTally).toMatchObject({ HIRE: 1, NO_HIRE: 1 });
        expect(report.divergentCriteria).toEqual(["sql"]);
        expect(report.mustHaveFailed).toBe(false);
        expect(report.panel).toMatchObject({ size: 2, submittedCount: 2, outstanding: [] });
        expect(report.rank).toEqual({ rank: 1, of: 1 });
    });

    it("drops a waived test from the composite", async () => {
        Object.assign(store.interviews[0], { assessmentStatus: "WAIVED", assessmentWaivedReason: "Internal candidate" });
        const report = await as(manager, () => summary.buildEvaluationReport(db, { tenantId: T, interviewId: 100 }));
        expect(report.test).toMatchObject({ included: false, waived: true, waiverReason: "Internal candidate" });
        expect(report.compositeScore).toBe(80);
        expect(report.weights).toEqual({ testPct: 0, interviewPct: 100 });
    });

    it("ranks among the requisition's other candidates (advisory)", async () => {
        store.summaries.push({ id: 1, tenantId: T, applicationId: 12, interviewId: 101, requisitionId: 5, compositeScore: 75, frozenAt: new Date(), snapshot: {}, weights: {} });
        const report = await as(manager, () => summary.buildEvaluationReport(db, { tenantId: T, interviewId: 100 }));
        expect(report.rank).toEqual({ rank: 2, of: 2 });
    });
});

describe("freeze at outcome", () => {
    it("a decisive outcome freezes the snapshot in the same transaction, once", async () => {
        await decide("NEXT_ROUND");
        expect(store.interviews[0]).toMatchObject({ decision: "NEXT_ROUND", status: "COMPLETED" });
        expect(store.summaries).toHaveLength(1);
        const row = store.summaries[0];
        expect(row).toMatchObject({ interviewId: 100, applicationId: 11, requisitionId: 5, compositeScore: 68, interviewScorePct: 80, testScorePct: 50, rankAtSnapshot: 1, frozenById: 30 });
        expect(row.snapshot).toMatchObject({ outcome: "NEXT_ROUND", compositeScore: 68 });
        const [evt] = events("hr.recruitment.evaluation_summary_frozen.v1");
        expect(evt.payload.payload).toEqual({ summaryId: String(row.id), interviewId: "100", applicationId: "11", requisitionId: "5" });

        // A later outcome, and later rating or weight changes, never rewrite it.
        const before = structuredClone(row.snapshot);
        store.blueprints[0].testWeightPct = 90;
        store.scorecards[1].weightedScore = 10;
        await decide("REJECTED", { reason: "Changed our mind" });
        expect(store.summaries).toHaveLength(1);
        expect(store.summaries[0].snapshot).toEqual(before);
        expect(events("hr.recruitment.evaluation_summary_frozen.v1")).toHaveLength(1);
    });

    it("HOLD does not freeze, nor does an outcome with the flag off", async () => {
        await decide("HOLD");
        expect(store.summaries).toHaveLength(0);
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
        await decide("NEXT_ROUND");
        expect(store.summaries).toHaveLength(0);
    });

    it("the assessment gate refuses any outcome until the test lets the interview proceed, flag or not", async () => {
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
        for (const status of ["REQUIRED", "IN_PROGRESS", "FAILED", "REVIEW", "INCOMPLETE"]) {
            store.interviews[0].assessmentStatus = status;
            await expect(decide("HOLD")).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED" });
        }
        expect(store.interviews[0].decision).toBeNull();
        store.interviews[0].assessmentStatus = "OVERRIDDEN";
        await decide("NEXT_ROUND");
        expect(store.interviews[0].decision).toBe("NEXT_ROUND");
        store.interviews[0].assessmentRequired = false;
        store.interviews[0].assessmentStatus = "FAILED";
        await expect(decide("HOLD")).resolves.toBeDefined();
    });
});

describe("hr_interview_evaluation_summary_get", () => {
    it("recruiter and manager read the live report, then the frozen snapshot; only HR sees the notes flag", async () => {
        const live = await as(manager, () => summary.getEvaluationSummary(manager, { interviewId: 100 }));
        expect(live.frozen).toBe(false);
        expect(live.reviewers[0]).not.toHaveProperty("notesFlagged");
        const hr = await as(recruiter, () => summary.getEvaluationSummary(recruiter, { interviewId: 100 }));
        expect(hr.reviewers.find((r) => r.reviewerId === 21)).toMatchObject({ notesFlagged: true, notesFlagTerms: ["AGE:age"] });

        await decide("NEXT_ROUND");
        const frozen = await as(manager, () => summary.getEvaluationSummary(manager, { interviewId: 100 }));
        expect(frozen).toMatchObject({ frozen: true, compositeScore: 68, outcome: "NEXT_ROUND", pdfMediaId: null });
        expect(JSON.stringify(frozen)).not.toMatch(/AGE:age/);
    });

    it("a panelist reads only their own form", async () => {
        const out = await as(panelA, () => summary.getEvaluationSummary(panelA, { interviewId: 100 }));
        expect(out.ownFormOnly).toBe(true);
        expect(out.scorecard.reviewerId).toBe(21);
        expect(out).not.toHaveProperty("compositeScore");
        expect(out).not.toHaveProperty("reviewers");
    });
});

describe("hr_interview_evaluation_export", () => {
    it("needs the frozen report, stores the PDF in DAM once and reuses it", async () => {
        await expect(as(manager, () => summary.exportEvaluationReport(manager, { interviewId: 100 }))).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-EVALUATION-NOT-FROZEN" });
        await decide("NEXT_ROUND");
        const out = await as(manager, () => summary.exportEvaluationReport(manager, { interviewId: 100 }));
        expect(out).toMatchObject({ mediaId: 555, reused: false });
        const [file, type] = uploadFileToDAM.mock.calls[0];
        expect(type).toBe("document");
        expect(file.mimetype).toBe("application/pdf");
        expect(file.buffer.subarray(0, 4).toString()).toBe("%PDF");
        expect(store.summaries[0].pdfMediaId).toBe(555);
        // The snapshot itself is untouched by the export.
        expect(store.summaries[0].snapshot.compositeScore).toBe(68);
        const again = await as(manager, () => summary.exportEvaluationReport(manager, { interviewId: 100 }));
        expect(again).toMatchObject({ mediaId: 555, reused: true });
        expect(uploadFileToDAM).toHaveBeenCalledTimes(1);
    });

    it("is for recruiters and the requisition's manager", async () => {
        await decide("NEXT_ROUND");
        await expect(as(panelA, () => summary.exportEvaluationReport(panelA, { interviewId: 100 }))).rejects.toMatchObject({ status: 403 });
    });

    it("renders deterministically", async () => {
        const report = await as(manager, () => summary.buildEvaluationReport(db, { tenantId: T, interviewId: 100 }));
        const frozenAt = new Date("2026-10-20T10:00:00Z");
        const one = await generateEvaluationReportPdf({ report: JSON.parse(JSON.stringify(report)), frozenAt });
        const two = await generateEvaluationReportPdf({ report: JSON.parse(JSON.stringify(report)), frozenAt });
        expect(one.equals(two)).toBe(true);
        await expect(generateEvaluationReportPdf({ report })).rejects.toMatchObject({ code: "HR-RECRUITMENT-EVALUATION-PDF-INVALID" });
    });
});

describe("consolidateInterviewFeedback with evaluation forms", () => {
    it("hides peers from a panelist who has not submitted, and adds the evaluation for recruiters", async () => {
        store.interviewers.push({ interviewId: 100, employeeId: 23, panelRole: "HR", status: "accepted", tenantId: T });
        store.employees.push({ id: 23, tenant_id: T, employee_name: "Noor" });
        const panelist = { tenantId: T, employeeId: 23, roles: ["INTERVIEWER"] };
        const hidden = await as(panelist, () => consolidateInterviewFeedback({ id: 100, tenantId: T, scope: resolveRecruitmentScope(panelist) }));
        expect(hidden.peersHidden).toBe(true);
        expect(hidden.reviewers).toEqual([]);
        expect(hidden.criteria.technicalSkills.values).toEqual([]);
        expect(hidden).not.toHaveProperty("evaluation");

        const hr = await as(recruiter, () => consolidateInterviewFeedback({ id: 100, tenantId: T, scope: resolveRecruitmentScope(recruiter) }));
        expect(hr.reviewers).toHaveLength(2);
        expect(hr.evaluation).toMatchObject({ compositeScore: 68, divergentCriteria: ["sql"] });
    });

    it("is unchanged with the flag off", async () => {
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
        const panelist = { tenantId: T, employeeId: 21, roles: ["INTERVIEWER"] };
        const out = await as(panelist, () => consolidateInterviewFeedback({ id: 100, tenantId: T, scope: resolveRecruitmentScope(panelist) }));
        expect(out).not.toHaveProperty("evaluation");
        expect(out).not.toHaveProperty("peersHidden");
        expect(out.reviewers).toHaveLength(2);
    });
});
