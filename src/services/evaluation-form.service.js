// src/services/evaluation-form.service.js
//
// Recruitment Phase 3b — the interviewer's evaluation form (plan 7.4.3 and
// 7.4.4, flag evaluationForms).
//
//   * OPENING. A panelist opens the form pinned on the interview (pinned at
//     scheduling, or on first save for interviews scheduled before the flag),
//     limited to the sections for their panel role. Recruiters and the
//     requisition's manager see every section. The form carries the anchors,
//     the linked bank questions, the test-informed probes (competencies where
//     the candidate scored below a section pass mark, with suggested
//     questions) and the caller's own draft or submitted scorecard.
//   * INDEPENDENT SCORING. A panelist sees peers' ratings only after their own
//     form is submitted.
//   * AUTOSAVE. A draft save stores ratings, notes and the recommendation,
//     stamps startedAt once and draftSavedAt every time, returns the live
//     weighted score and must-have status, and never locks.
//   * SUBMIT (hr_interview_score with a pinned form). validateSubmission must
//     pass (required criteria, evidence notes, the conflict-of-interest
//     declaration, a recommendation); the trained-interviewer requirement is
//     checked; notes are scanned for prohibited topics and FLAGGED to HR,
//     never blocked; the scorecard locks (amendments need a reason). A
//     decisive panelist decision needs the assessment gate open. Submitting
//     the form does not record the interview outcome: the hiring manager does
//     that with hr_interview_set_outcome, which freezes the report.
//   * EVENTS (ids only): interview_scorecard_submitted, interview_notes_flagged
//     to HR, and interview_debrief_prompt when the last panelist's submission
//     leaves divergent criteria.
//   * AI. hr_interview_form_draft_ai drafts criteria, anchors and questions for
//     a role as a DRAFT template (prompt key hr.interview.form.draft.v1); HR
//     reviews and publishes. AI never rates a candidate.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere, withTenant } from "../lib/tenancy.js";
import { employeeNamesById, nameOf } from "../lib/employee-names.util.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { interviewScopeWhere, requisitionScopeWhere } from "../lib/recruitment-access.util.js";
import { resolveAssessmentAccess } from "../lib/assessment-access.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { eventContext } from "../lib/event-context.util.js";
import { extractModelJson, runAiTask } from "../lib/aiPlaneClient.js";
import { scanProhibitedTopics } from "../lib/prohibited-topics.util.js";
import {
    DECISIVE_DECISIONS,
    FORM_RECOMMENDATIONS,
    INTERVIEW_DECISIONS,
    PANEL_ROLES,
    SCORECARD_STATUS,
    anchorKey,
    assertAssessmentGate,
    computeWeightedScore,
    consolidateForm,
    flattenCriteria,
    formForPanelRole,
    linkedQuestionKeys,
    mergeCriterionScores,
    scaleLevels,
    normalizeScale,
    storedCriteriaOf,
    storedDecisionOf,
    validateSubmission,
    weakCompetencies,
} from "../lib/evaluation-form.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
    adoptTenantlessScorecard,
    afterFormScorecardSubmitted,
    writeScorecardInTx,
} from "./interview-scorecard.service.js";
import { createFormTemplate, pinEvaluationFormForInterview, resolveForInterview } from "./scorecard-template.service.js";
import { createQuestion, publishedQuestionsFor } from "./interview-question.service.js";
import {
    REPORT_INTERVIEW_SELECT,
    assertEvaluationFormsEnabled,
    formForInterview,
    shapeCard,
    testSummaryFor,
} from "./evaluation-summary.service.js";
import { requisitionSkillRequirements } from "./candidate-match.service.js";

export const SCORECARD_SUBMITTED_EVENT = "hr.recruitment.interview_scorecard_submitted.v1";
export const NOTES_FLAGGED_EVENT = "hr.recruitment.interview_notes_flagged.v1";
export const DEBRIEF_PROMPT_EVENT = "hr.recruitment.interview_debrief_prompt.v1";
export const FORM_DRAFT_PROMPT_KEY = "hr.interview.form.draft.v1";

