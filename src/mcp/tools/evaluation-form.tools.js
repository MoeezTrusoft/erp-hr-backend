// src/mcp/tools/evaluation-form.tools.js
//
// Recruitment Phase 3b — the interviewer's evaluation form, the interview
// question bank, the candidate evaluation report and rater calibration (plan
// 7.4 and 7.6, flag evaluationForms; every tool answers 503 with it off).
//
// Who may do what. Every tool checks hr:recruitment with its HTTP method
// first, then a capability from resolveAssessmentAccess; row scope is the
// interview scope (out-of-scope rows are not found):
//   * form get / draft save: a panelist on the interview (their role's
//     sections); recruiters and the requisition's manager read every section.
//   * question bank writes and the AI form draft: HR and recruiters; the bank
//     list also for hiring managers.
//   * evaluation summary: recruiters and the requisition's manager read the
//     report; a panelist reads only their own form.
//   * export: recruiters and the requisition's manager.
//   * rater calibration: HR and recruiters.
// The form SUBMIT is hr_interview_score (interviewMgmtTools.js).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { FORM_RECOMMENDATIONS, INTERVIEW_DECISIONS, PANEL_ROLES } from "../../lib/evaluation-form.util.js";
import { draftFormWithAi, getInterviewForm, saveScorecardDraft } from "../../services/evaluation-form.service.js";
import { assertEvaluationFormsEnabled, exportEvaluationReport, getEvaluationSummary } from "../../services/evaluation-summary.service.js";
import { getRaterCalibration } from "../../services/rater-calibration.service.js";
import {
  QUESTION_LEVELS,
  createQuestion,
  listQuestions,
  retireQuestion,
  updateQuestion,
} from "../../services/interview-question.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const forbidden = (message) => Object.assign(new Error(message), { status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });

// Permission first, the flag, then the caller's capabilities.
function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  assertEvaluationFormsEnabled();
  return { user, access: resolveAssessmentAccess(user) };
}

const requireHr = (access) => {
  if (!access.recruiter && !access.admin) throw forbidden("The question bank and form drafting are for HR and recruiters");
};

const interviewIdInput = z.coerce.number().int().positive().describe("Interview id");
const criterionScoresInput = z.array(z.object({
  key: z.string().min(1).describe("Criterion key"),
  rating: z.union([z.number(), z.boolean(), z.enum(["YES", "NO"])]).nullable().optional().describe("Rating on the criterion's scale"),
  notAssessed: z.boolean().optional().describe("Not assessed (non-required criteria only)"),
  note: z.string().max(5000).optional().describe("Evidence note"),
})).max(100);

