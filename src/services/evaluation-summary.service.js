// src/services/evaluation-summary.service.js
//
// Recruitment Phase 3b — the candidate evaluation report (plan 7.4.5) and its
// frozen snapshot (flag evaluationForms).
//
// The report combines the pre-interview test and the panel's evaluation forms:
//   * test score: the result's percentage, excluded when the test was waived
//     or not required;
//   * interview score: the panelists' weighted scores averaged;
//   * composite: test weight x test + interview weight x interview, weights
//     from the blueprint (default 30 / 70);
//   * must-have alerts from any panelist, the recommendation tally, divergent
//     criteria and an advisory rank among the requisition's candidates.
//
// The rules this file holds:
//   * FROZEN AT OUTCOME. setInterviewOutcome calls freezeEvaluationSummary in
//     its own transaction when a decisive outcome is recorded: one summary per
//     interview (unique), written once and never rewritten, so a later template
//     or weight change cannot rewrite history. Only pdfMediaId is set later.
//   * WHO SEES IT. Recruiters (ORG) and the requisition's hiring manager read
//     the full report (the frozen snapshot once it exists). A panelist reads
//     only their own form. The prohibited-topic flag is shown to recruiters
//     (HR) only.
//   * The rank is advisory: it compares composites and decides nothing.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { interviewScopeWhere } from "../lib/recruitmentAccess.js";
import { resolveAssessmentAccess } from "../lib/assessment-access.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    DEFAULT_TEST_WEIGHT_PCT,
    compositeScore,
    computeWeightedScore,
    consolidateForm,
    formFromTemplate,
    formForPanelRole,
    interviewScoreOf,
    rankAmong,
    storedCriteriaOf,
    storedDecisionOf,
    testSectionsOf,
} from "../lib/evaluation-form.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { FORM_TEMPLATE_SELECT } from "./scorecardTemplate.service.js";
import { generateEvaluationReportPdf, uploadEvaluationReportPdf } from "./evaluation-report-pdf.service.js";

export const EVALUATION_SUMMARY_FROZEN_EVENT = "hr.recruitment.evaluation_summary_frozen.v1";

const RANK_SCAN_CAP = 500;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

export const assertEvaluationFormsEnabled = () => {
    if (!isRecruitmentFlagEnabled("evaluationForms")) {
        throw fail("Evaluation forms are not enabled", 503, "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED");
    }
};

const personName = (emp) => {
    if (!emp) return null;
    const joined = [emp.first_name, emp.last_name].filter(Boolean).join(" ").trim();
    return emp.employee_name || joined || null;
};

const NAME_SELECT = Object.freeze({ id: true, employee_name: true, first_name: true, last_name: true });

export const REPORT_INTERVIEW_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    interviewType: true,
    scheduledAt: true,
    durationMinutes: true,
    status: true,
    decision: true,
    assessmentRequired: true,
    assessmentStatus: true,
    assessmentBlueprintId: true,
    assessmentWaivedReason: true,
    formTemplateId: true,
    formTemplateVersion: true,
    application: {
        select: {
            id: true,
            candidateId: true,
            jobRequisitionId: true,
            candidate: { select: { id: true, firstName: true, lastName: true } },
            jobRequisition: { select: { id: true, title: true, requestedById: true } },
        },
    },
    interviewers: { select: { employeeId: true, status: true, panelRole: true, employee: { select: NAME_SELECT } } },
    scorecards: {
        select: {
            id: true,
            reviewerId: true,
            scores: true,
            overallScore: true,
            recommendation: true,
            notes: true,
            submittedAt: true,
            status: true,
            criterionScores: true,
            weightedScore: true,
            mustHaveFailed: true,
            coiDeclared: true,
            templateId: true,
            templateVersion: true,
            notesFlagged: true,
            notesFlagTerms: true,
            startedAt: true,
            draftSavedAt: true,
            lastAmendedAt: true,
            amendmentLog: true,
            reviewer: { select: NAME_SELECT },
        },
    },
});

// ── Pieces of the report ─────────────────────────────────────────────────────

/** The form the interview's scorecards were written against. */
export async function formForInterview(client, tenantId, interview) {
    const templateId = interview.formTemplateId ?? interview.scorecards?.find((c) => c.templateId)?.templateId ?? null;
    if (templateId) {
        const template = await client.scorecardTemplate.findFirst({
            where: withTenant(tenantId, { id: templateId }),
            select: FORM_TEMPLATE_SELECT,
        });
        if (template) return { template, form: formFromTemplate(template) };
    }
    // No form: the ratings the scorecards carry, on the default scale.
    const keys = [...new Set((interview.scorecards ?? []).flatMap((c) => Object.keys(storedCriteriaOf(c))))];
    return { template: null, form: formFromTemplate({ name: "Scorecard", criteria: keys.map((key) => ({ key })) }) };
}

