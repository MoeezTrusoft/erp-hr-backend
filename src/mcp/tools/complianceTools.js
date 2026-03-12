import { z } from "zod";
import {
  mcpApproveReimbursement,
  mcpCreateComplianceChecklist,
  mcpCreateReimbursement,
  mcpEraseGdprEmployeeData,
  mcpExportGdprEmployeeData,
  mcpListComplianceChecklists,
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

  server.tool(
    "hr_compliance_checklist_create",
    "Create a compliance checklist",
    {
      name: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      applicableTo: z.string().optional().describe("e.g. ALL, MANAGERS, CONTRACTORS"),
      departmentId: z.string().optional(),
      positionId: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/compliance/checklists", user.isAdmin);
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
      id: z.string().min(1),
      status: z.string().min(1).describe("e.g. PENDING, COMPLETED, NOT_APPLICABLE"),
      evidence: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/compliance/items/${id}`, user.isAdmin);
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
      assertPermission(permissions, "GET", `/hr/api/gdpr/export/${employeeId}`, user.isAdmin);
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
      assertPermission(permissions, "DELETE", `/hr/api/gdpr/erase/${employeeId}`, user.isAdmin);
      const data = await mcpEraseGdprEmployeeData(user, employeeId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── REIMBURSEMENTS ───────────────────────────────────────────────────────

  server.tool(
    "hr_reimbursement_create",
    "Submit a reimbursement claim",
    {
      employeeId: z.string().min(1),
      amount: z.number().positive(),
      currency: z.string().default("USD"),
      description: z.string().min(1),
      receiptDate: z.string().describe("ISO 8601 date"),
      category: z.string().optional().describe("e.g. TRAVEL, MEALS, EQUIPMENT"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/reimbursements", user.isAdmin);
      const data = await mcpCreateReimbursement(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_reimbursement_update",
    "Approve a reimbursement claim",
    {
      id: z.string().min(1),
      approverId: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/reimbursements/${id}/approve`, user.isAdmin);
      const data = await mcpApproveReimbursement(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
