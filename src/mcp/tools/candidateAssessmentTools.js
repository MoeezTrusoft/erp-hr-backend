import * as images from "../../services/candidate-assessment/images.js";
import {
  trainingList,
  trainingSet,
} from "../../services/candidate-assessment/interviewer-training.js";
import * as evaluationCatalog from "../../services/candidate-assessment/evaluation-catalog.js";
import { evaluationExport } from "../../services/candidate-assessment/report.js";
import { z } from "zod";
import {
  TestItem,
  TestBlueprint,
  FormSubmission,
} from "@trusoft/contracts/recruitment-assessment";
import * as catalog from "../../services/candidate-assessment/catalog.js";
import * as sessions from "../../services/candidate-assessment/sessions.js";
import * as results from "../../services/candidate-assessment/results.js";
import * as forms from "../../services/candidate-assessment/forms.js";
import { withToolError } from "../utils/toolError.js";
const id = z.number().int().positive(),
  revision = z.number().int().nonnegative(),
  reason = z.string().trim().min(10).max(2000),
  obj = (s) => z.object(s).strict(),
  ref = obj({ id }),
  versioned = { id, expectedVersion: revision },
  list = obj({
    limit: z.number().int().min(1).max(200).default(50),
    cursor: id.optional(),
    status: z.string().max(40).optional(),
    competencyKey: z.string().max(100).optional(),
  }),
  window = obj({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }).refine(
    (v) =>
      Date.parse(v.to) > Date.parse(v.from) &&
      Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
    "Use a positive range up to one year",
  );
