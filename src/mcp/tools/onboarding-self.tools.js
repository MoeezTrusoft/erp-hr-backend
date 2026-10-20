// src/mcp/tools/onboarding-self.tools.js
//
// Recruitment Phase 4 (plan 6.7) — the pre-boarding portal on the new hire's
// own checklist, plus HR's review of their uploads.
//
// Employee side (hr_self_onboarding_*): hr:self VIEW, the grant every employee
// holds (the same gate as the my-payslip family). The subject is ALWAYS the
// verified claim's employeeId: an employeeId argument is accepted only so a
// client that sends one is checked, and a DIFFERENT id is refused (403), never
// honoured, whatever else the session holds (an admin claim or an HR grant
// does not turn this into a view of someone else's portal; HR has its own
// tools). A session with no employee bound gets a calm 400.
//
// HR side (hr_onboarding_document_review / _documents_pending_list):
// hr:onboarding with the HTTP method (PUT to review, GET to list).
//
// Every tool answers 503 HR-ONBOARDING-SELF-PORTAL-DISABLED while the
// onboardingSelfPortal flag is off.
//
// Phase 6: hr_self_onboarding_document_download reads one of the caller's own
// documents back from DAM (the same pin; another hire's id is a plain 404).
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  ONBOARDING_UPLOAD_MAX_BASE64_LENGTH,
  ONBOARDING_UPLOAD_MIME_TYPES,
} from "../../lib/onboarding-upload.util.js";
import {
  DOCUMENT_CATEGORY_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
  REVIEW_DECISIONS,
  REVIEW_NOTE_MAX_LENGTH,
  SELF_SURVEY_TYPES,
  SURVEY_RESPONSES_SCHEMA,
  assertDocumentReviewEnabled,
  assertSelfPortalEnabled,
  completeMyTask,
  downloadMyDocument,
  getMyOnboarding,
  listPendingOnboardingDocuments,
  reopenMyTask,
  reviewOnboardingDocument,
  signMyDocument,
  submitMySurvey,
  uploadMyDocument,
} from "../../services/onboarding-self.service.js";

const SELF_RESOURCE = "hr:self";
const HR_RESOURCE = "hr:onboarding";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);
const selfEmployeeInput = idInput
  .optional()
  .describe("Ignored for selection: the portal is always the caller's own; a different id is refused");

/**
 * The caller's own employee id from the verified claim. A different explicit
 * id is refused; no binding is a 400.
 * @returns {number}
 */
export function resolveSelfEmployeeId(user, explicit) {
  const claim = Number(user?.employeeId);
  const acting = Number.isInteger(claim) && claim > 0 ? claim : null;
  const requested = explicit == null || explicit === "" ? null : Number(explicit);
  if (requested != null && requested !== acting) {
    throw Object.assign(new Error("Insufficient permissions: employeeId does not belong to the acting session"), {
      status: 403,
      code: "HR-4030",
    });
  }
  if (acting == null) {
    throw Object.assign(new Error("Your account is not linked to an employee record"), {
      status: 400,
      code: "HR-ONBOARDING-SELF-NO-EMPLOYEE",
    });
  }
  return acting;
}

// Permission, then the flag, then the pin to the caller.
function selfCaller(explicitEmployeeId) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, "GET", SELF_RESOURCE, user.isAdmin);
  assertSelfPortalEnabled();
  return { tenantId: user.tenantId, employeeId: resolveSelfEmployeeId(user, explicitEmployeeId) };
}

function hrCaller(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, HR_RESOURCE, user.isAdmin);
  assertDocumentReviewEnabled();
  const reviewer = Number(user.employeeId);
  return { tenantId: user.tenantId, reviewerId: Number.isInteger(reviewer) && reviewer > 0 ? reviewer : null };
}

