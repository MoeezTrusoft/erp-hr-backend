// src/mcp/tools/lifecycleComplianceTools.js — Employee Lifecycle + Compliance tools.
//
// Lifecycle: LIST + GET (CREATE exists). ComplianceChecklist: LIST + GET + UPDATE + DELETE (CREATE exists).
// ComplianceItem: LIST + GET + CREATE + DELETE (UPDATE exists).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { listEvents, getEmployeeHistory, logEvent } from "../../services/employeeLifecycle.service.js";
import prisma from "../../lib/prisma.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLifecycleComplianceTools(server) {
  // ── Employee Lifecycle Events ─────────────────────────────────────────
  server.tool(
    "hr_lifecycle_event_list",
    "List employee lifecycle events with optional type filter",
    {
      type: z.string().optional().describe("Filter by event type"),
      employeeId: z.union([z.number(), z.string()]).optional().describe("Filter by employee"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await listEvents({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_lifecycle_event_list")
  );

  server.tool(
    "hr_lifecycle_event_get",
    "Get lifecycle history for an employee",
    { employeeId: z.union([z.number(), z.string()]).describe("Employee ID") },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await getEmployeeHistory(employeeId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_lifecycle_event_get")
  );

  server.tool(
    "hr_lifecycle_event_update",
    "Update an employee lifecycle event",
    {
      id: z.union([z.number(), z.string()]).describe("Event ID"),
      notes: z.string().optional().describe("Updated notes"),
      metadata: z.record(z.string(), z.any()).optional().describe("Updated metadata"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const result = await prisma.employeeLifecycleEvent.update({ where: { id: Number(id) }, data });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_lifecycle_event_update")
  );

  server.tool(
    "hr_lifecycle_event_delete",
    "Delete an employee lifecycle event",
    { id: z.union([z.number(), z.string()]).describe("Event ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      await prisma.employeeLifecycleEvent.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_lifecycle_event_delete")
  );

  // ── Compliance Checklist ──────────────────────────────────────────────
  server.tool(
    "hr_compliance_checklist_list",
    "List all compliance checklists",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:compliance", user.isAdmin);
      const data = await prisma.complianceChecklist.findMany({ orderBy: { createdAt: "desc" } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_compliance_checklist_list")
  );

  server.tool(
    "hr_compliance_checklist_get",
    "Get a compliance checklist by ID with its items",
    { id: z.union([z.number(), z.string()]).describe("Checklist ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:compliance", user.isAdmin);
      const data = await prisma.complianceChecklist.findUnique({
        where: { id: Number(id) },
        include: { items: true },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_compliance_checklist_get")
  );

  server.tool(
    "hr_compliance_checklist_update",
    "Update a compliance checklist",
    {
      id: z.union([z.number(), z.string()]).describe("Checklist ID"),
      name: z.string().optional().describe("Checklist name"),
      status: z.string().optional().describe("Checklist status"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:compliance", user.isAdmin);
      const result = await prisma.complianceChecklist.update({ where: { id: Number(id) }, data });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_compliance_checklist_update")
  );

  server.tool(
    "hr_compliance_checklist_delete",
    "Delete a compliance checklist",
    { id: z.union([z.number(), z.string()]).describe("Checklist ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:compliance", user.isAdmin);
      await prisma.complianceChecklist.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_compliance_checklist_delete")
  );

  // ── Compliance Item ───────────────────────────────────────────────────
  server.tool(
    "hr_compliance_item_list",
    "List compliance items for a checklist",
    {
      checklistId: z.union([z.number(), z.string()]).optional().describe("Filter by checklist ID"),
    },
    withToolError(async ({ checklistId } = {}) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:compliance", user.isAdmin);
      const where = checklistId ? { checklistId: Number(checklistId) } : {};
      const data = await prisma.complianceItem.findMany({ where, orderBy: { createdAt: "desc" } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_compliance_item_list")
  );

  server.tool(
    "hr_compliance_item_get",
    "Get a compliance item by ID",
    { id: z.union([z.number(), z.string()]).describe("Item ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:compliance", user.isAdmin);
      const data = await prisma.complianceItem.findUnique({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_compliance_item_get")
  );

  server.tool(
    "hr_compliance_item_create",
    "Create a new compliance item",
    {
      checklistId: z.union([z.number(), z.string()]).describe("Parent checklist ID"),
      title: z.string().min(1).describe("Item title"),
      description: z.string().optional().describe("Item description"),
      status: z.string().optional().describe("Item status"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:compliance", user.isAdmin);
      const data = await prisma.complianceItem.create({ data: { ...args, checklistId: Number(args.checklistId) } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_compliance_item_create")
  );

  server.tool(
    "hr_compliance_item_delete",
    "Delete a compliance item",
    { id: z.union([z.number(), z.string()]).describe("Item ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:compliance", user.isAdmin);
      await prisma.complianceItem.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_compliance_item_delete")
  );
}
