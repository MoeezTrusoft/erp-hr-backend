// src/mcp/tools/requisitionMgmtTools.js — Job Requisition Management MCP tools.
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
// duplicated here (recruitmentTools.js → recruitmentMcpController.js):
//   hr_requisition_create / _update / _delete / _approve / _post
// Position deactivation is hr_position_status_update (employeeTools.js).
//
// Auth: every handler runs getCtx() → assertPermission(<method>, "hr:recruitment")
// → service(..., user.tenantId), matching the existing recruitment tools.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listManagedRequisitions,
  getManagedRequisition,
  submitRequisition,
  rejectRequisition,
  closeRequisition,
  exportManagedRequisitions,
} from "../../services/requisitionMgmt.service.js";

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
    .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED"])
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
      const data = await listManagedRequisitions(query, user.tenantId);
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
      const data = await getManagedRequisition(id, user.tenantId);
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
      const data = await submitRequisition(id, user.tenantId);
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
    "Close a job requisition (status → CLOSED).",
    { id: z.string().min(1).describe("Requisition ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await closeRequisition(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_close")
  );

  server.tool(
    "hr_requisitions_export",
    "Export the job-requisition management view (all rows matching the filters) as CSV or PDF. Columns: Req ID, Title, Department, Manager, Openings, Priority, Status. Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf"]).default("csv"),
      q: z.string().optional(),
      status: z
        .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED"])
        .optional(),
      priority: z.string().optional(),
      departmentId: z.coerce.number().int().optional(),
      sort: z.enum(["createdAt", "title", "priority", "status"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async ({ format, ...query }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await exportManagedRequisitions(query, user.tenantId, format);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisitions_export")
  );
}