const question = evaluationCatalog.InterviewQuestionDefinition;
export const candidateAssessmentTools = [
  [
    "hr_test_images_list",
    "Search verified company assessment images",
    obj({
      q: z.string().max(150).optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    images.imagesList,
  ],
  [
    "hr_test_image_upload",
    "Upload a scanned assessment image to DAM",
    obj({
      fileBase64: z.string().min(1).max(2796204),
      fileName: z.string().trim().min(1).max(200),
    }),
    images.imageUpload,
  ],
  [
    "hr_test_image_register",
    "Verify and add an existing company DAM image",
    obj({ mediaId: z.string().regex(/^[1-9]\d*$/) }),
    images.imageRegister,
  ],
  [
    "hr_test_image_preview",
    "Preview verified image bytes for assessment authoring",
    ref,
    images.imagePreview,
  ],
  [
    "hr_reception_staff_list",
    "Search company reception site assignments",
    obj({
      q: z.string().max(150).optional(),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: id.optional(),
    }),
    sessions.receptionStaffList,
  ],
  [
    "hr_interviewer_training_list",
    "List company interviewer training records",
    obj({
      q: z.string().max(150).optional(),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: id.optional(),
    }),
    trainingList,
  ],
  [
    "hr_interviewer_training_set",
    "Record independently verified interviewer training or revocation",
    obj({
      employeeId: id,
      trainedAt: z.string().datetime().nullable(),
      reason,
    }),
    trainingSet,
  ],
  [
    "hr_interview_forms_list",
    "List versioned structured evaluation forms",
    list,
    (a) => evaluationCatalog.catalogList("form", a),
  ],
  [
    "hr_interview_form_template_get",
    "Read a structured evaluation form definition",
    ref,
    (a) => evaluationCatalog.catalogGet("form", a),
  ],
  [
    "hr_interview_question_get",
    "Read a versioned interview question",
    ref,
    (a) => evaluationCatalog.catalogGet("question", a),
  ],
  [
    "hr_assessment_references_list",
    "Search canonical skills and company grades for assessment authoring without exposing compensation",
    obj({
      kind: z.enum(["SKILL", "GRADE"]),
      q: z.string().max(150).optional(),
      selectedId: id.optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    catalog.referencesList,
  ],
  [
    "hr_reception_workstations_list",
    "List active kiosks at your assigned sites",
    obj({}),
    sessions.receptionWorkstations,
  ],
  [
    "hr_interview_evaluation_export",
    "Render the frozen evaluation report to a DAM PDF",
    obj({ interviewId: id }),
    evaluationExport,
  ],
  [
    "hr_reception_sites_assign",
    "Assign an employee to reception sites",
    obj({
      employeeId: id,
      siteRefs: z.array(z.string().trim().min(1).max(100)).max(50),
      expectedSiteRefs: z.array(z.string().min(1).max(100)).max(50).optional(),
    }),
    sessions.receptionSitesAssign,
  ],
  [
    "hr_test_items_list",
    "List versioned assessment items without answer keys",
    list,
    catalog.itemsList,
  ],
  [
    "hr_test_item_get",
    "Read an item; keys restricted to its author or publisher",
    ref,
    catalog.itemGet,
  ],
  [
    "hr_test_item_create",
    "Create a validated encrypted draft item",
    obj({ item: TestItem }),
    catalog.itemCreate,
  ],
  [
    "hr_test_item_update",
    "Edit a draft or create a new version of published evidence",
    obj({ ...versioned, item: TestItem }),
    catalog.itemUpdate,
  ],
  [
    "hr_test_item_submit_review",
    "Submit an authored draft for independent review",
    obj(versioned),
    catalog.itemSubmit,
  ],
  [
    "hr_test_item_review_decide",
    "Independently publish or return a submitted item",
    obj({ ...versioned, approve: z.boolean(), reason }),
    catalog.itemReview,
  ],
  [
    "hr_test_item_retire",
    "Retire an item version with a reason",
    obj({ ...versioned, reason }),
    catalog.itemRetire,
  ],
  [
    "hr_test_items_import",
    "Validate imported rows atomically into draft items",
    obj({ items: z.array(TestItem).min(1).max(200) }),
    catalog.itemsImport,
  ],
  [
    "hr_test_item_draft_ai",
    "Request a human-reviewed draft through the AI plane",
    obj({ requisitionId: id }),
    (a) => catalog.aiDraft(a),
  ],
  [
    "hr_test_item_stats_get",
    "Read item difficulty, discrimination and exposure signals",
    ref,
    catalog.itemStats,
  ],
  [
    "hr_test_blueprints_list",
    "List assessment blueprint versions",
    list,
    catalog.blueprintList,
  ],
  [
    "hr_test_blueprint_get",
    "Read a blueprint version",
    ref,
    catalog.blueprintGet,
  ],
  [
    "hr_test_blueprint_create",
    "Create a blueprint draft",
    obj({ blueprint: TestBlueprint }),
    catalog.blueprintCreate,
  ],
  [
    "hr_test_blueprint_update",
    "Revise a blueprint and reset independent approvals",
    obj({ ...versioned, blueprint: TestBlueprint }),
    catalog.blueprintUpdate,
  ],
  [
    "hr_test_blueprint_approve",
    "Record one independent hiring-manager or HR approval",
    obj({ ...versioned, role: z.enum(["HIRING_MANAGER", "HR"]) }),
    catalog.blueprintApprove,
  ],
  [
    "hr_test_blueprint_publish",
    "Publish an approved blueprint after pool-depth validation",
    obj(versioned),
    catalog.blueprintPublish,
  ],
  [
    "hr_test_blueprint_link",
    "Bind a published blueprint to a recruitment scope",
    obj({
      blueprintId: id,
      scopeType: z.enum(["REQUISITION", "JOB_FAMILY_GRADE", "JOB_FAMILY"]),
      scopeId: z.string().min(1).max(200),
    }),
    catalog.blueprintLink,
  ],
  [
    "hr_test_blueprint_resolve",
    "Resolve the most specific published blueprint",
    obj({ requisitionId: id }),
    catalog.blueprintResolve,
  ],
  [
    "hr_test_blueprint_preview",
    "Validate blueprint pool availability without serving items",
    ref,
    catalog.blueprintPreview,
  ],
  [
    "hr_test_workstation_register",
    "Register or rotate a kiosk token; secret is returned once",
    obj({
      id: id.optional(),
      label: z.string().min(1).max(100),
      siteRef: z.string().min(1).max(100),
    }),
    sessions.workstationRegister,
  ],
  [
    "hr_test_workstations_list",
    "List kiosk status without credentials",
    obj({}),
    sessions.workstationsList,
  ],
  [
    "hr_test_workstation_revoke",
    "Immediately revoke a kiosk token",
    ref,
    sessions.workstationRevoke,
  ],
  [
    "hr_reception_arrivals_list",
    "List scheduled arrivals with no scores or answer keys",
    window,
    sessions.arrivalsList,
  ],
  [
    "hr_candidate_checkin",
    "Record minimal identity verification and explicit consent",
    obj({
      interviewId: id,
      idType: z.enum(["CNIC", "PASSPORT", "OTHER"]),
      idLast4: z.string().regex(/^\d{4}$/),
      consent: z.literal(true),
      photoMediaId: z.string().max(200).optional(),
      photoConsent: z.boolean().default(false),
      accommodationReason: reason.optional(),
    }),
    sessions.checkIn,
  ],
  [
    "hr_test_session_issue",
    "Issue or reissue a workstation-bound one-time session code",
    obj({
      interviewId: id,
      workstationId: id,
      extraTimePct: z.number().min(0).max(50).optional(),
      reason: reason.optional(),
    }),
    sessions.sessionIssue,
  ],
  [
    "hr_test_sessions_live_list",
    "Read live test progress and integrity counts for reception",
    obj({}),
    sessions.sessionsLive,
  ],
  ...["PAUSE", "RESUME", "VOID", "EXTEND"].map((action) => [
    "hr_test_session_" + action.toLowerCase(),
    "Record a reasoned proctor action",
    obj({
      ...versioned,
      reason,
      ...(action === "EXTEND"
        ? { extraTimePct: z.number().positive().max(50) }
        : {}),
    }),
    (a) => sessions.sessionControl(action, a),
  ]),
  [
    "hr_test_result_get",
    "Read a row-scoped result and integrity timeline",
    obj({ id, interviewId: id.optional() }),
    results.resultGet,
  ],
  [
    "hr_test_results_list",
    "List authorized test results",
    obj({
      applicationId: id.optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    results.resultsList,
  ],
  [
    "hr_test_result_decide",
    "Record a human proceed, release, override or retest decision",
    obj({
      id,
      decision: z.enum(["PROCEED", "RELEASE", "OVERRIDE", "RETEST"]),
      reason,
    }),
    results.resultDecide,
  ],
  [
    "hr_test_result_waive",
    "Record an authorized assessment waiver",
    obj({ interviewId: id, reason }),
    results.resultWaive,
  ],
  [
    "hr_test_analytics_get",
    "Read assessment completion and override measures",
    window,
    results.testAnalytics,
  ],
  [
    "hr_interview_form_get",
    "Read your pinned form, test report and permitted panel evidence",
    obj({ interviewId: id }),
    forms.formGet,
  ],
  [
    "hr_interview_scorecard_draft_save",
    "Save a version-checked draft to the server",
    FormSubmission,
    (a) => forms.formSave(a),
  ],
  [
    "hr_interview_questions_list",
    "Read job-related interview questions",
    list,
    forms.questionsList,
  ],
  [
    "hr_interview_question_create",
    "Create an interview question draft",
    obj({ question }),
    forms.questionSave,
  ],
  [
    "hr_interview_question_update",
    "Create a new version of an interview question",
    obj({ ...versioned, question }),
    forms.questionSave,
  ],
  [
    "hr_interview_question_retire",
    "Retire an interview question version",
    obj(versioned),
    forms.questionRetire,
  ],
  [
    "hr_interview_form_draft_ai",
    "Draft criteria through the AI plane for human review",
    obj({ requisitionId: id }),
    (a) => catalog.aiDraft(a, true),
  ],
  [
    "hr_interview_evaluation_summary_get",
    "Read authorized current or frozen evaluation evidence",
    obj({ interviewId: id }),
    forms.summaryGet,
  ],
  [
    "hr_interview_form_publish",
    "Independently publish a structured interview form",
    obj(versioned),
    forms.formPublish,
  ],
  [
    "hr_interview_question_publish",
    "Independently publish an interview question",
    obj(versioned),
    forms.questionPublish,
  ],
  [
    "hr_rater_calibration_get",
    "Read HR-only interviewer calibration measures",
    obj({}),
    forms.raterCalibration,
  ],
];
export function registerCandidateAssessmentTools(server) {
  for (const [name, description, schema, handler] of candidateAssessmentTools)
    server.registerTool(
      name,
      { description, inputSchema: schema },
      withToolError(
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await handler(schema.parse(args))),
            },
          ],
        }),
        name,
      ),
    );
}