const fail = (message, status, code, details) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const text = (v, max = 10000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// ── Events (ids only) ────────────────────────────────────────────────────────

const idOrNull = (v) => (v === null || v === undefined ? null : String(v));

function interviewEvent(eventName, { tenantId, interviewId }, payload, ctx = {}) {
    if (!tenantId) return null;
    return {
        eventName,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: { interviewId: String(interviewId), ...payload },
    };
}

/** hr.recruitment.interview_scorecard_submitted.v1 */
export const scorecardSubmittedEvent = ({ tenantId, interviewId, applicationId, scorecardId, reviewerId, amended = false }, ctx) =>
    interviewEvent(SCORECARD_SUBMITTED_EVENT, { tenantId, interviewId }, {
        applicationId: idOrNull(applicationId),
        scorecardId: idOrNull(scorecardId),
        reviewerId: idOrNull(reviewerId),
        amended: amended === true,
    }, ctx);

/** hr.recruitment.interview_notes_flagged.v1 — to HR; never the text or the terms. */
export const notesFlaggedEvent = ({ tenantId, interviewId, applicationId, scorecardId, reviewerId }, ctx) =>
    interviewEvent(NOTES_FLAGGED_EVENT, { tenantId, interviewId }, {
        applicationId: idOrNull(applicationId),
        scorecardId: idOrNull(scorecardId),
        reviewerId: idOrNull(reviewerId),
    }, ctx);

/** hr.recruitment.interview_debrief_prompt.v1 — the hiring manager is asked to debrief. */
export const debriefPromptEvent = ({ tenantId, interviewId, applicationId, requisitionId, hiringManagerEmployeeId, divergentCount }, ctx) =>
    interviewEvent(DEBRIEF_PROMPT_EVENT, { tenantId, interviewId }, {
        applicationId: idOrNull(applicationId),
        requisitionId: idOrNull(requisitionId),
        hiringManagerEmployeeId: idOrNull(hiringManagerEmployeeId),
        divergentCount: Number(divergentCount) || 0,
    }, ctx);

// ── Shared reads ─────────────────────────────────────────────────────────────

/** The interview under the caller's row scope, with the report's columns. */
async function scopedInterview(client, user, interviewId, access) {
    const id = positiveInt(interviewId);
    const interview = id
        ? await client.interview.findFirst({
            where: withTenant(user.tenantId, { id, ...interviewScopeWhere(access.scope) }),
            select: { ...REPORT_INTERVIEW_SELECT, application: { select: { ...REPORT_INTERVIEW_SELECT.application.select, jobRequisition: { select: { id: true, title: true, requestedById: true, positionId: true } } } } },
        })
        : null;
    if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-INTERVIEW-NOT-FOUND");
    return interview;
}

const membershipOf = (interview, employeeId) =>
    employeeId ? (interview.interviewers ?? []).find((i) => Number(i.employeeId) === Number(employeeId)) ?? null : null;

const isManagerOf = (interview, employeeId) =>
    Boolean(employeeId) && Number(interview.application?.jobRequisition?.requestedById) === Number(employeeId);

/** Is the interviewer trained, when the form asks for it? */
async function trainingStatus(client, tenantId, template, employeeId) {
    if (!template?.requiresTrainedInterviewer) return { required: false, trained: null };
    const emp = employeeId
        ? await client.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id: Number(employeeId) }), select: { interviewerTrainedAt: true } })
        : null;
    return { required: true, trained: Boolean(emp?.interviewerTrainedAt) };
}

function assertTrained(training) {
    if (training.required && !training.trained) {
        throw fail("This form needs an interviewer who has completed interviewer training", 403, "HR-RECRUITMENT-INTERVIEWER-TRAINING-REQUIRED");
    }
}

/** The template pinned on the interview, read on the given client. */
async function pinnedTemplate(client, tenantId, interview) {
    if (!interview.formTemplateId) return null;
    const { template } = await formForInterview(client, tenantId, interview);
    return template;
}