/** The pre-interview test as the report shows it; null when there is none. */
export async function testSummaryFor(client, tenantId, interview) {
    const result = await client.candidateTestResult.findFirst({
        where: withTenant(tenantId, { interviewId: interview.id }),
        orderBy: { createdAt: "desc" },
        select: { id: true, blueprintId: true, scorePct: true, band: true, decision: true, sectionScores: true, percentile: true, integrityFlagCount: true, createdAt: true },
    });
    const blueprintId = result?.blueprintId ?? interview.assessmentBlueprintId ?? null;
    const blueprint = blueprintId
        ? await client.candidateTestBlueprint.findFirst({
            where: withTenant(tenantId, { id: blueprintId }),
            select: { id: true, name: true, testWeightPct: true, passMarkPct: true, sections: true },
        })
        : null;
    if (!result && !interview.assessmentRequired) return null;
    const waived = interview.assessmentStatus === "WAIVED" || result?.decision === "WAIVE";
    const scorePct = typeof result?.scorePct === "number" ? result.scorePct : null;
    return {
        required: interview.assessmentRequired === true,
        assessmentStatus: interview.assessmentStatus ?? null,
        waived,
        waiverReason: waived ? interview.assessmentWaivedReason ?? null : null,
        included: interview.assessmentRequired === true && !waived && scorePct !== null,
        resultId: result?.id ?? null,
        scorePct,
        band: result?.band ?? null,
        decision: result?.decision ?? null,
        percentile: result?.percentile ?? null,
        integrityFlagCount: result?.integrityFlagCount ?? 0,
        sections: result ? testSectionsOf(result.sectionScores, blueprint) : [],
        blueprintId,
        testWeightPct: typeof blueprint?.testWeightPct === "number" ? blueprint.testWeightPct : DEFAULT_TEST_WEIGHT_PCT,
    };
}

const submittedOf = (interview) => (interview.scorecards ?? []).filter((c) => Boolean(c.submittedAt));

const panelRoleOf = (interview, reviewerId) =>
    (interview.interviewers ?? []).find((i) => Number(i.employeeId) === Number(reviewerId))?.panelRole ?? null;

/** One scorecard as the report and the form show it. */
export function shapeCard(card, { form = null, interview = null, showFlag = false } = {}) {
    const criteria = storedCriteriaOf(card);
    const panelRole = interview ? panelRoleOf(interview, card.reviewerId) : null;
    const live = form ? computeWeightedScore(formForPanelRole(form, panelRole), criteria) : null;
    return {
        scorecardId: card.id ?? null,
        reviewerId: card.reviewerId,
        reviewer: personName(card.reviewer),
        panelRole,
        status: card.submittedAt ? "SUBMITTED" : card.status ?? "DRAFT",
        criteria,
        decision: storedDecisionOf(card),
        recommendation: card.recommendation ?? null,
        notes: card.notes ?? null,
        coiDeclared: card.coiDeclared === true,
        weightedScore: typeof card.weightedScore === "number" ? card.weightedScore : live?.weightedScore ?? null,
        mustHaveFailed: card.mustHaveFailed === true,
        mustHaveFailures: live?.mustHaveFailures ?? [],
        submittedAt: card.submittedAt ?? null,
        startedAt: card.startedAt ?? null,
        draftSavedAt: card.draftSavedAt ?? null,
        amendedAt: card.lastAmendedAt ?? null,
        amendmentCount: Array.isArray(card.amendmentLog) ? card.amendmentLog.length : 0,
        // HR only: the flag and the terms found (never shown to a candidate).
        ...(showFlag ? { notesFlagged: card.notesFlagged === true, notesFlagTerms: Array.isArray(card.notesFlagTerms) ? card.notesFlagTerms : [] } : {}),
    };
}

/**
 * Advisory rank among the requisition's other candidates: a frozen summary's
 * composite when one exists, otherwise the composite of the candidate's most
 * recent interview with submitted scorecards (same test weight as this one).
 */
