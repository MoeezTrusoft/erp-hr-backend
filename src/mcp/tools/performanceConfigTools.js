// src/mcp/tools/performanceConfigTools.js — Performance configuration MCP tools.
//
// Covers PerformanceCycle, PerformanceTemplate, and PerformanceMetric.
// All gated on hr:performance and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  createPerformanceCycle,
  getAllPerformanceCycles,
  getPerformanceCycleById,
  updatePerformanceCycle,
  deletePerformanceCycle,
} from "../../services/performanceCycleService.js";
import {
  createPerformanceTemplate,
  getAllPerformanceTemplates,
  getPerformanceTemplateById,
  updatePerformanceTemplate,
  deletePerformanceTemplate,
} from "../../services/performanceTemplateService.js";
import {
  createMetric,
  listMetrics,
  deactivateMetric,
} from "../../services/performanceMetricService.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerPerformanceConfigTools(server) {
  // ── PerformanceCycle ──────────────────────────────────────────────────
  server.tool(
    "hr_performance_cycle_list",
    "List all performance review cycles",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await getAllPerformanceCycles(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_cycle_list")
  );

  server.tool(
    "hr_performance_cycle_get",
    "Get a performance cycle by ID",
    { id: z.union([z.number(), z.string()]).describe("Performance cycle ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await getPerformanceCycleById(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_cycle_get")
  );

  server.tool(
    "hr_performance_cycle_create",
    "Create a new performance review cycle",
    {
      name: z.string().min(1).describe("Cycle name"),
      startDate: z.string().describe("Start date (ISO 8601)"),
      endDate: z.string().describe("End date (ISO 8601)"),
      description: z.string().optional().describe("Cycle description"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await createPerformanceCycle(args, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_cycle_create")
  );

  server.tool(
    "hr_performance_cycle_update",
    "Update a performance cycle",
    {
      id: z.union([z.number(), z.string()]).describe("Cycle ID"),
      name: z.string().optional().describe("Cycle name"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      status: z.string().optional().describe("Cycle status"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const result = await updatePerformanceCycle(id, data, user.employeeId || user.userId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_performance_cycle_update")
  );

  server.tool(
    "hr_performance_cycle_delete",
    "Delete a performance cycle",
    { id: z.union([z.number(), z.string()]).describe("Cycle ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:performance", user.isAdmin);
      const data = await deletePerformanceCycle(id, user.employeeId || user.userId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_cycle_delete")
  );

  // ── PerformanceTemplate ───────────────────────────────────────────────
  server.tool(
    "hr_performance_template_list",
    "List all performance review templates",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await getAllPerformanceTemplates(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_template_list")
  );

  server.tool(
    "hr_performance_template_get",
    "Get a performance template by ID",
    { id: z.union([z.number(), z.string()]).describe("Template ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await getPerformanceTemplateById(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_template_get")
  );

  server.tool(
    "hr_performance_template_create",
    "Create a new performance review template",
    {
      name: z.string().min(1).describe("Template name"),
      description: z.string().optional().describe("Template description"),
      criteria: z.array(z.string()).optional().describe("Evaluation criteria"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await createPerformanceTemplate(args, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_template_create")
  );

  server.tool(
    "hr_performance_template_update",
    "Update a performance template",
    {
      id: z.union([z.number(), z.string()]).describe("Template ID"),
      name: z.string().optional().describe("Template name"),
      description: z.string().optional().describe("Template description"),
      criteria: z.array(z.string()).optional().describe("Evaluation criteria"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const result = await updatePerformanceTemplate(id, data, user.employeeId || user.userId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_performance_template_update")
  );

  server.tool(
    "hr_performance_template_delete",
    "Delete a performance template",
    { id: z.union([z.number(), z.string()]).describe("Template ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:performance", user.isAdmin);
      const data = await deletePerformanceTemplate(id, user.employeeId || user.userId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_template_delete")
  );

  // ── PerformanceMetric ─────────────────────────────────────────────────
  server.tool(
    "hr_performance_metric_list",
    "List performance metrics with optional search",
    {
      q: z.string().optional().describe("Search by metric name"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await listMetrics({ tenantId: user.tenantId, search: args.q, page: args.page, limit: args.limit });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_metric_list")
  );

  server.tool(
    "hr_performance_metric_create",
    "Create a new performance metric",
    {
      name: z.string().min(1).describe("Metric name"),
      description: z.string().optional().describe("Metric description"),
      category: z.string().optional().describe("Metric category"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await createMetric({ ...args, tenantId: user.tenantId, createdById: user.employeeId || user.userId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_metric_create")
  );

  server.tool(
    "hr_performance_metric_deactivate",
    "Deactivate a performance metric",
    { id: z.union([z.number(), z.string()]).describe("Metric ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:performance", user.isAdmin);
      const data = await deactivateMetric({ id, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_performance_metric_deactivate")
  );
}
