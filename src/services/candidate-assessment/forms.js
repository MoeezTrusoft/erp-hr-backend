import { earlierRoundContext } from "./interview-context.js";
import { addRoleSkills } from "./role-skills.js";
import { testReport } from "./test-report.js";
import * as evaluationCatalog from "./evaluation-catalog.js";
import {
  EvaluationForm,
  FormSubmission,
} from "@trusoft/contracts/recruitment-assessment";
import { run, interview, event, fail, json } from "./base.js";
import { evaluateForm, assertAssessmentComplete, composite } from "./rules.js";
import { isRecruitmentFlagEnabled } from "../../lib/recruitmentFlags.js";
import { resolveBlueprint } from "./catalog.js";
const permission = "hr.recruitment.read";
export async function pinInterviewAssessment(
  tx,
  tenantId,
  applicationId,
  interviewType,
  panels,
) {
  const application = await tx.application.findFirst({
    where: { tenantId, id: Number(applicationId) },
    include: { jobRequisition: true },
  });
  if (!application) fail("Application not found", 404);
  let data = {},
    blueprint = null;
  if (isRecruitmentFlagEnabled("onsiteTest")) {
    blueprint = await resolveBlueprint(
      tx,
      tenantId,
      application.jobRequisition,
    );
    if (blueprint)
      data = { assessmentRequired: true, assessmentStatus: "REQUIRED" };
  }
  if (!isRecruitmentFlagEnabled("evaluationForms")) return data;
  const links = await tx.scorecardTemplateLink.findMany({
      where: { tenantId, isActive: true },
      include: { template: true },
    }),
    req = application.jobRequisition;
  const ranked = links
    .filter(
      (l) =>
        l.template.status === "PUBLISHED" &&
        l.template.sections &&
        l.template.isActive,
    )
    .map((l) => ({
      l,
      rank:
        l.scopeType === "REQUISITION" && l.scopeId === req.id
          ? 0
          : l.scopeType === "INTERVIEW_TYPE" && l.scopeKey === interviewType
            ? 1
            : l.scopeType === "PANEL_ROLE" &&
                panels.some((p) => p.panelRole === l.scopeKey)
              ? 2
              : l.scopeType === "STAGE" && l.scopeKey === interviewType
                ? 3
                : l.scopeType === "JOB_FAMILY" && l.scopeId === req.positionId
                  ? 4
                  : 99,
    }))
    .filter((x) => x.rank < 99)
    .sort(
      (a, b) => a.rank - b.rank || b.l.template.version - a.l.template.version,
    );
  const t = ranked[0]?.l.template;
  if (!t) return data;
  const baseDefinition = EvaluationForm.parse({
    sections: t.sections,
    requiresTraining: t.requiresTraining,
    interviewType: t.interviewType,
    panelRole: t.panelRole,
  });
  const definition = await addRoleSkills(
    tx,
    tenantId,
    baseDefinition,
    req,
    panels,
    blueprint,
  );
  if (t.requiresTraining) {
    const trained = await tx.employee.count({
      where: {
        tenant_id: tenantId,
        id: { in: panels.map((p) => p.employeeId) },
        interviewerTrainedAt: { not: null },
      },
    });
    if (trained !== new Set(panels.map((p) => p.employeeId)).size)
      fail("Every assigned panelist must have recorded interviewer training");
  }
  return {
    ...data,
    formTemplateId: t.id,
    formTemplateVersion: t.version,
    formSnapshot: json(definition),
  };
}
async function panelForm(tx, env, id, { lock = false } = {}) {
  const i = await interview(tx, env, id, { lock });
  const panel = i.interviewers.find((p) => p.employeeId === env.who.id);
  if (!panel) fail("Only an assigned panelist can open this form", 404);
  if (!i.formSnapshot)
    fail("No structured form is pinned to this interview", 409);
  return { i, panel, form: EvaluationForm.parse(i.formSnapshot) };
}
export const formGet = (input) =>
  run(
    permission,
    async (tx, env) => {
      const { i, panel, form } = await panelForm(tx, env, input.interviewId);
      const own = await tx.interviewScorecard.findFirst({
          where: {
            tenantId: env.tenantId,
            interviewId: i.id,
            reviewerId: env.who.id,
          },
        }),
        test = await tx.candidateTestResult.findFirst({
          where: {
            tenantId: env.tenantId,
            ...(i.assessmentResultId
              ? { id: i.assessmentResultId }
              : { interviewId: i.id }),
          },
          orderBy: { id: "desc" },
        });
      const peers = own?.submittedAt
        ? await tx.interviewScorecard.findMany({
            where: {
              tenantId: env.tenantId,
              interviewId: i.id,
              submittedAt: { not: null },
            },
          })
        : [];
      const sections = form.sections.filter(
        (s) => !s.panelRoles.length || s.panelRoles.includes(panel.panelRole),
      );
      const questions = await tx.interviewQuestion.findMany({
        where: {
          tenantId: env.tenantId,
          id: {
            in: sections.flatMap((s) =>
              s.criteria.flatMap((c) => c.questionIds),
            ),
          },
        },
      });
      return {
        interviewId: i.id,
        candidate: {
          id: i.application.candidate.id,
          firstName: i.application.candidate.firstName,
          lastName: i.application.candidate.lastName,
          resumeMediaId: i.application.candidate.resumeMediaId,
        },
        requisition: {
          id: i.application.jobRequisitionId,
          title: i.application.jobRequisition.title,
        },
        scheduledAt: i.scheduledAt,
        durationMinutes: i.durationMinutes,
        interviewType: i.interviewType,
        earlierRounds: await earlierRoundContext(tx, env.tenantId, i),
        panelRole: panel.panelRole,
        templateVersion: i.formTemplateVersion,
        sections,
        generation: form.generation ?? null,
        questions,
        own,
        peers,
        peersHidden: !own?.submittedAt,
        testReport: await testReport(tx, env.tenantId, test, i),
        assessmentStatus: i.assessmentStatus,
      };
    },
    "evaluationForms",
  );
