// tests/unit/services/evaluation-form.service.test.js
//
// Recruitment Phase 3b — the interviewer's evaluation form against an
// in-memory database: role-filtered sections, pinning on first save, draft
// autosave that never locks, the submit rules (validation, conflict of
// interest, evidence, training, prohibited topics flagged not blocked,
// lock and amendment), independent scoring, the assessment gate, the
// test-informed probes and the debrief prompt. Every query must run inside
// the tenant context.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb } from "./helpers/evaluation-form.fake.js";

const { db, store } = createFakeDb();
const runAiTask = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/candidateMatch.service.js", () => ({
    requisitionSkillRequirements: jest.fn(() => ({ required: ["SQL"], preferred: ["Python"] })),
}));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask, extractModelJson: (v) => v }));

const forms = await import("../../../src/services/evaluation-form.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "11111111-1111-4111-8111-111111111111";
const recruiter = { tenantId: T, employeeId: 7, roles: ["RECRUITER"] };
const panelA = { tenantId: T, employeeId: 21, roles: ["INTERVIEWER"] };
const panelB = { tenantId: T, employeeId: 22, roles: ["INTERVIEWER"] };
const manager = { tenantId: T, employeeId: 30, roles: ["HIRING_MANAGER"] };
const outsider = { tenantId: T, employeeId: 99, roles: ["INTERVIEWER"] };

const as = (user, fn) => mcpCtx.run({ user }, async () => await fn());

const anchors5 = { 1: "Poor", 2: "Weak", 3: "Solid", 4: "Strong", 5: "Exceptional" };
const FORM = {
    id: 50,
    tenantId: T,
    name: "Analyst form",
    templateKey: "analyst-form",
    version: 1,
    status: "PUBLISHED",
    isActive: true,
    criteria: [{ key: "sql" }, { key: "modelling" }, { key: "communication" }],
    scale: { kind: "POINTS", min: 1, max: 5 },
    evidenceRules: { extremeRatings: null, mustHave: true },
    requiresTrainedInterviewer: false,
    sections: [
        {
            key: "tech", label: "Technical", panelRoles: ["TECHNICAL"],
            criteria: [
                { key: "sql", label: "SQL", competencyKey: "sql", weight: 2, required: true, mustHave: true, mustHaveThreshold: 2, anchors: anchors5, questionKeys: ["q-sql"] },
                { key: "modelling", label: "Modelling", competencyKey: "modelling", weight: 1, required: false, mustHave: false, mustHaveThreshold: null, anchors: anchors5, questionKeys: [] },
            ],
        },
        {
            key: "people", label: "People", panelRoles: ["HR"],
            criteria: [{ key: "communication", label: "Communication", competencyKey: "communication", weight: 1, required: true, mustHave: false, mustHaveThreshold: null, anchors: anchors5, questionKeys: [] }],
        },
    ],
};

function seed() {
    for (const key of Object.keys(store)) store[key].length = 0;
    store.employees.push(
        { id: 7, tenant_id: T, employee_name: "Rina Recruiter", interviewerTrainedAt: null },
        { id: 21, tenant_id: T, employee_name: "Ali Tech", interviewerTrainedAt: null },
        { id: 22, tenant_id: T, employee_name: "Sara HR", interviewerTrainedAt: new Date("2026-01-01") },
        { id: 30, tenant_id: T, employee_name: "Hamid Manager", interviewerTrainedAt: null },
    );
    store.requisitions.push({ id: 5, tenantId: T, title: "Data Analyst", requestedById: 30, approvedById: null, positionId: 9 });
    store.candidates.push({ id: 3, tenantId: T, firstName: "Ayesha", lastName: "Khan" });
    store.applications.push({ id: 11, tenantId: T, candidateId: 3, jobRequisitionId: 5, stage: "interview" });
    store.interviews.push({
        id: 100, tenantId: T, applicationId: 11, interviewType: "TECHNICAL", scheduledAt: new Date("2026-10-19T09:00:00Z"),
        durationMinutes: 60, status: "SCHEDULED", decision: null, notes: null, assessmentRequired: false,
        assessmentStatus: "NOT_REQUIRED", assessmentBlueprintId: null, assessmentWaivedReason: null, formTemplateId: null, formTemplateVersion: null,
    });
    store.interviewers.push(
        { interviewId: 100, employeeId: 21, panelRole: "TECHNICAL", status: "accepted", tenantId: T },
        { interviewId: 100, employeeId: 22, panelRole: "HR", status: "accepted", tenantId: T },
    );
    store.templates.push(structuredClone(FORM));
    store.links.push({ id: 60, tenantId: T, templateId: 50, scopeType: "REQUISITION", scopeId: 5, scopeKey: null, isActive: true });
    store.questions.push({ id: 70, tenantId: T, questionKey: "q-sql", version: 1, status: "PUBLISHED", competencyKey: "sql", prompt: "Write a join", followUps: [], goodAnswerGuide: "Uses keys", level: "MID" });
    db.contextLog.length = 0;
}

const goodA = {
    interviewId: 100,
    criterionScores: [{ key: "sql", rating: 4, note: "Wrote a correct window query" }, { key: "modelling", notAssessed: true }],
    recommendation: "HIRE",
    decision: "NEXT_ROUND",
    coiDeclared: true,
    comments: "Clear and structured",
};

const events = (name) => store.outbox.filter((e) => e.eventName === name);

beforeEach(() => {
    process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
    seed();
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
    delete process.env.HR_RECRUITMENT_AI;
    // Prisma queries are lazy: every one must have run inside a context.
    expect(db.contextLog.every((q) => q.system || q.tenantId)).toBe(true);
});

describe("hr_interview_form_get", () => {
    it("shows a panelist only their role's sections, the linked questions, and no peers before submitting", async () => {
        const out = await as(panelA, () => forms.getInterviewForm(panelA, { interviewId: 100 }));
        expect(out.pinned).toBe(false);
        expect(out.form.sections.map((s) => s.key)).toEqual(["tech"]);
        expect(out.questions["q-sql"]).toMatchObject({ prompt: "Write a join", goodAnswerGuide: "Uses keys" });
        expect(out.myScorecard).toBeNull();
        expect(out.peers).toEqual({ visible: false, submittedCount: 0 });
    });

    it("shows recruiters and the requisition's manager every section", async () => {
        const r = await as(recruiter, () => forms.getInterviewForm(recruiter, { interviewId: 100 }));
        const m = await as(manager, () => forms.getInterviewForm(manager, { interviewId: 100 }));
        expect(r.form.sections.map((s) => s.key)).toEqual(["tech", "people"]);
        expect(m.form.sections.map((s) => s.key)).toEqual(["tech", "people"]);
    });

    it("is not found for someone outside the interview's scope", async () => {
        await expect(as(outsider, () => forms.getInterviewForm(outsider, { interviewId: 100 }))).rejects.toMatchObject({ status: 404 });
    });

    it("flags competencies the candidate scored below the section pass mark, with suggested questions", async () => {
        store.blueprints.push({ id: 80, tenantId: T, name: "Analyst test", testWeightPct: 40, passMarkPct: 60, sections: [{ key: "sql", label: "SQL", competencyKey: "sql", sectionPassMarkPct: 60 }, { key: "stats", competencyKey: "stats", sectionPassMarkPct: 50 }] });
        store.testResults.push({ id: 90, tenantId: T, interviewId: 100, blueprintId: 80, scorePct: 55, band: "BORDERLINE", decision: null, sectionScores: [{ key: "sql", scorePct: 40 }, { key: "stats", scorePct: 70 }], createdAt: new Date() });
        const out = await as(panelA, () => forms.getInterviewForm(panelA, { interviewId: 100 }));
        expect(out.probes).toHaveLength(1);
        expect(out.probes[0]).toMatchObject({ competencyKey: "sql", scorePct: 40, passMarkPct: 60 });
        expect(out.probes[0].suggestedQuestions.map((q) => q.questionKey)).toEqual(["q-sql"]);
        expect(out.testReport).toMatchObject({ scorePct: 55, band: "BORDERLINE" });
        expect(JSON.stringify(out.testReport)).not.toMatch(/answerKey|items/);
    });

    it("answers 503 with the flag off", async () => {
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
        await expect(as(panelA, () => forms.getInterviewForm(panelA, { interviewId: 100 }))).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED" });
    });
});

describe("hr_interview_scorecard_draft_save", () => {
    it("pins the form on first save, stamps startedAt once and draftSavedAt every time, merges ratings and never locks", async () => {
        const first = await as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, criterionScores: [{ key: "sql", rating: 3 }] }));
        expect(first.status).toBe("DRAFT");
        expect(store.interviews[0]).toMatchObject({ formTemplateId: 50, formTemplateVersion: 1 });
        const row = store.scorecards[0];
        expect(row).toMatchObject({ status: "DRAFT", submittedAt: null, templateId: 50, templateVersion: 1 });
        const started = row.startedAt;
        expect(first.live).toMatchObject({ weightedScore: 60, mustHaveFailed: false });

        await new Promise((r) => setTimeout(r, 5));
        const second = await as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, criterionScores: [{ key: "modelling", rating: 5 }], notes: "draft" }));
        const after = store.scorecards[0];
        expect(after.startedAt).toEqual(started);
        expect(after.draftSavedAt.getTime()).toBeGreaterThan(started.getTime());
        expect(after.criterionScores.criteria.sql.rating).toBe(3);
        expect(after.criterionScores.criteria.modelling.rating).toBe(5);
        expect(after.submittedAt).toBeNull();
        // sql 3 x 2 + modelling 5 x 1 over max 5 x 3 = 11/15
        expect(second.live.weightedScore).toBeCloseTo(73.33, 2);
        expect(second.live.missingEvidence).toEqual(["sql", "modelling"]);
    });

    it("reports a failed must-have live", async () => {
        const out = await as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, criterionScores: [{ key: "sql", rating: 2 }] }));
        expect(out.live).toMatchObject({ mustHaveFailed: true, mustHaveFailures: ["sql"], suggestion: "NOT_RECOMMENDED" });
    });

    it("refuses ratings off the scale and criteria outside the caller's sections", async () => {
        await expect(as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, criterionScores: [{ key: "sql", rating: 9 }] })))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-FORM-RATING-INVALID" });
        await expect(as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, criterionScores: [{ key: "communication", rating: 3 }] })))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-FORM-RATING-INVALID" });
    });

    it("is for panelists only", async () => {
        await expect(as(recruiter, () => forms.saveScorecardDraft(recruiter, { interviewId: 100 }))).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-FORM-PANEL-ONLY" });
    });

    it("refuses once the scorecard is submitted", async () => {
        await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        await expect(as(panelA, () => forms.saveScorecardDraft(panelA, { interviewId: 100, notes: "late" })))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SCORECARD-LOCKED" });
    });
});

