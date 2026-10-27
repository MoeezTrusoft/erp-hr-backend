// src/mcp/tools/requisition-mgmt.tools.js — Job Requisition Management MCP tools.
//
// Read / lifecycle-action / export surface for the requisition-management
// screens:
//   hr_requisitions_manage_list — enhanced, paginated management list
//   hr_requisition_manage_get   — single requisition + full detail + approvals
//   hr_requisition_submit       — DRAFT → PENDING_APPROVAL
//   hr_requisition_reject       — → REJECTED (+ RequisitionApproval row)
//   hr_requisition_close        — → CLOSED
//   hr_requisitions_export      — CSV/PDF export of the management view
//
// Create / update / delete / approve / post already exist and are NOT
// duplicated here (recruitment.tools.js → recruitmentMcpController.js):
//   hr_requisition_create / _update / _delete / _approve / _post
// Position deactivation is hr_position_status_update (employeeTools.js).
//
// Auth: every handler runs getCtx() → assertPermission(<method>, "hr:recruitment")
// → service(..., user.tenantId), matching the existing recruitment tools.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import { assertNoAgencyExport } from "../../lib/agency-access.util.js";
import {
  listManagedRequisitions,
  getManagedRequisition,
  submitRequisition,
  rejectRequisition,
  closeRequisition,
  exportManagedRequisitions,
} from "../../services/requisition-mgmt.service.js";
import {
  listQuestions,
  createQuestion,
  updateQuestion,
  deactivateQuestion,
  reorderQuestions,
} from "../../services/application-question.service.js";
import { QUESTION_TYPES } from "../../lib/application-questions.util.js";
import {
  withdrawRequisition,
  unpublishPosting,
  listRequisitionPostings,
} from "../../services/requisition-publication.service.js";
import {
  PUBLICATION_CHANNELS,
  POSTING_CLOSE_REASONS,
  WITHDRAWAL_REASONS,
} from "../../lib/requisition-publication.util.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Shared list/filter shape for the management list + export.
const manageListShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().optional().describe("Search by requisition title"),
  status: z
    .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED", "WITHDRAWN"])
    .optional()
    .describe("Filter by requisition status"),
  priority: z.string().optional().describe("Filter by priority (Low|Medium|High|Urgent)"),
  departmentId: z.coerce.number().int().optional().describe("Filter by department (RBAC Department.id)"),
  sort: z.enum(["createdAt", "title", "priority", "status"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
};

export function registerRequisitionMgmtTools(server) {
  server.tool(
    "hr_requisitions_manage_list",
    "Enhanced job-requisition management list: reqId, title, department, manager (requested-by), open count, priority, status, job description, requirements, and approval history. Supports pagination, search (title), status/priority/departmentId filters, and sort (createdAt|title|priority|status).",
    manageListShape,
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const query = { page: 1, pageSize: 10, ...args };
      // Phase 1.4 — MCP parity with the REST list: same record scope.
      const data = await listManagedRequisitions(query, user.tenantId, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisitions_manage_list")
  );

  server.tool(
    "hr_requisition_manage_get",
    "Get a single job requisition with full management detail (title, department, manager, open count, priority, status, job description, requirements) plus its complete approval history.",
    { id: z.string().min(1).describe("Requisition ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getManagedRequisition(id, user.tenantId, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_manage_get")
  );

  server.tool(
    "hr_requisition_submit",
    "Submit a job requisition for approval (status → PENDING_APPROVAL).",
    { id: z.string().min(1).describe("Requisition ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      // Phase 2.1 — the history row is attributed to the verified caller.
      const data = await submitRequisition(id, user.tenantId, user.employeeId ?? null);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_submit")
  );

  server.tool(
    "hr_requisition_reject",
    "Reject a job requisition (status → REJECTED) and record an approval-history entry (approver = caller) with optional rejection comments.",
    {
      id: z.string().min(1).describe("Requisition ID"),
      comments: z.string().optional().describe("Rejection reason / comments"),
    },
    withToolError(async ({ id, comments }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      if (user.employeeId == null || user.employeeId === "") {
        throw Object.assign(
          new Error("Caller has no employee context; cannot record rejection"),
          { status: 400 }
        );
      }
      const data = await rejectRequisition(id, user.tenantId, {
        comments,
        approverId: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_reject")
  );

  server.tool(
    "hr_requisition_close",
    "Close a job requisition (status → CLOSED, terminal) and take it off every channel it was published to. Closing a PUBLISHED requisition requires a reason; closing a draft or rejected one does not.",
    {
      id: z.string().min(1).describe("Requisition ID"),
      reason: z
        .string()
        .optional()
        .describe("Mandatory when the requisition is POSTED — why the search is ending"),
    },
    withToolError(async ({ id, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      // Phase 2.1 — the history row is attributed to the verified caller.
      const data = await closeRequisition(id, user.tenantId, user.employeeId ?? null, reason ?? null);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_close")
  );

  // ── Phase 4 / §2.4 + §2.4a — publication and withdrawal ────────────────────

  server.tool(
    "hr_requisition_postings_list",
    `List a requisition's channel postings (Phase 4). Returns the requisition status, every posting with its channel, URL, active flag, posted/closed timestamps and close reason, and the list of currently active channels. Channels: ${PUBLICATION_CHANNELS.join(" | ")}.`,
    {
      id: z.string().min(1).describe("Requisition ID"),
      includeClosed: z
        .coerce.boolean()
        .optional()
        .describe("Include closed postings (default true); false returns only what is live"),
    },
    withToolError(async ({ id, includeClosed }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listRequisitionPostings(id, user.tenantId, {
        includeClosed: includeClosed !== false,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_postings_list")
  );

  server.tool(
    "hr_requisition_posting_unpublish",
    `Close ONE channel's posting (§2.4a) with a coded reason. The REQUISITION stays POSTED — this takes the job off a single board, it does not end the search. Identify the posting by postingId, or by id + channel. Close reasons: ${POSTING_CLOSE_REASONS.join(" | ")}; OTHER requires a note.`,
    {
      postingId: z.coerce.number().int().optional().describe("JobPosting id (preferred)"),
      id: z.string().optional().describe("Requisition ID — used with `channel` when postingId is unknown"),
      channel: z.enum(PUBLICATION_CHANNELS).optional().describe("Channel to close"),
      reason: z.enum(POSTING_CLOSE_REASONS).describe("Coded reason for closing this posting"),
      note: z.string().optional().describe("Required when reason is OTHER"),
    },
    withToolError(async ({ postingId, id, channel, reason, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      if (postingId == null && (id == null || channel == null)) {
        throw Object.assign(
          new Error("Provide postingId, or id together with channel"),
          { status: 400 }
        );
      }
      const data = await unpublishPosting({
        postingId,
        requisitionId: id ?? null,
        channel: channel ?? null,
        reason,
        note,
        actorId: user.employeeId ?? null,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_posting_unpublish")
  );

  server.tool(
    "hr_requisition_withdraw",
    `Withdraw a requisition (§2.4a / FR-01.07) — terminal, and it closes ALL active postings in the same transaction. Allowed from PENDING_APPROVAL, APPROVED or POSTED. Reasons: ${WITHDRAWAL_REASONS.join(" | ")}; OTHER requires a note.`, 
    {
      id: z.string().min(1).describe("Requisition ID"),
      reason: z.enum(WITHDRAWAL_REASONS).describe("Coded reason for withdrawing"),
      note: z.string().optional().describe("Required when reason is OTHER"),
    },
    withToolError(async ({ id, reason, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await withdrawRequisition({
        id,
        reason,
        note,
        actorId: user.employeeId ?? null,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_withdraw")
  );

  // ── Phase 5 / §3.5 — per-requisition application questions ──────────────
  // A question that already has answers is immutable (409); the tool message
  // says exactly what to do instead, because an agent that just sees "conflict"
  // tends to retry rather than version.

  server.tool(
    "hr_requisition_questions_list",
    "List the active application questions (form schema) for a requisition, in display order, with type, prompt, required flag, options, scoring weights, maxScore, and the knockout flag and knockoutRule.",
    { id: z.string().min(1).describe("Requisition ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listQuestions(Number(id), user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_questions_list")
  );

  server.tool(
    `hr_requisition_question_create`,
    `Add an application question to a requisition's intake form. Types: ${QUESTION_TYPES.join(" | ")}. Choice types need options [{value,label}]; NUMBER may carry options {min,max}; optional weights make it scored deterministically (maxScore is derived from the weights, never claimed separately). A REQUIRED SINGLE_CHOICE / MULTI_CHOICE / BOOLEAN / NUMBER question may be a knockout: knockout true with knockoutRule {values:[..]} (choice or BOOLEAN answers that disqualify) or {min,max} (NUMBER answers outside the band disqualify).`,
    {
      id: z.string().min(1).describe("Requisition ID"),
      type: z.enum(QUESTION_TYPES),
      prompt: z.string().min(1).max(2000),
      required: z.boolean().optional().describe("Default false"),
      orderIndex: z.coerce.number().int().min(0).optional().describe("Defaults to appending last"),
      options: z.any().optional().describe("[{value,label}] for choice types; {min,max} for NUMBER"),
      weights: z.any().optional().describe("Scoring map; omit for an unscored question"),
      knockout: z.boolean().optional().describe("Knockout question (required questions only); default false"),
      knockoutRule: z.any().optional().describe("{values:[..]} for choice/BOOLEAN, {min,max} for NUMBER; required when knockout is true"),
    },
    withToolError(async ({ id, ...definition }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await createQuestion(Number(id), user.tenantId, definition, user.employeeId ?? null);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_question_create")
  );

  server.tool(
    "hr_requisition_question_update",
    "Update a question that has NO answers yet. A question with answers is immutable — the tool refuses (409) and the caller should deactivate it and create a new version.",
    {
      id: z.string().min(1).describe("Requisition ID"),
      questionId: z.coerce.number().int().describe("ApplicationQuestion ID"),
      prompt: z.string().min(1).max(2000).optional(),
      required: z.boolean().optional(),
      orderIndex: z.coerce.number().int().min(0).optional(),
      options: z.any().optional(),
      weights: z.any().optional(),
      knockout: z.boolean().optional().describe("false also clears the stored rule"),
      knockoutRule: z.any().optional(),
    },
    withToolError(async ({ id, questionId, ...definition }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await updateQuestion(Number(id), user.tenantId, questionId, definition, user.employeeId ?? null);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_question_update")
  );

  server.tool(
    "hr_requisition_question_deactivate",
    "Remove a question from the requisition's intake form. With answers it is deactivated (history keeps pointing at it); with none it is deleted outright.",
    {
      id: z.string().min(1).describe("Requisition ID"),
      questionId: z.coerce.number().int().describe("ApplicationQuestion ID"),
    },
    withToolError(async ({ id, questionId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await deactivateQuestion(Number(id), user.tenantId, questionId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_question_deactivate")
  );

  server.tool(
    "hr_requisition_questions_reorder",
    "Set the display order of a requisition's active application questions. orderedIds must contain exactly the active question IDs in the desired order.",
    {
      id: z.string().min(1).describe("Requisition ID"),
      orderedIds: z.array(z.coerce.number().int()).min(1),
    },
    withToolError(async ({ id, orderedIds }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await reorderQuestions(Number(id), user.tenantId, orderedIds);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_questions_reorder")
  );

  server.tool(
    "hr_requisitions_export",
    "Export the job-requisition management view (all rows matching the filters) as CSV or PDF. Columns: Req ID, Title, Department, Manager, Openings, Priority, Status. Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf"]).default("csv"),
      q: z.string().optional(),
      status: z
        .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED", "WITHDRAWN"])
        .optional(),
      priority: z.string().optional(),
      departmentId: z.coerce.number().int().optional(),
      sort: z.enum(["createdAt", "title", "priority", "status"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async ({ format, ...query }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      assertNoAgencyExport(user);
      // An export must not become the way around the record scope.
      const data = await exportManagedRequisitions(query, user.tenantId, format, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisitions_export")
  );
}