/** The questions and probes the form shows. */
async function formExtras(client, tenantId, interview, view) {
    const test = await testSummaryFor(client, tenantId, interview);
    const weak = weakCompetencies(test?.sections ?? []);
    const { byKey, byCompetency } = await publishedQuestionsFor(client, tenantId, {
        keys: linkedQuestionKeys(view),
        competencyKeys: [...new Set(weak.map((s) => s.competencyKey))],
    });
    const question = (q) => ({ id: q.id, questionKey: q.questionKey, version: q.version, competencyKey: q.competencyKey, prompt: q.prompt, followUps: q.followUps ?? [], goodAnswerGuide: q.goodAnswerGuide ?? null, level: q.level ?? null });
    const probes = weak.map((s) => ({
        competencyKey: s.competencyKey,
        sectionKey: s.key,
        label: s.label,
        scorePct: s.scorePct,
        passMarkPct: s.passMarkPct,
        suggestedQuestions: (byCompetency[s.competencyKey] ?? []).map(question),
    }));
    // The test report beside the form: scores and bands only, never items or keys.
    const testReport = test
        ? { required: test.required, assessmentStatus: test.assessmentStatus, waived: test.waived, scorePct: test.scorePct, band: test.band, percentile: test.percentile, integrityFlagCount: test.integrityFlagCount, sections: test.sections }
        : null;
    return { questions: Object.fromEntries(Object.entries(byKey).map(([k, q]) => [k, question(q)])), probes, testReport };
}

// ── hr_interview_form_get ────────────────────────────────────────────────────

/**
 * The form for the caller on one interview. Read-only: an unpinned interview
 * shows the form that would be pinned (pinned: false).
 */