async function rankFor(client, tenantId, interview, composite, testWeightPct) {
    const requisitionId = interview.application?.jobRequisitionId ?? null;
    if (!requisitionId) return { rank: null, of: null };
    const [frozen, others] = await Promise.all([
        client.candidateEvaluationSummary.findMany({
            where: withTenant(tenantId, { requisitionId, applicationId: { not: interview.applicationId } }),
            select: { applicationId: true, compositeScore: true, frozenAt: true },
            orderBy: { frozenAt: "desc" },
            take: RANK_SCAN_CAP,
        }),
        client.interview.findMany({
            where: withTenant(tenantId, {
                applicationId: { not: interview.applicationId },
                application: { jobRequisitionId: requisitionId },
                scorecards: { some: { submittedAt: { not: null } } },
            }),
            select: {
                id: true,
                applicationId: true,
                assessmentRequired: true,
                assessmentStatus: true,
                scorecards: { where: { submittedAt: { not: null } }, select: { weightedScore: true, overallScore: true } },
            },
            orderBy: { scheduledAt: "desc" },
            take: RANK_SCAN_CAP,
        }),
    ]);
    const results = others.length
        ? await client.candidateTestResult.findMany({
            where: withTenant(tenantId, { interviewId: { in: others.map((o) => o.id) } }),
            select: { interviewId: true, scorePct: true, decision: true },
            orderBy: { createdAt: "desc" },
        })
        : [];
    const byApplication = new Map();
    for (const row of frozen) {
        if (!byApplication.has(row.applicationId) && typeof row.compositeScore === "number") byApplication.set(row.applicationId, row.compositeScore);
    }
    for (const other of others) {
        if (byApplication.has(other.applicationId)) continue;
        const result = results.find((r) => r.interviewId === other.id);
        const included = other.assessmentRequired === true && other.assessmentStatus !== "WAIVED" && result && result.decision !== "WAIVE";
        const { compositeScore: score } = compositeScore({
            testScorePct: typeof result?.scorePct === "number" ? result.scorePct : null,
            interviewScorePct: interviewScoreOf(other.scorecards),
            testWeightPct,
            testIncluded: Boolean(included),
        });
        if (typeof score === "number") byApplication.set(other.applicationId, score);
    }
    return rankAmong(composite, [...byApplication.values()]);
}

/**
 * Build the live report for one interview, on the given client (a transaction
 * when freezing). Must run under the tenant's context.
 *
 * @returns {Promise<object|null>} null when the interview is not found
 */
export async function buildEvaluationReport(client, { tenantId, interviewId } = {}) {
    const id = positiveInt(interviewId);
    if (!id || !tenantId) return null;
    const interview = await client.interview.findFirst({ where: withTenant(tenantId, { id }), select: REPORT_INTERVIEW_SELECT });
    if (!interview) return null;

    const { template, form } = await formForInterview(client, tenantId, interview);
    const submitted = submittedOf(interview);
    const cards = submitted.map((c) => ({ ...c, reviewer: personName(c.reviewer) }));
    const consolidated = consolidateForm(form, cards);
    const test = await testSummaryFor(client, tenantId, interview);
    const composite = compositeScore({
        testScorePct: test?.scorePct ?? null,
        interviewScorePct: consolidated.interviewScorePct,
        testWeightPct: test?.testWeightPct ?? DEFAULT_TEST_WEIGHT_PCT,
        testIncluded: test?.included === true,
    });
    const rank = await rankFor(client, tenantId, interview, composite.compositeScore, test?.testWeightPct ?? DEFAULT_TEST_WEIGHT_PCT);

    const done = new Set(submitted.map((c) => Number(c.reviewerId)));
    const active = (interview.interviewers ?? []).filter((i) => String(i.status ?? "").toLowerCase() !== "declined");
    const candidate = interview.application?.candidate;

    return {
        advisory: true,
        interviewId: interview.id,
        applicationId: interview.applicationId,
        requisitionId: interview.application?.jobRequisitionId ?? null,
        candidate: candidate ? { id: candidate.id, name: [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim() || null } : null,
        requisition: interview.application?.jobRequisition
            ? { id: interview.application.jobRequisition.id, title: interview.application.jobRequisition.title ?? null }
            : null,
        interview: {
            interviewType: interview.interviewType,
            scheduledAt: interview.scheduledAt,
            durationMinutes: interview.durationMinutes ?? null,
            status: interview.status,
            decision: interview.decision ?? null,
        },
        form: template ? { templateId: template.id, version: template.version ?? 1, name: template.name } : null,
        sections: form.sections.map((s) => ({ key: s.key, label: s.label, panelRoles: s.panelRoles ?? [], criteria: s.criteria.map((c) => ({ key: c.key, label: c.label, weight: c.weight, mustHave: c.mustHave === true })) })),
        test,
        interviewScorePct: consolidated.interviewScorePct,
        compositeScore: composite.compositeScore,
        weights: composite.weights,
        panel: {
            size: active.length,
            submittedCount: submitted.length,
            outstanding: active.filter((i) => !done.has(Number(i.employeeId))).map((i) => ({ interviewerId: i.employeeId, name: personName(i.employee), panelRole: i.panelRole ?? null })),
        },
        recommendationTally: consolidated.recommendationTally,
        decisionTally: consolidated.decisionTally,
        criteria: consolidated.criteria,
        divergentCriteria: consolidated.divergentCriteria,
        mustHaveFailed: consolidated.mustHaveFailed,
        mustHaveAlerts: consolidated.mustHaveAlerts,
        suggestion: consolidated.suggestion,
        rank,
        reviewers: submitted.map((c) => shapeCard(c, { form, interview, showFlag: true })),
    };
}

/** Drop what only HR may see (the prohibited-topic flag and terms) from a report. */
export function reportForViewer(report, { hr = false } = {}) {
    if (hr || !report) return report;
    return { ...report, reviewers: (report.reviewers ?? []).map(({ notesFlagged: _flag, notesFlagTerms: _terms, ...rest }) => rest) };
}

// ── The frozen snapshot ──────────────────────────────────────────────────────

/** hr.recruitment.evaluation_summary_frozen.v1 — ids only. */
export function evaluationSummaryFrozenEvent({ tenantId, summaryId, interviewId, applicationId, requisitionId }, ctx = {}) {
    if (!tenantId) return null;
    return {
        eventName: EVALUATION_SUMMARY_FROZEN_EVENT,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            summaryId: summaryId != null ? String(summaryId) : null,
            interviewId: String(interviewId),
            applicationId: applicationId != null ? String(applicationId) : null,
            requisitionId: requisitionId != null ? String(requisitionId) : null,
        },
    };
}

