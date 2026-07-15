// src/mcp/tools/profileActionTools.js — Employee-Profile WRITE actions +
// Activity export MCP tools.
//
// DOCUMENT actions operate on the EmployeeMedia model (tenant-scoped). Perms:
//   verify / mark-missing → PUT hr:employee
//   remove                → DELETE hr:employee
// ACTIVITY export → GET hr:employee.
//
// NOTE: "add document" is already shipped as hr_employee_document_create in
// employeeTools.js and is intentionally NOT duplicated here.

import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  markDocumentVerified,
  markDocumentMissing,
  removeDocument,
  exportActivity,
} from "../../services/profileActions.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerProfileActionTools(server) {
  server.tool(
    "hr_document_mark_verified",
    "Mark an employee document (EmployeeMedia) as verified. Returns the updated document.",
    { documentId: z.union([z.string(), z.number()]).describe("EmployeeMedia row id") },
    withToolError(async ({ documentId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await markDocumentVerified(documentId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_document_mark_verified")
  );

  server.tool(
    "hr_document_mark_missing",
    "Mark an employee document (EmployeeMedia) as missing. Returns the updated document.",
    { documentId: z.union([z.string(), z.number()]).describe("EmployeeMedia row id") },
    withToolError(async ({ documentId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await markDocumentMissing(documentId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_document_mark_missing")
  );

  server.tool(
    "hr_document_remove",
    "Delete an employee document (EmployeeMedia) row. Hard delete (the model has no soft-delete column). Returns { success, id }.",
    { documentId: z.union([z.string(), z.number()]).describe("EmployeeMedia row id") },
    withToolError(async ({ documentId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      const data = await removeDocument(documentId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_document_remove")
  );

  server.tool(
    "hr_activity_export",
    "Export HR audit/activity log rows as CSV or PDF. Optionally scope to one employee and/or a date range. Returns { format, fileName, mimeType, count, base64 }.",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("Scope to one employee; omit for a tenant-wide export"),
      format: z.enum(["csv", "pdf"]).default("csv"),
      from: z.string().optional().describe("Lower bound ISO date/time (inclusive)"),
      to: z.string().optional().describe("Upper bound ISO date/time (inclusive)"),
    },
    withToolError(async ({ employeeId, format, from, to }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await exportActivity({ employeeId, format, from, to }, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_activity_export")
  );
}
