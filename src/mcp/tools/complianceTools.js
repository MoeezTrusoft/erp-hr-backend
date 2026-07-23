import { z } from "zod";
import {
  mcpApproveReimbursement,
  mcpCreateComplianceChecklist,
  mcpCreateReimbursement,
  mcpEraseGdprEmployeeData,
  mcpExportGdprEmployeeData,
  mcpListAuditLogs,
  mcpListComplianceChecklists,
  mcpListDocumentExpiryAlerts,
  mcpListGdprRecords,
  mcpUpdateComplianceItem,
} from "../controllers/complianceMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerComplianceTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_compliance_checklists_list",
    "hr://compliance/checklists",
    { description: "List all compliance checklists" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListComplianceChecklists(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.resource(
    "hr_compliance_audit_logs",
    "hr://compliance/audit-logs",
    { description: "List HR audit logs for reports" },
    async (uri) => {
      getCtx();
      const data = await mcpListAuditLogs();
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_compliance_document_expiry_alerts",
    "hr://compliance/document-expiry-alerts",
    { description: "List employee document expiry alerts" },
    async (uri) => {
      getCtx();
      const data = await mcpListDocumentExpiryAlerts();
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_compliance_gdpr_records",
    "hr://compliance/gdpr-records",
    { description: "List GDPR/privacy records derived from employee data" },
    async (uri) => {
      getCtx();
      const data = await mcpListGdprRecords();
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_compliance_checklist_create",
    "Create a compliance checklist",
    {
      name: z.string().min(1).optional().describe("Checklist name (persisted to ComplianceChecklist.name, NOT NULL). Provide `name` or `title` — at least one is required."),
      title: z.string().min(1).optional().describe("Alias for `name`; used when `name` is omitted"),
      description: z.string().optional(),
      applicableTo: z.string().optional().describe("Free-text audience label, e.g. ALL, MANAGERS, CONTRACTORS"),
      departmentId: z.string().optional().describe("Scope to a department (references Department.id)"),
      positionId: z.string().optional().describe("Scope to a position (references Position.id)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:compliance", user.isAdmin);
      // NOT NULL guard: ComplianceChecklist.name is required, so one of name/title must be present.
      if (!args.name && !args.title) {
        throw Object.assign(new Error("Either name or title is required"), { status: 400 });
      }
      const payload = {
        ...args,
        name: args.name || args.title,
      };
      const data = await mcpCreateComplianceChecklist(user, payload);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_compliance_item_update",
    "Update a compliance checklist item (mark as complete)",
    {
      id: z.string().min(1).describe("Compliance item id (references ComplianceItem.id)"),
      status: z.enum(["PENDING", "COMPLETED", "OVERDUE", "WAIVED"]).describe("Item status — one of PENDING | COMPLETED | OVERDUE | WAIVED"),
      evidence: z.string().optional().describe("Free-text evidence reference/note"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:compliance", user.isAdmin);
      const data = await mcpUpdateComplianceItem(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── GDPR TOOLS ───────────────────────────────────────────────────────────

  server.tool(
    "hr_gdpr_export_employee_data",
    "Export all personal data for an employee (GDPR Subject Access Request)",
    { employeeId: z.string().min(1) },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:gdpr", user.isAdmin);
      const data = await mcpExportGdprEmployeeData(user, employeeId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_gdpr_erase_employee_data",
    "Erase all personal data for an employee (GDPR Right to be Forgotten)",
    {
      employeeId: z.string().min(1),
      confirmErase: z.literal(true).describe("Must be true to confirm the irreversible erasure"),
    },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:gdpr", user.isAdmin);
      const data = await mcpEraseGdprEmployeeData(user, employeeId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── REIMBURSEMENTS ───────────────────────────────────────────────────────

  server.tool(
    "hr_reimbursement_create",
    "Submit a reimbursement claim",
    {
      employeeId: z.string().min(1).describe("Employee submitting the claim (references Employee.id)"),
      amount: z.number().positive().describe("Claim amount (ReimbursementClaim.amount, > 0)"),
      currency: z.string().default("USD").describe("ISO 4217 currency code (default USD)"),
      description: z.string().min(1).describe("Claim description (persisted to ReimbursementClaim.title, NOT NULL)"),
      category: z.string().optional().describe("Free-text category, e.g. TRAVEL, MEALS, EQUIPMENT"),
      notes: z.string().optional().describe("Optional notes (ReimbursementClaim.notes)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:reimbursement", user.isAdmin);
      const data = await mcpCreateReimbursement(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_reimbursement_update",
    "Approve a reimbursement claim",
    {
      id: z.string().min(1).describe("Reimbursement claim id to approve (references ReimbursementClaim.id)"),
      approverId: z.string().optional().describe("Approving employee id (references Employee.id); falls back to the caller's x-employee-id header when omitted"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:reimbursement", user.isAdmin);
      const data = await mcpApproveReimbursement(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