const toJson = (value) => JSON.parse(JSON.stringify(value));

/**
 * Freeze the report for an interview inside the outcome's transaction. Written
 * once: a second outcome finds the summary and leaves it as it is.
 *
 * @returns {Promise<{ frozen: boolean, summaryId?: number, reason?: string }>}
 */
export async function freezeEvaluationSummary(tx, { tenantId, interviewId, actorId = null, decision = null } = {}) {
    if (!isRecruitmentFlagEnabled("evaluationForms") || !tenantId) return { frozen: false, reason: "FLAG_OFF" };
    const id = positiveInt(interviewId);
    const existing = await tx.candidateEvaluationSummary.findFirst({ where: withTenant(tenantId, { interviewId: id }), select: { id: true } });
    if (existing) return { frozen: false, summaryId: existing.id, reason: "ALREADY_FROZEN" };
    const report = await buildEvaluationReport(tx, { tenantId, interviewId: id });
    if (!report?.requisitionId) return { frozen: false, reason: "NOT_FOUND" };

    const frozenAt = new Date();
    const actor = positiveInt(actorId);
    // skipDuplicates: a concurrent outcome freezes once (unique interviewId),
    // without aborting this transaction.
    await tx.candidateEvaluationSummary.createMany({
        data: [{
            tenantId,
            applicationId: report.applicationId,
            interviewId: id,
            requisitionId: report.requisitionId,
            snapshot: toJson({ ...report, outcome: decision, frozenAt }),
            testScorePct: report.test?.included ? report.test.scorePct : null,
            interviewScorePct: report.interviewScorePct,
            compositeScore: report.compositeScore,
            weights: report.weights,
            rankAtSnapshot: report.rank?.rank ?? null,
            frozenAt,
            frozenById: actor,
        }],
        skipDuplicates: true,
    });
    const row = await tx.candidateEvaluationSummary.findFirst({ where: withTenant(tenantId, { interviewId: id }), select: { id: true, frozenAt: true } });
    if (!row) return { frozen: false, reason: "NOT_WRITTEN" };
    await enqueueHrDomainEvent(
        tx,
        evaluationSummaryFrozenEvent(
            { tenantId, summaryId: row.id, interviewId: id, applicationId: report.applicationId, requisitionId: report.requisitionId },
            eventContext({ actorId: actor }),
        ),
    );
    return { frozen: true, summaryId: row.id };
}

// ── Reads and the export ─────────────────────────────────────────────────────

