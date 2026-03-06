import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


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
      const data = await self("GET", "/api/compliance/checklists", user);
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
      const data = await self("POST", "/api/compliance/checklists", user, payload);
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
      const data = await self("PUT", `/api/compliance/items/${id}`, user, rest);
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
      const data = await self("GET", `/api/gdpr/export/${employeeId}`, user);
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
      const data = await self("DELETE", `/api/gdpr/erase/${employeeId}`, user);
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
      const data = await self("POST", "/api/reimbursements", user, args);
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
      const data = await self("PUT", `/api/reimbursements/${id}/approve`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