export function registerEvaluationFormTools(server) {
  server.tool(
    "hr_interview_form_get",
    "The evaluation form for one interview: the pinned form version (sections for the caller's panel role; recruiters and the requisition's manager see all), anchors, linked bank questions, test-informed probes (competencies scored below the section pass mark, with suggested questions), the test report (scores and bands only), the training requirement and the caller's own draft or submitted scorecard with its live score. Peers' ratings appear only after the caller's own submission.",
    { interviewId: interviewIdInput },
    withToolError(async ({ interviewId }) => {
      const { user } = authorized("GET");
      return text(await getInterviewForm(user, { interviewId }));
    }, "hr_interview_form_get"),
  );

  server.tool(
    "hr_interview_scorecard_draft_save",
    "Autosave the caller's evaluation form draft: criterion ratings and notes (merged per criterion), overall notes, recommendation, decision and the conflict-of-interest declaration. Returns the live weighted score, must-have status and what is still missing. Never locks; a submitted scorecard is changed only by resubmitting (hr_interview_score) with an amendment reason.",
    {
      interviewId: interviewIdInput,
      criterionScores: criterionScoresInput.optional(),
      notes: z.string().max(20000).optional().describe("Overall notes"),
      recommendation: z.enum(FORM_RECOMMENDATIONS).nullable().optional(),
      decision: z.enum(INTERVIEW_DECISIONS).nullable().optional().describe("The panelist's suggested decision"),
      coiDeclared: z.boolean().optional().describe("Conflict-of-interest declaration"),
    },
    withToolError(async (args) => {
      const { user } = authorized("POST");
      return text(await saveScorecardDraft(user, args));
    }, "hr_interview_scorecard_draft_save"),
  );

  server.tool(
    "hr_interview_questions_list",
    "List the interview question bank (latest version of each question unless latestOnly is false), filtered by competency, status, level or text.",
    {
      competencyKey: z.string().optional(),
      status: z.enum(["DRAFT", "PUBLISHED", "RETIRED"]).optional(),
      level: z.enum(QUESTION_LEVELS).optional(),
      q: z.string().max(200).optional().describe("Search in the prompt"),
      latestOnly: z.boolean().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("GET");
      if (!access.recruiter && !access.admin && !access.manager) throw forbidden("The question bank is for HR, recruiters and hiring managers");
      return text(await listQuestions({ ...args, tenantId: user.tenantId }));
    }, "hr_interview_questions_list"),
  );

  server.tool(
    "hr_interview_question_create",
    "Add an interview question to the bank: competency, prompt, follow-ups, a what-good-looks-like guide and level. DRAFT unless publish is true.",
    {
      competencyKey: z.string().min(1).max(100),
      prompt: z.string().min(1).max(4000),
      followUps: z.array(z.string().max(1000)).max(10).optional(),
      goodAnswerGuide: z.string().max(4000).optional(),
      level: z.enum(QUESTION_LEVELS).optional(),
      questionKey: z.string().min(1).max(80).optional().describe("Version family key (generated when omitted)"),
      publish: z.boolean().optional(),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("POST");
      requireHr(access);
      return text(await createQuestion({ ...args, tenantId: user.tenantId, actorId: access.employeeId }));
    }, "hr_interview_question_create"),
  );

  server.tool(
    "hr_interview_question_update",
    "Update a bank question. A DRAFT changes in place (status PUBLISHED publishes it); a PUBLISHED version is immutable, so a change creates the next version.",
    {
      questionId: z.coerce.number().int().positive(),
      competencyKey: z.string().min(1).max(100).optional(),
      prompt: z.string().min(1).max(4000).optional(),
      followUps: z.array(z.string().max(1000)).max(10).optional(),
      goodAnswerGuide: z.string().max(4000).optional(),
      level: z.enum(QUESTION_LEVELS).nullable().optional(),
      status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("PUT");
      requireHr(access);
      return text(await updateQuestion({ ...args, tenantId: user.tenantId, actorId: access.employeeId }));
    }, "hr_interview_question_update"),
  );

  server.tool(
    "hr_interview_question_retire",
    "Retire a bank question (every version of its key); forms stop showing it.",
    { questionId: z.coerce.number().int().positive() },
    withToolError(async ({ questionId }) => {
      const { user, access } = authorized("PUT");
      requireHr(access);
      return text(await retireQuestion({ questionId, tenantId: user.tenantId }));
    }, "hr_interview_question_retire"),
  );

  server.tool(
    "hr_interview_form_draft_ai",
    "Ask the AI plane (hr.interview.form.draft.v1) to draft an evaluation form for a requisition: sections, criteria from its skills, anchors for every level and suggested questions. Stored as a DRAFT template (questions as DRAFT bank entries) for HR to review and publish. AI never rates a candidate. Needs the ai flag too.",
    {
      requisitionId: z.coerce.number().int().positive(),
      name: z.string().min(1).max(200).optional(),
      interviewType: z.enum(["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"]).optional(),
      panelRole: z.enum(PANEL_ROLES).optional(),
      scale: z.enum(["1-5", "1-4"]).optional(),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("POST");
      requireHr(access);
      return text(await draftFormWithAi(user, args));
    }, "hr_interview_form_draft_ai"),
  );

  server.tool(
    "hr_interview_evaluation_summary_get",
    "The candidate evaluation report for one interview: test score (excluded when waived or not required), interview score, composite (blueprint weights, default 30/70), panel recommendation tally, divergent criteria, must-have alerts and the advisory rank among the requisition's candidates. Once the outcome is recorded this is the frozen snapshot. Recruiters and the requisition's manager; a panelist gets only their own form.",
    { interviewId: interviewIdInput },
    withToolError(async ({ interviewId }) => {
      const { user } = authorized("GET");
      return text(await getEvaluationSummary(user, { interviewId }));
    }, "hr_interview_evaluation_summary_get"),
  );

  server.tool(
    "hr_interview_evaluation_export",
    "Render the frozen evaluation report and the panel's forms to PDF, store it in DAM and record the media id on the report (reused unless force is true). Available once the outcome is recorded. Recruiters and the requisition's manager.",
    {
      interviewId: interviewIdInput,
      force: z.boolean().optional().describe("Render again even when a PDF is stored"),
    },
    withToolError(async ({ interviewId, force }) => {
      const { user } = authorized("POST");
      return text(await exportEvaluationReport(user, { interviewId, force: force === true }));
    }, "hr_interview_evaluation_export"),
  );

  server.tool(
    "hr_rater_calibration_get",
    "Rater calibration per interviewer over a window (default the last 180 days): leniency or severity (mean rating against the other panelists), range, agreement (share of shared criteria within 1 point of the others' median), timeliness (hours from interview end to submission) and sample size; metrics are withheld below a minimum sample of 5. Coaching indicators, never employee scores. HR and recruiters.",
    {
      from: z.string().optional().describe("Window start (ISO 8601)"),
      to: z.string().optional().describe("Window end (ISO 8601)"),
      requisitionId: z.coerce.number().int().positive().optional(),
      interviewerId: z.coerce.number().int().positive().optional(),
      minSample: z.coerce.number().int().min(5).max(100).optional(),
    },
    withToolError(async (args) => {
      const { user } = authorized("GET");
      return text(await getRaterCalibration(user, args));
    }, "hr_rater_calibration_get"),
  );
}