describe("submit (hr_interview_score with a form)", () => {
    it("refuses an incomplete form with the reasons: declaration, evidence, required, recommendation", async () => {
        const err = await as(panelA, () => forms.submitEvaluationScorecard(panelA, {
            interviewId: 100, decision: "HOLD", criterionScores: [{ key: "sql", rating: 5 }],
        })).catch((e) => e);
        expect(err).toMatchObject({ status: 400, code: "HR-RECRUITMENT-FORM-INVALID" });
        expect(err.details.errors.map((e) => e.code).sort()).toEqual(["COI_NOT_DECLARED", "EVIDENCE_MISSING", "RECOMMENDATION_MISSING"]);
        expect(store.scorecards).toHaveLength(0);
    });

    it("submits, scores, locks and announces with ids only", async () => {
        const res = await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        expect(res.handled).toBe(true);
        expect(res.data).toMatchObject({ status: "SUBMITTED", weightedScore: 80, mustHaveFailed: false, notesFlagged: false, outcomeRecorded: false });
        const row = store.scorecards[0];
        expect(row).toMatchObject({ status: "SUBMITTED", weightedScore: 80, coiDeclared: true, recommendation: "HIRE", notes: "Clear and structured" });
        expect(row.criterionScores.decision).toBe("NEXT_ROUND");
        expect(new Date(row.submittedAt).getTime()).toBeGreaterThan(0);
        // The outcome is the hiring manager's: the interview is untouched.
        expect(store.interviews[0].decision).toBeNull();
        const [evt] = events("hr.recruitment.interview_scorecard_submitted.v1");
        expect(evt.payload.payload).toEqual({ interviewId: "100", applicationId: "11", scorecardId: String(row.id), reviewerId: "21", amended: false });
    });

    it("locks: a changed resubmit needs an amendment reason, which is logged and keeps submittedAt", async () => {
        await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        const submittedAt = store.scorecards[0].submittedAt;
        const changed = { ...goodA, criterionScores: [{ key: "sql", rating: 3 }] };
        await expect(as(panelA, () => forms.submitEvaluationScorecard(panelA, changed))).rejects.toMatchObject({ code: "HR-RECRUITMENT-SCORECARD-LOCKED" });
        const res = await as(panelA, () => forms.submitEvaluationScorecard(panelA, { ...changed, amendmentReason: "Misread the rubric" }));
        expect(res.data.action).toBe("amended");
        const row = store.scorecards[0];
        expect(row.amendmentLog).toHaveLength(1);
        expect(row.amendmentLog[0]).toMatchObject({ reason: "Misread the rubric", by: 21 });
        expect(row.submittedAt).toEqual(submittedAt);
        expect(events("hr.recruitment.interview_scorecard_submitted.v1").map((e) => e.payload.payload.amended)).toEqual([false, true]);
    });

    it("an identical resubmit is a no-op without events", async () => {
        await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        const res = await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        expect(res.data.action).toBe("unchanged");
        expect(events("hr.recruitment.interview_scorecard_submitted.v1")).toHaveLength(1);
    });

    it("flags prohibited topics to HR without blocking, and never puts the text or terms on the event", async () => {
        const res = await as(panelA, () => forms.submitEvaluationScorecard(panelA, { ...goodA, comments: "Asked if she is married; shadi next year" }));
        expect(res.data.notesFlagged).toBe(true);
        expect(JSON.stringify(res.data)).not.toMatch(/MARITAL|married/);
        const row = store.scorecards[0];
        expect(row.notesFlagged).toBe(true);
        expect(row.notesFlagTerms).toEqual(expect.arrayContaining(["MARITAL_STATUS:married", "MARITAL_STATUS:shadi"]));
        const [evt] = events("hr.recruitment.interview_notes_flagged.v1");
        expect(Object.keys(evt.payload.payload).sort()).toEqual(["applicationId", "interviewId", "reviewerId", "scorecardId"]);
        expect(JSON.stringify(evt)).not.toMatch(/married|shadi|MARITAL/);
    });

    it("requires a trained interviewer on forms marked so", async () => {
        store.templates[0].requiresTrainedInterviewer = true;
        await expect(as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA))).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-INTERVIEWER-TRAINING-REQUIRED" });
        store.employees.find((e) => e.id === 21).interviewerTrainedAt = new Date("2026-02-01");
        const res = await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        expect(res.data.status).toBe("SUBMITTED");
    });

    it("lets a recruiter submit on a panelist's behalf, nobody else", async () => {
        await expect(as(panelB, () => forms.submitEvaluationScorecard(panelB, { ...goodA, reviewerId: 21 }))).rejects.toMatchObject({ status: 403 });
        const res = await as(recruiter, () => forms.submitEvaluationScorecard(recruiter, { ...goodA, reviewerId: 21 }));
        expect(res.data.status).toBe("SUBMITTED");
        expect(store.scorecards[0].reviewerId).toBe(21);
    });

    it("hands back to the pre-form path when no form applies, or the flag is off", async () => {
        store.links.length = 0;
        expect(await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA))).toEqual({ handled: false });
        seed();
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
        expect(await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA))).toEqual({ handled: false });
        expect(store.scorecards).toHaveLength(0);
    });
});