export function registerOnboardingSelfTools(server) {
  server.tool(
    "hr_self_onboarding_get",
    "Your own pre-boarding portal: checklist status, stage, start date and progress counts; the tasks assigned to you (counts only for HR, IT and manager tasks); orientation sessions (date, time, location, type); your documents (title, category, whether a signature is needed and given, who supplied it, HR's review status and the note on a rejection); open 30/60/90 day surveys with their due dates; and your buddy's and manager's name and work email. An empty answer (checklist null) when you have no onboarding checklist.",
    { employeeId: selfEmployeeInput },
    withToolError(async ({ employeeId } = {}) => {
      const caller = selfCaller(employeeId);
      return text(await getMyOnboarding(caller));
    }, "hr_self_onboarding_get"),
  );

  server.tool(
    "hr_self_onboarding_task_complete",
    "Mark one of your own onboarding tasks (assigned to the new hire) as done. Already done is not an error (changed false).",
    { taskId: idInput.describe("Onboarding task id"), employeeId: selfEmployeeInput },
    withToolError(async ({ taskId, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await completeMyTask({ ...caller, taskId }));
    }, "hr_self_onboarding_task_complete"),
  );

  server.tool(
    "hr_self_onboarding_task_reopen",
    "Reopen one of your own onboarding tasks (assigned to the new hire) that you marked done. Already open is not an error (changed false).",
    { taskId: idInput.describe("Onboarding task id"), employeeId: selfEmployeeInput },
    withToolError(async ({ taskId, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await reopenMyTask({ ...caller, taskId }));
    }, "hr_self_onboarding_task_reopen"),
  );

  server.tool(
    "hr_self_onboarding_document_upload",
    "Upload a document HR asked you for (PDF, JPEG or PNG, at most 10 MB) to your onboarding checklist. HR reviews it (status PENDING until then).",
    {
      title: z.string().min(1).max(DOCUMENT_TITLE_MAX_LENGTH).describe("What the document is, e.g. 'CNIC front'"),
      category: z.string().max(DOCUMENT_CATEGORY_MAX_LENGTH).optional().describe("Document category, e.g. IDENTITY or EDUCATION"),
      fileName: z.string().min(1).max(255).describe("Original file name with its extension (.pdf, .jpg, .jpeg, .png)"),
      mimeType: z.enum(ONBOARDING_UPLOAD_MIME_TYPES).describe("application/pdf | image/jpeg | image/png"),
      contentBase64: z.string().min(1).max(ONBOARDING_UPLOAD_MAX_BASE64_LENGTH + 4096).describe("The file content, base64 encoded"),
      employeeId: selfEmployeeInput,
    },
    withToolError(async ({ employeeId, title, category, fileName, mimeType, contentBase64 }) => {
      const caller = selfCaller(employeeId);
      return text(await uploadMyDocument({ ...caller, title, category, fileName, mimeType, contentBase64 }));
    }, "hr_self_onboarding_document_upload"),
  );

  server.tool(
    "hr_self_onboarding_document_sign",
    "Sign a document HR gave you that needs your signature (for example a policy acknowledgement).",
    { documentId: idInput.describe("Onboarding document id"), employeeId: selfEmployeeInput },
    withToolError(async ({ documentId, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await signMyDocument({ ...caller, documentId }));
    }, "hr_self_onboarding_document_sign"),
  );

  server.tool(
    "hr_self_onboarding_document_download",
    "Open one of your own onboarding documents: a document HR gave you to read or sign (for example a policy), or a file you uploaded. Returns the file as base64 with its MIME type and file name (at most 15 MB). Only documents on your own checklist; any other id reads as not found.",
    { documentId: idInput.describe("Onboarding document id (from hr_self_onboarding_get)"), employeeId: selfEmployeeInput },
    withToolError(async ({ documentId, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await downloadMyDocument({ ...caller, documentId }));
    }, "hr_self_onboarding_document_download"),
  );

  server.tool(
    "hr_self_onboarding_survey_submit",
    "Submit your 30, 60 or 90 day onboarding survey once it has been sent to you. Answers are keyed by question id.",
    {
      type: z.enum(SELF_SURVEY_TYPES).describe("DAY_30 | DAY_60 | DAY_90"),
      responses: SURVEY_RESPONSES_SCHEMA.describe("Answers keyed by question id (text, number, yes/no or a list of choices)"),
      employeeId: selfEmployeeInput,
    },
    withToolError(async ({ type, responses, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await submitMySurvey({ ...caller, type, responses }));
    }, "hr_self_onboarding_survey_submit"),
  );

  server.tool(
    "hr_onboarding_document_review",
    "Verify or reject a document a new hire uploaded through the pre-boarding portal (PENDING only). A note is required on a rejection and is shown to the new hire.",
    {
      documentId: idInput.describe("Onboarding document id"),
      decision: z.enum(REVIEW_DECISIONS).describe("VERIFIED | REJECTED"),
      note: z.string().max(REVIEW_NOTE_MAX_LENGTH).optional().describe("Required on REJECTED: what the new hire should fix"),
    },
    withToolError(async ({ documentId, decision, note }) => {
      const caller = hrCaller("PUT");
      return text(await reviewOnboardingDocument({ ...caller, documentId, decision, note }));
    }, "hr_onboarding_document_review"),
  );

  server.tool(
    "hr_onboarding_documents_pending_list",
    "List documents new hires uploaded that wait for HR review, oldest first, optionally for one checklist or employee.",
    {
      checklistId: idInput.optional().describe("Only this checklist"),
      employeeId: idInput.optional().describe("Only this employee"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async ({ checklistId, employeeId, page, limit } = {}) => {
      const { tenantId } = hrCaller("GET");
      return text(await listPendingOnboardingDocuments({ tenantId, checklistId, employeeId, page, limit }));
    }, "hr_onboarding_documents_pending_list"),
  );
}