/** Who the caller is to this interview: recruiter, its manager, a panelist. */
async function viewerOf(user, interviewId) {
    const access = resolveAssessmentAccess(user);
    const id = positiveInt(interviewId);
    const interview = id
        ? await prisma.interview.findFirst({
            where: withTenant(user.tenantId, { id, ...interviewScopeWhere(access.scope) }),
            select: {
                id: true,
                interviewers: { select: { employeeId: true, panelRole: true } },
                application: { select: { jobRequisition: { select: { requestedById: true } } } },
            },
        })
        : null;
    if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-INTERVIEW-NOT-FOUND");
    const me = access.employeeId;
    const manager = Boolean(me) && Number(interview.application?.jobRequisition?.requestedById) === me;
    const panelist = Boolean(me) && (interview.interviewers ?? []).some((i) => Number(i.employeeId) === me);
    return { access, interview, manager, panelist, full: access.recruiter || manager };
}

/**
 * hr_interview_evaluation_summary_get: the frozen snapshot once it exists,
 * otherwise the live report; a panelist who is neither a recruiter nor the
 * requisition's manager gets only their own form.
 */
export async function getEvaluationSummary(user, { interviewId } = {}) {
    assertEvaluationFormsEnabled();
    const viewer = await viewerOf(user, interviewId);
    const tenantId = user.tenantId;
    if (!viewer.full) {
        if (!viewer.panelist) throw fail("Interview not found", 404, "HR-RECRUITMENT-INTERVIEW-NOT-FOUND");
        const interview = await prisma.interview.findFirst({ where: withTenant(tenantId, { id: viewer.interview.id }), select: REPORT_INTERVIEW_SELECT });
        const { form } = await formForInterview(prisma, tenantId, interview);
        const own = (interview.scorecards ?? []).find((c) => Number(c.reviewerId) === viewer.access.employeeId);
        return { interviewId: interview.id, ownFormOnly: true, scorecard: own ? shapeCard(own, { form, interview }) : null };
    }
    const frozen = await prisma.candidateEvaluationSummary.findFirst({
        where: withTenant(tenantId, { interviewId: viewer.interview.id }),
        select: { id: true, snapshot: true, frozenAt: true, frozenById: true, pdfMediaId: true },
    });
    if (frozen) {
        return {
            ...reportForViewer(frozen.snapshot, { hr: viewer.access.recruiter }),
            frozen: true,
            summaryId: frozen.id,
            frozenAt: frozen.frozenAt,
            frozenById: frozen.frozenById ?? null,
            pdfMediaId: frozen.pdfMediaId ?? null,
        };
    }
    const report = await buildEvaluationReport(prisma, { tenantId, interviewId: viewer.interview.id });
    return { ...reportForViewer(report, { hr: viewer.access.recruiter }), frozen: false };
}

/**
 * hr_interview_evaluation_export: render the frozen report and the panel's
 * forms to PDF, store it in DAM and record pdfMediaId on the summary. Reuses
 * the stored file unless force is set. The report must be frozen (the
 * outcome is recorded) so the PDF matches the record exactly.
 */
export async function exportEvaluationReport(user, { interviewId, force = false } = {}) {
    assertEvaluationFormsEnabled();
    const viewer = await viewerOf(user, interviewId);
    if (!viewer.full) throw fail("Only a recruiter or the requisition's hiring manager may export the report", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    const tenantId = user.tenantId;
    const summary = await prisma.candidateEvaluationSummary.findFirst({
        where: withTenant(tenantId, { interviewId: viewer.interview.id }),
        select: { id: true, snapshot: true, frozenAt: true, pdfMediaId: true },
    });
    if (!summary) {
        throw fail("The evaluation report is frozen when the outcome is recorded; export it after that", 409, "HR-RECRUITMENT-EVALUATION-NOT-FROZEN");
    }
    if (summary.pdfMediaId && force !== true) {
        return { interviewId: viewer.interview.id, summaryId: summary.id, mediaId: summary.pdfMediaId, reused: true };
    }
    const buffer = await generateEvaluationReportPdf({ report: summary.snapshot, frozenAt: summary.frozenAt });
    const mediaId = await uploadEvaluationReportPdf(buffer, `evaluation-report-interview-${viewer.interview.id}.pdf`);
    await prisma.candidateEvaluationSummary.updateMany({
        where: withTenant(tenantId, { id: summary.id }),
        data: { pdfMediaId: mediaId },
    });
    logger.info({ tenantId, interviewId: viewer.interview.id, summaryId: summary.id, mediaId }, "evaluation report exported");
    return { interviewId: viewer.interview.id, summaryId: summary.id, mediaId, reused: false };
}