describe("assessment gate on a decisive submission (7.7)", () => {
    it.each([
        ["REQUIRED", false], ["CHECKED_IN", false], ["IN_PROGRESS", false], ["FAILED", false], ["REVIEW", false],
        ["INCOMPLETE", false], ["RELEASED", false], ["PASSED", true], ["BORDERLINE", true], ["OVERRIDDEN", true], ["WAIVED", true],
    ])("assessmentStatus %s -> allowed %s", async (status, allowed) => {
        Object.assign(store.interviews[0], { assessmentRequired: true, assessmentStatus: status });
        const attempt = as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        if (allowed) await expect(attempt).resolves.toMatchObject({ handled: true });
        else await expect(attempt).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED" });
    });

    it("a HOLD submission is not decisive and is not gated", async () => {
        Object.assign(store.interviews[0], { assessmentRequired: true, assessmentStatus: "IN_PROGRESS" });
        await expect(as(panelA, () => forms.submitEvaluationScorecard(panelA, { ...goodA, decision: "HOLD" }))).resolves.toMatchObject({ handled: true });
    });
});

describe("independent scoring", () => {
    it("a panelist sees peers' ratings only after their own submission", async () => {
        await as(panelA, () => forms.submitEvaluationScorecard(panelA, goodA));
        const before = await as(panelB, () => forms.getInterviewForm(panelB, { interviewId: 100 }));
        expect(before.peers).toEqual({ visible: false, submittedCount: 1 });
        expect(JSON.stringify(before)).not.toMatch(/window query/);
        await as(panelB, () => forms.submitEvaluationScorecard(panelB, {
            interviewId: 100, criterionScores: [{ key: "communication", rating: 3 }], recommendation: "HIRE", decision: "HOLD", coiDeclared: true,
        }));
        const after = await as(panelB, () => forms.getInterviewForm(panelB, { interviewId: 100 }));
        expect(after.peers.visible).toBe(true);
        expect(after.peers.scorecards.map((c) => c.reviewerId)).toEqual([21]);
        // The prohibited-topic flag is HR's, not a peer's.
        expect(after.peers.scorecards[0]).not.toHaveProperty("notesFlagged");
    });
});