export async function getInterviewForm(user, { interviewId } = {}) {
    assertEvaluationFormsEnabled();
    const access = resolveAssessmentAccess(user);
    const tenantId = user.tenantId;
    const interview = await scopedInterview(prisma, user, interviewId, access);
    const me = access.employeeId;
    const member = membershipOf(interview, me);
    const seesAll = access.recruiter || isManagerOf(interview, me);
    if (!member && !seesAll) throw fail("Interview not found", 404, "HR-RECRUITMENT-INTERVIEW-NOT-FOUND");

    let template = await pinnedTemplate(prisma, tenantId, interview);
    const pinned = Boolean(template);
    if (!template) template = await resolveForInterview({ interviewId: interview.id, tenantId });
    if (!template) return { interviewId: interview.id, form: null, reason: "NO_FORM" };

    const { form, template: formTemplate } = await formForInterview(prisma, tenantId, { ...interview, formTemplateId: template.id });
    // Phase 7 (B10) — the form's author by name (one lookup).
    const authorId = formTemplate?.createdById ?? template.createdById ?? null;
    const authorNames = await employeeNamesById(prisma, tenantId, [authorId]);
    const panelRole = member?.panelRole ?? null;
    const view = member && !seesAll ? formForPanelRole(form, panelRole) : form;
    const extras = await formExtras(prisma, tenantId, interview, view);
    const training = member ? await trainingStatus(prisma, tenantId, template, me) : { required: template.requiresTrainedInterviewer === true, trained: null };

    const own = member ? (interview.scorecards ?? []).find((c) => Number(c.reviewerId) === Number(me)) ?? null : null;
    const ownSubmitted = Boolean(own?.submittedAt);
    const submitted = (interview.scorecards ?? []).filter((c) => c.submittedAt && Number(c.reviewerId) !== Number(me));
    // Independent scoring: a panelist sees peers only after their own submission.
    const peersVisible = !member || ownSubmitted;
    const candidate = interview.application?.candidate;

    return {
        interviewId: interview.id,
        header: {
            candidate: candidate ? [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim() || null : null,
            requisition: interview.application?.jobRequisition?.title ?? null,
            interviewType: interview.interviewType,
            scheduledAt: interview.scheduledAt,
            durationMinutes: interview.durationMinutes ?? null,
            panelRole,
        },
        pinned,
        form: {
            templateId: template.id,
            templateKey: template.templateKey ?? null,
            version: template.version ?? 1,
            name: template.name,
            scale: form.scale,
            evidenceRules: form.evidenceRules,
            requiresTrainedInterviewer: template.requiresTrainedInterviewer === true,
            createdById: authorId,
            createdByName: nameOf(authorNames, authorId),
            sections: view.sections,
        },
        questions: extras.questions,
        probes: extras.probes,
        testReport: extras.testReport,
        training,
        assessment: { required: interview.assessmentRequired === true, status: interview.assessmentStatus ?? "NOT_REQUIRED" },
        myScorecard: own ? { ...shapeCard(own, { form, interview }), live: computeWeightedScore(view, storedCriteriaOf(own)) } : null,
        peers: peersVisible
            ? { visible: true, scorecards: submitted.map((c) => shapeCard(c, { form, interview, showFlag: access.recruiter })) }
            : { visible: false, submittedCount: submitted.length },
    };
}

// ── Draft autosave and submit ────────────────────────────────────────────────

/** Merge an autosave or submission over the stored draft, per criterion. */
function mergedState(own, input) {
    const stored = own ? storedCriteriaOf(own) : {};
    return {
        criteria: input.criterionScores === undefined ? stored : mergeCriterionScores(stored, input.criterionScores),
        notes: input.notes !== undefined ? text(input.notes) : own?.notes ?? null,
        recommendation: input.recommendation !== undefined ? input.recommendation ?? null : own?.recommendation ?? null,
        coiDeclared: input.coiDeclared !== undefined ? input.coiDeclared === true : own?.coiDeclared === true,
        decision: input.decision !== undefined ? input.decision ?? null : storedDecisionOf(own),
    };
}

/** The scorecard columns for a form state. */
function formRow(state, live, template, extra = {}) {
    const ratings = {};
    for (const [key, entry] of Object.entries(state.criteria)) {
        if (!entry.notAssessed && entry.rating !== null && entry.rating !== undefined) ratings[key] = entry.rating;
    }
    return {
        scores: ratings,
        overallScore: live.meanRating,
        criterionScores: { criteria: state.criteria, decision: state.decision ?? null },
        notes: state.notes,
        recommendation: state.recommendation,
        coiDeclared: state.coiDeclared,
        templateId: template.id,
        templateVersion: template.version ?? 1,
        weightedScore: live.weightedScore,
        mustHaveFailed: live.mustHaveFailed,
        ...extra,
    };
}

const liveView = (live) => ({
    weightedScore: live.weightedScore,
    mustHaveFailed: live.mustHaveFailed,
    mustHaveFailures: live.mustHaveFailures,
    missingRequired: live.missingRequired,
    missingEvidence: live.missingEvidence,
    completeness: live.total ? Math.round((live.answered / live.total) * 100) : 0,
    suggestion: live.suggestion,
});

/**
 * Inside the tenant transaction: pin (if needed), load the pinned template
 * and the caller's row. Returns null when no form resolves.
 */
async function formContext(tx, tenantId, interview, reviewerId) {
    const pin = await pinEvaluationFormForInterview(tx, { tenantId, interviewId: interview.id });
    if (!pin) return null;
    const { template, form } = await formForInterview(tx, tenantId, { ...interview, formTemplateId: pin.templateId });
    if (!template) return null;
    const own = await tx.interviewScorecard.findFirst({ where: withTenant(tenantId, { interviewId: interview.id, reviewerId: Number(reviewerId) }) });
    return { template, form, own };
}

function assertRecommendation(value) {
    if (value !== null && value !== undefined && !FORM_RECOMMENDATIONS.includes(value)) {
        throw fail(`recommendation must be one of ${FORM_RECOMMENDATIONS.join(", ")}`, 400, "HR-RECRUITMENT-FORM-INVALID");
    }
}

function assertDecision(value) {
    if (value !== null && value !== undefined && !INTERVIEW_DECISIONS.includes(value)) {
        throw fail(`decision must be one of ${INTERVIEW_DECISIONS.join(", ")}`, 400, "HR-RECRUITMENT-FORM-INVALID");
    }
}

/**
 * hr_interview_scorecard_draft_save: autosave the caller's DRAFT. Never locks;
 * a submitted scorecard changes only through an amendment on submit.
 */
export async function saveScorecardDraft(user, input = {}) {
    assertEvaluationFormsEnabled();
    const access = resolveAssessmentAccess(user);
    const tenantId = user.tenantId;
    const interview = await scopedInterview(prisma, user, input.interviewId, access);
    const me = access.employeeId;
    const member = membershipOf(interview, me);
    if (!member) throw fail("Only a panelist on this interview can fill its form", 403, "HR-RECRUITMENT-FORM-PANEL-ONLY");
    assertRecommendation(input.recommendation);
    assertDecision(input.decision);
    await adoptTenantlessScorecard({ interviewId: interview.id, reviewerId: me, tenantId });

    const now = new Date();
    return tenantTransaction(
        prisma,
        async (tx) => {
            const ctx = await formContext(tx, tenantId, interview, me);
            if (!ctx) throw fail("No evaluation form applies to this interview", 404, "HR-RECRUITMENT-EVALUATION-FORM-NOT-FOUND");
            assertTrained(await trainingStatus(tx, tenantId, ctx.template, me));
            if (ctx.own?.submittedAt) {
                throw fail("This scorecard has been submitted; change it by resubmitting with an amendment reason", 409, "HR-RECRUITMENT-SCORECARD-LOCKED");
            }
            const view = formForPanelRole(ctx.form, member.panelRole);
            const state = mergedState(ctx.own, input);
            const live = computeWeightedScore(view, state.criteria);
            if (live.invalidRatings.length || live.unknownCriteria.length) {
                throw fail("Some ratings are not on the form's scale or not on the form", 400, "HR-RECRUITMENT-FORM-RATING-INVALID", {
                    invalidRatings: live.invalidRatings,
                    unknownCriteria: live.unknownCriteria,
                });
            }
            const { row } = await writeScorecardInTx(tx, {
                interviewId: interview.id,
                reviewerId: me,
                tenantId,
                data: formRow(state, live, ctx.template, {
                    status: SCORECARD_STATUS.DRAFT,
                    startedAt: ctx.own?.startedAt ?? now,
                    draftSavedAt: now,
                }),
            });
            return {
                interviewId: interview.id,
                scorecardId: row.id,
                status: SCORECARD_STATUS.DRAFT,
                startedAt: row.startedAt ?? now,
                draftSavedAt: row.draftSavedAt ?? now,
                live: liveView(live),
            };
        },
        { tenantId },
    );
}

/** Every active panelist (assignment not declined) has submitted. */
const panelComplete = (interview, cards) => {
    const done = new Set(cards.filter((c) => c.submittedAt).map((c) => Number(c.reviewerId)));
    const active = (interview.interviewers ?? []).filter((i) => String(i.status ?? "").toLowerCase() !== "declined");
    return active.length > 0 && active.every((i) => done.has(Number(i.employeeId)));
};

/**
 * The form path of hr_interview_score. Returns { handled: false } when no form
 * applies to the interview (the caller then takes the pre-form path).
 *
 * @returns {Promise<{ handled: boolean, data?: object }>}
 */
export async function submitEvaluationScorecard(user, input = {}) {
    if (!isRecruitmentFlagEnabled("evaluationForms")) return { handled: false };
    const access = resolveAssessmentAccess(user);
    const tenantId = user.tenantId;
    const interview = await scopedInterview(prisma, user, input.interviewId, access);
    const reviewerId = positiveInt(input.reviewerId) ?? access.employeeId;
    if (!reviewerId) throw fail("A reviewer (employee) id is required to submit interview feedback", 400, "HR-RECRUITMENT-SCORECARD-REVIEWER-REQUIRED");
    // Submitting on someone's behalf is a recruiter's act.
    if (reviewerId !== access.employeeId && !access.recruiter) {
        throw fail("You can submit only your own evaluation form", 403, "HR-RECRUITMENT-FORM-PANEL-ONLY");
    }
    const member = membershipOf(interview, reviewerId);
    const decision = input.decision ?? null;
    assertDecision(decision);
    assertRecommendation(input.recommendation);

    // Without a form, nothing here applies: the pre-form path takes over.
    if (!interview.formTemplateId) {
        const resolvable = await resolveForInterview({ interviewId: interview.id, tenantId });
        if (!resolvable) return { handled: false };
    }
    if (!member) throw fail("Only a panelist on this interview can submit its form", 403, "HR-RECRUITMENT-FORM-PANEL-ONLY");
    if (DECISIVE_DECISIONS.includes(decision)) assertAssessmentGate(interview);
    await adoptTenantlessScorecard({ interviewId: interview.id, reviewerId, tenantId });

    const now = new Date();
    const evtCtx = eventContext({ actorId: access.employeeId });
    const outcome = await tenantTransaction(
        prisma,
        async (tx) => {
            const ctx = await formContext(tx, tenantId, interview, reviewerId);
            if (!ctx) return { handled: false };
            assertTrained(await trainingStatus(tx, tenantId, ctx.template, reviewerId));
            const view = formForPanelRole(ctx.form, member.panelRole);
            const state = mergedState(ctx.own, { ...input, notes: input.notes ?? input.comments });
            const verdict = validateSubmission(view, { criterionScores: state.criteria, recommendation: state.recommendation, coiDeclared: state.coiDeclared });
            if (!verdict.ok) {
                throw fail("The evaluation form is incomplete", 400, "HR-RECRUITMENT-FORM-INVALID", {
                    errors: verdict.errors,
                    missingRequired: verdict.score.missingRequired,
                    missingEvidence: verdict.score.missingEvidence,
                });
            }
            // Flag, never block: the terms stay on the row for HR.
            const scan = scanProhibitedTopics(state.notes, Object.values(state.criteria).map((e) => e.note));
            const amendment = text(input.amendmentReason) ? { reason: text(input.amendmentReason), by: access.employeeId ?? null } : null;
            const { row, action } = await writeScorecardInTx(tx, {
                interviewId: interview.id,
                reviewerId,
                tenantId,
                amendment,
                data: formRow(state, verdict.score, ctx.template, {
                    status: SCORECARD_STATUS.SUBMITTED,
                    submittedAt: now,
                    startedAt: ctx.own?.startedAt ?? now,
                    notesFlagged: scan.flagged,
                    notesFlagTerms: scan.terms,
                }),
            });
            if (action !== "unchanged") {
                const base = { tenantId, interviewId: interview.id, applicationId: interview.applicationId, scorecardId: row.id, reviewerId };
                await enqueueHrDomainEvent(tx, scorecardSubmittedEvent({ ...base, amended: action === "amended" }, evtCtx));
                if (scan.flagged) await enqueueHrDomainEvent(tx, notesFlaggedEvent(base, evtCtx));
                if (action !== "amended") await maybeDebriefPrompt(tx, tenantId, interview, ctx.form, evtCtx);
            }
            return { handled: true, row, action, verdict, scan };
        },
        { tenantId },
    );
    if (!outcome.handled) return { handled: false };
    if (outcome.action === "created" || outcome.action === "updated") await afterFormScorecardSubmitted(outcome.row, tenantId);
    logger.info({ tenantId, interviewId: interview.id, reviewerId, action: outcome.action, notesFlagged: outcome.scan.flagged }, "evaluation form submitted");
    return {
        handled: true,
        data: {
            interviewId: interview.id,
            scorecardId: outcome.row.id,
            status: SCORECARD_STATUS.SUBMITTED,
            action: outcome.action,
            submittedAt: outcome.row.submittedAt ?? now,
            weightedScore: outcome.verdict.score.weightedScore,
            mustHaveFailed: outcome.verdict.score.mustHaveFailed,
            mustHaveFailures: outcome.verdict.score.mustHaveFailures,
            suggestion: outcome.verdict.score.suggestion,
            // The interviewer learns their notes went to HR review, never which terms.
            notesFlagged: outcome.scan.flagged,
            decision,
            // The hiring manager records the outcome (hr_interview_set_outcome).
            outcomeRecorded: false,
        },
    };
}

/** When the last panelist submits and criteria diverge, prompt a debrief. */
async function maybeDebriefPrompt(tx, tenantId, interview, form, evtCtx) {
    const cards = await tx.interviewScorecard.findMany({
        where: withTenant(tenantId, { interviewId: interview.id, submittedAt: { not: null } }),
        select: { reviewerId: true, submittedAt: true, scores: true, criterionScores: true, weightedScore: true, overallScore: true, mustHaveFailed: true, recommendation: true },
    });
    if (!panelComplete(interview, cards)) return false;
    const { divergentCriteria } = consolidateForm(form, cards);
    if (!divergentCriteria.length) return false;
    await enqueueHrDomainEvent(
        tx,
        debriefPromptEvent(
            {
                tenantId,
                interviewId: interview.id,
                applicationId: interview.applicationId,
                requisitionId: interview.application?.jobRequisitionId ?? null,
                hiringManagerEmployeeId: interview.application?.jobRequisition?.requestedById ?? null,
                divergentCount: divergentCriteria.length,
            },
            evtCtx,
        ),
    );
    return true;
}

// ── hr_interview_form_draft_ai ───────────────────────────────────────────────

const AI_PLACEHOLDER = "To be reviewed: describe the observable behaviour for this level.";

/** Turn the model's draft into a form definition the validator accepts. */
export function formFromAiDraft(output, { scale = "1-5", panelRole = null } = {}) {
    const formScale = normalizeScale(scale);
    const levels = scaleLevels(formScale).map((l) => anchorKey(formScale, l));
    const sections = Array.isArray(output?.sections) ? output.sections : [];
    const questions = [];
    const shaped = sections.slice(0, 8).map((s, si) => ({
        key: text(s?.key, 60)?.replace(/[^A-Za-z0-9_.-]/g, "_") ?? `section_${si + 1}`,
        label: text(s?.label, 200) ?? `Section ${si + 1}`,
        panelRoles: Array.isArray(s?.panelRoles) ? s.panelRoles.map((r) => String(r).toUpperCase()).filter((r) => PANEL_ROLES.includes(r)) : panelRole ? [panelRole] : [],
        criteria: (Array.isArray(s?.criteria) ? s.criteria : []).slice(0, 10).map((c, ci) => {
            const key = text(c?.key, 60)?.replace(/[^A-Za-z0-9_.-]/g, "_") ?? `s${si + 1}_c${ci + 1}`;
            const anchors = {};
            for (const level of levels) anchors[level] = text(c?.anchors?.[level], 500) ?? AI_PLACEHOLDER;
            const criterionKey = /^[A-Za-z]/.test(key) ? key : `c_${key}`;
            for (const q of (Array.isArray(c?.questions) ? c.questions : []).slice(0, 3)) {
                const prompt = text(typeof q === "string" ? q : q?.prompt, 2000);
                if (!prompt) continue;
                questions.push({ criterionKey, competencyKey: text(c?.competencyKey, 100) ?? key, prompt, followUps: Array.isArray(q?.followUps) ? q.followUps : [], goodAnswerGuide: text(q?.goodAnswerGuide, 2000) });
            }
            return {
                key: criterionKey,
                label: text(c?.label, 200) ?? key,
                description: text(c?.description, 1000),
                competencyKey: text(c?.competencyKey, 100) ?? key,
                weight: Number(c?.weight) > 0 ? Number(c.weight) : 1,
                required: c?.required !== false,
                mustHave: c?.mustHave === true,
                anchors,
                questionKeys: [],
            };
        }),
    })).filter((s) => s.criteria.length);
    for (const s of shaped) if (!/^[A-Za-z]/.test(s.key)) s.key = `s_${s.key}`;
    return { scale: formScale, sections: shaped, questions };
}

/**
 * Draft a form for a role with the AI plane and store it as a DRAFT template,
 * with its suggested questions as DRAFT bank entries linked to the criteria.
 */
export async function draftFormWithAi(user, { requisitionId, name, interviewType = null, panelRole = null, scale = "1-5" } = {}) {
    assertEvaluationFormsEnabled();
    if (!isRecruitmentFlagEnabled("ai")) throw fail("AI assistance is not enabled", 503, "HR-RECRUITMENT-AI-DISABLED");
    const access = resolveAssessmentAccess(user);
    const tenantId = user.tenantId;
    const id = positiveInt(requisitionId);
    const requisition = id
        ? await prisma.jobRequisition.findFirst({
            where: withTenant(tenantId, { id, ...requisitionScopeWhere(access.scope) }),
            select: { id: true, title: true, description: true, requirements: true, jobContent: true },
        })
        : null;
    if (!requisition) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    const skills = requisitionSkillRequirements(requisition) ?? { required: [], preferred: [] };

    let res;
    try {
        res = await runAiTask({
            promptKey: FORM_DRAFT_PROMPT_KEY,
            type: "hr.interview_form_draft",
            tenantId,
            input: {
                title: requisition.title,
                summary: requisition.jobContent?.summary ?? requisition.description ?? null,
                requiredSkills: skills.required ?? [],
                preferredSkills: skills.preferred ?? [],
                interviewType,
                panelRole,
                panelRoles: PANEL_ROLES,
                scale,
                instructions: "Draft sections of criteria with a behavioural anchor for every rating level and suggested questions. Never rate a candidate.",
            },
            correlationId: `form-draft:${requisition.id}`,
        });
    } catch (err) {
        logger.warn({ tenantId, requisitionId: requisition.id, code: err?.code }, "interview form AI draft unavailable");
        throw fail("The AI service is unavailable; try again later", 503, "HR-RECRUITMENT-AI-UNAVAILABLE");
    }
    if (res?.status !== "ok" || res?.error) {
        throw fail(res?.pending ? "The AI draft is still running; try again shortly" : "The AI draft failed", 502, "HR-RECRUITMENT-AI-DRAFT-FAILED");
    }
    const output = res.output?.result && typeof res.output.result === "object" ? res.output.result : extractModelJson(res.output?.text ?? res.output);
    const draft = formFromAiDraft(output, { scale, panelRole });
    if (!draft.sections.length) throw fail("The AI draft had no usable criteria", 502, "HR-RECRUITMENT-AI-DRAFT-FAILED");

    // Questions first (DRAFT, AI-drafted), then the template that links them.
    const byCriterion = {};
    for (const q of draft.questions.slice(0, 30)) {
        const row = await createQuestion({ tenantId, actorId: access.employeeId, competencyKey: q.competencyKey, prompt: q.prompt, followUps: q.followUps, goodAnswerGuide: q.goodAnswerGuide, aiDrafted: true });
        (byCriterion[q.criterionKey] ??= []).push(row.questionKey);
    }
    for (const c of flattenCriteria(draft)) {
        const target = draft.sections.find((s) => s.key === c.sectionKey).criteria.find((x) => x.key === c.key);
        target.questionKeys = byCriterion[c.key] ?? [];
    }
    const template = await createFormTemplate({
        name: text(name, 200) ?? `${requisition.title} interview form`,
        description: "AI-drafted; review every anchor and question before publishing.",
        tenantId,
        actorId: access.employeeId,
        scale: draft.scale,
        sections: draft.sections,
        interviewType: interviewType ?? undefined,
        panelRole: panelRole ?? undefined,
        status: "DRAFT",
        aiDrafted: true,
    });
    return { advisory: true, aiDrafted: true, template, questionsCreated: Object.values(byCriterion).flat().length };
}