export const formSave = (raw, { submit = false } = {}) =>
  run(
    "hr.recruitment.update",
    async (tx, env) => {
      const input = FormSubmission.parse(raw),
        { i, panel, form } = await panelForm(tx, env, input.interviewId, {
          lock: true,
        });
      if (submit) assertAssessmentComplete(i);
      if (["CANCELLED", "NO_SHOW"].includes(i.status))
        fail("This interview cannot receive feedback");
      const old = await tx.interviewScorecard.findFirst({
        where: {
          tenantId: env.tenantId,
          interviewId: i.id,
          reviewerId: env.who.id,
        },
      });
      if ((old?.version ?? 0) !== input.expectedVersion)
        fail("The form changed; reload before saving", 412);
      if (old?.submittedAt && (!submit || !input.amendmentReason))
        fail("A submitted scorecard requires an amendment reason", 409);
      const scored = evaluateForm(form, panel.panelRole, input, { submit });
      const data = {
        criterionScores: input.criterionScores,
        weightedScore: scored.weightedScore,
        mustHaveFailed: scored.mustHaveFailed,
        reviewFlags: scored.reviewFlags,
        coiDeclared: input.coiDeclared,
        notes: input.notes,
        recommendation: input.recommendation ?? null,
        templateVersion: i.formTemplateVersion,
        status: submit ? "SUBMITTED" : "DRAFT",
        startedAt: old?.startedAt ?? env.now,
        draftSavedAt: env.now,
        scores: Object.fromEntries(
          input.criterionScores
            .filter((a) => a.rating !== null)
            .map((a) => [a.key, a.rating]),
        ),
        overallScore: scored.weightedScore,
        submittedAt: old?.submittedAt ?? (submit ? env.now : null),
        ...(old?.submittedAt
          ? {
              lastAmendedAt: env.now,
              amendmentLog: [
                ...(old.amendmentLog ?? []),
                {
                  at: env.now.toISOString(),
                  by: env.who.id,
                  reason: input.amendmentReason,
                  replaced: {
                    criterionScores: old.criterionScores,
                    recommendation: old.recommendation,
                    notes: old.notes,
                    weightedScore: old.weightedScore,
                  },
                },
              ],
            }
          : {}),
      };
      const row = old
        ? await tx.interviewScorecard.update({
            where: { id: old.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.interviewScorecard.create({
            data: {
              ...data,
              tenantId: env.tenantId,
              interviewId: i.id,
              reviewerId: env.who.id,
              version: 1,
            },
          });
      if (submit)
        await event(tx, env, "interview_scorecard_submitted", {
          applicationId: i.applicationId,
          interviewId: i.id,
          scorecardId: row.id,
        });
      return {
        scorecard: row,
        completeness: { completed: scored.completed, total: scored.total },
      };
    },
    "evaluationForms",
  );
export async function summarize(tx, tenantId, i) {
  const cards = await tx.interviewScorecard.findMany({
      where: { tenantId, interviewId: i.id, submittedAt: { not: null } },
    }),
    result = await tx.candidateTestResult.findFirst({
      where: {
        tenantId,
        ...(i.assessmentResultId
          ? { id: i.assessmentResultId }
          : { interviewId: i.id }),
      },
      orderBy: { id: "desc" },
    }),
    session = result
      ? await tx.candidateTestSession.findFirst({
          where: { tenantId, id: result.sessionId },
        })
      : null;
  const values = cards.map((c) => c.weightedScore).filter((v) => v !== null),
    interviewScorePct = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
    testScorePct =
      i.assessmentStatus === "WAIVED" || i.assessmentStatus === "NOT_REQUIRED"
        ? null
        : (result?.scorePct ?? null),
    testWeightPct = session?.blueprintSnapshot.testWeightPct ?? 30,
    criteria = {};
  for (const card of cards)
    for (const a of card.criterionScores ?? []) {
      if (a.rating === null) continue;
      (criteria[a.key] ??= []).push({
        reviewerId: card.reviewerId,
        rating: a.rating,
        evidence: a.evidence,
      });
    }
  const divergence = Object.entries(criteria)
    .filter(
      ([, a]) =>
        Math.max(...a.map((v) => v.rating)) -
          Math.min(...a.map((v) => v.rating)) >=
        2,
    )
    .map(([key]) => key);
  return {
    testScorePct,
    interviewScorePct,
    compositeScore: composite(testScorePct, interviewScorePct, testWeightPct),
    weights: {
      test: testScorePct === null ? 0 : testWeightPct,
      interview: testScorePct === null ? 100 : 100 - testWeightPct,
    },
    snapshot: json({
      cards,
      criteria,
      divergence,
      mustHaveFailed: cards.some((c) => c.mustHaveFailed),
      recommendationTally: cards.reduce((a, c) => {
        a[c.recommendation] = (a[c.recommendation] ?? 0) + 1;
        return a;
      }, {}),
      test: await testReport(tx, tenantId, result, i),
      assessmentStatus: i.assessmentStatus,
      formTemplateId: i.formTemplateId,
      formTemplateVersion: i.formTemplateVersion,
      advisory: true,
    }),
  };
}
export async function freezeSummary(tx, env, i) {
  if (!i.formSnapshot) return null;
  const existing = await tx.candidateEvaluationSummary.findUnique({
    where: { interviewId: i.id },
  });
  if (existing) return existing;
  const summary = await summarize(tx, env.tenantId, i);
  const others = await tx.candidateEvaluationSummary.findMany({
    where: {
      tenantId: env.tenantId,
      compositeScore: { gt: summary.compositeScore ?? 100 },
    },
  });
  const applications = await tx.application.findMany({
    where: {
      tenantId: env.tenantId,
      jobRequisitionId: i.application.jobRequisitionId,
      id: { in: others.map((s) => s.applicationId) },
    },
    select: { id: true },
  });
  const row = await tx.candidateEvaluationSummary.create({
    data: {
      tenantId: env.tenantId,
      applicationId: i.applicationId,
      interviewId: i.id,
      ...summary,
      rankAtSnapshot:
        summary.compositeScore === null
          ? null
          : new Set(applications.map((a) => a.id)).size + 1,
    },
  });
  await event(tx, env, "evaluation_summary_frozen", {
    applicationId: i.applicationId,
    interviewId: i.id,
    summaryId: row.id,
  });
  return row;
}
export const summaryGet = (input) =>
  run(
    permission,
    async (tx, env) => {
      const i = await interview(tx, env, input.interviewId);
      const panel = i.interviewers.some((p) => p.employeeId === env.who.id);
      if (
        panel &&
        !(await tx.interviewScorecard.findFirst({
          where: {
            tenantId: env.tenantId,
            interviewId: i.id,
            reviewerId: env.who.id,
            submittedAt: { not: null },
          },
        }))
      )
        fail("Submit your own form before reading panel ratings", 403);
      if (!panel && !["ORG", "MANAGED"].includes(env.scope.level))
        fail("Evaluation unavailable", 404);
      const frozen = await tx.candidateEvaluationSummary.findUnique({
        where: { interviewId: i.id },
      });
      return frozen
        ? { ...frozen, frozen: true }
        : { ...(await summarize(tx, env.tenantId, i)), frozen: false };
    },
    "evaluationForms",
  );
export const questionsList = (input) =>
  evaluationCatalog.catalogList("question", input);
export const questionSave = evaluationCatalog.questionSave;
export const questionRetire = (input) =>
  evaluationCatalog.retire("question", input);
export const raterCalibration = () =>
  run(
    "hr.recruitment.assessment.admin",
    async (tx, env) => {
      if (
        !env.ctx.user.roles?.some((r) =>
          ["HR_ADMIN", "HR_HEAD", "HR_MANAGER"].includes(
            String(r).toUpperCase(),
          ),
        )
      )
        fail("HR calibration access required", 403);
      const cards = await tx.interviewScorecard.findMany({
        where: {
          tenantId: env.tenantId,
          submittedAt: { not: null },
          weightedScore: { not: null },
        },
        include: {
          reviewer: { select: { first_name: true, last_name: true } },
          interview: { select: { scheduledAt: true, durationMinutes: true } },
        },
        orderBy: { id: "desc" },
        take: 10001,
      });
      const truncated = cards.length > 10000,
        sample = cards.slice(0, 10000),
        groups = new Map(),
        rounds = new Map();
      for (const card of sample) {
        if (!groups.has(card.reviewerId)) groups.set(card.reviewerId, []);
        groups.get(card.reviewerId).push(card);
        if (!rounds.has(card.interviewId)) rounds.set(card.interviewId, []);
        rounds.get(card.interviewId).push(card);
      }
      const mean = (values) =>
        values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
      return {
        truncated,
        advisory: true,
        minimumRecommendedSample: 5,
        items: [...groups].map(([reviewerId, rows]) => {
          const comparisons = rows.flatMap((card) => {
            const peers = rounds
              .get(card.interviewId)
              .filter((p) => p.reviewerId !== reviewerId);
            return peers.length
              ? [card.weightedScore - mean(peers.map((p) => p.weightedScore))]
              : [];
          });
          const timings = rows
            .filter((c) => c.startedAt && c.submittedAt >= c.startedAt)
            .map((c) => (c.submittedAt - c.startedAt) / 60000);
          const delays = rows.map((c) =>
            Math.max(
              0,
              (c.submittedAt -
                c.interview.scheduledAt -
                (c.interview.durationMinutes ?? 60) * 60000) /
                3600000,
            ),
          );
          return {
            reviewerId,
            name: [rows[0].reviewer.first_name, rows[0].reviewer.last_name]
              .filter(Boolean)
              .join(" "),
            count: rows.length,
            mean: mean(rows.map((c) => c.weightedScore)),
            min: Math.min(...rows.map((c) => c.weightedScore)),
            max: Math.max(...rows.map((c) => c.weightedScore)),
            meanCompletionMinutes: mean(timings),
            meanHoursAfterInterview: mean(delays),
            peerComparisonCount: comparisons.length,
            meanDifferenceFromPanel: mean(comparisons),
            meanAbsolutePanelDifference: mean(comparisons.map(Math.abs)),
            lowSample: rows.length < 5,
          };
        }),
      };
    },
    "evaluationForms",
  );

export const formPublish = (input) => evaluationCatalog.publish("form", input);
export const questionPublish = (input) =>
  evaluationCatalog.publish("question", input);