describe("debrief prompt", () => {
    it("fires when the last panelist's submission leaves a criterion divergent", async () => {
        store.interviewers[1].panelRole = "TECHNICAL";
        await as(panelA, () => forms.submitEvaluationScorecard(panelA, { ...goodA, criterionScores: [{ key: "sql", rating: 5, note: "excellent" }, { key: "modelling", notAssessed: true }] }));
        expect(events("hr.recruitment.interview_debrief_prompt.v1")).toHaveLength(0);
        await as(panelB, () => forms.submitEvaluationScorecard(panelB, {
            interviewId: 100, criterionScores: [{ key: "sql", rating: 3, note: "basic joins only" }, { key: "modelling", rating: 3 }], recommendation: "NO_HIRE", decision: "HOLD", coiDeclared: true,
        }));
        const [evt] = events("hr.recruitment.interview_debrief_prompt.v1");
        expect(evt.payload.payload).toEqual({ interviewId: "100", applicationId: "11", requisitionId: "5", hiringManagerEmployeeId: "30", divergentCount: 1 });
    });
});

describe("hr_interview_form_draft_ai", () => {
    it("stores the AI draft as a DRAFT form with DRAFT questions, filling missing anchors with review placeholders", async () => {
        process.env.HR_RECRUITMENT_AI = "true";
        runAiTask.mockResolvedValue({
            status: "ok",
            output: {
                result: {
                    sections: [{
                        key: "tech", label: "Technical",
                        criteria: [{ key: "sql", label: "SQL", competencyKey: "sql", anchors: { 1: "Cannot write a select", 5: "Optimises plans" }, questions: [{ prompt: "Explain an index", goodAnswerGuide: "B-tree" }] }],
                    }],
                },
            },
        });
        const out = await as(recruiter, () => forms.draftFormWithAi(recruiter, { requisitionId: 5 }));
        expect(out).toMatchObject({ advisory: true, aiDrafted: true, questionsCreated: 1 });
        const tpl = store.templates.find((t) => t.id === out.template.id);
        expect(tpl.status).toBe("DRAFT");
        const sql = tpl.sections[0].criteria[0];
        expect(sql.anchors["1"]).toBe("Cannot write a select");
        expect(sql.anchors["3"]).toMatch(/To be reviewed/);
        const q = store.questions.find((x) => x.aiDrafted);
        expect(q).toMatchObject({ status: "DRAFT", prompt: "Explain an index" });
        expect(sql.questionKeys).toEqual([q.questionKey]);
        expect(runAiTask).toHaveBeenCalledWith(expect.objectContaining({ promptKey: "hr.interview.form.draft.v1" }));
        // AI never rates: no scorecard was written.
        expect(store.scorecards).toHaveLength(0);
    });

    it("needs the ai flag", async () => {
        await expect(as(recruiter, () => forms.draftFormWithAi(recruiter, { requisitionId: 5 }))).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-AI-DISABLED" });
    });
});
