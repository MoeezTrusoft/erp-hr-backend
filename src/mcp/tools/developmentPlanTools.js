// src/mcp/tools/developmentPlanTools.js — Development Plan + Payslip Question tools.
//
// DevPlan: LIST + GET + UPDATE + DELETE (CREATE exists). PayslipQuestion: LIST + GET + UPDATE + DELETE (CREATE exists).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { createPlan, listPlans, addPlanItem, listPlanItems, updatePlanItem } from "../../services/developmentPlan.service.js";
import prisma from "../../lib/prisma.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerDevelopmentPlanTools(server) {
  server.tool(
    "hr_development_plan_create",
    "Create a new development plan for an employee",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      title: z.string().min(1).describe("Plan title"),
      description: z.string().optional().describe("Plan description"),
      startDate: z.string().optional().describe("Start date (ISO 8601)"),
      endDate: z.string().optional().describe("End date (ISO 8601)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const result = await createPlan({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_development_plan_create")
  );

  server.tool(
    "hr_development_plan_list",
    "List development plans, optionally filtered by employee",
    {
      employeeId: z.union([z.number(), z.string()]).optional().describe("Filter by employee ID"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await listPlans({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_development_plan_list")
  );

  server.tool(
    "hr_development_plan_get",
    "Get a development plan by ID with its items",
    { id: z.union([z.number(), z.string()]).describe("Plan ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await prisma.developmentPlan.findUnique({
        where: { id: Number(id) },
        include: { items: true },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_development_plan_get")
  );

  server.tool(
    "hr_development_plan_update",
    "Update a development plan",
    {
      id: z.union([z.number(), z.string()]).describe("Plan ID"),
      title: z.string().optional().describe("Plan title"),
      description: z.string().optional().describe("Plan description"),
      status: z.string().optional().describe("Plan status"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const result = await prisma.developmentPlan.update({ where: { id: Number(id) }, data });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_development_plan_update")
  );

  server.tool(
    "hr_development_plan_delete",
    "Delete a development plan",
    { id: z.union([z.number(), z.string()]).describe("Plan ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:performance", user.isAdmin);
      await prisma.developmentPlan.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_development_plan_delete")
  );

  server.tool(
    "hr_development_plan_item_list",
    "List items for a development plan",
    { planId: z.union([z.number(), z.string()]).describe("Plan ID") },
    withToolError(async ({ planId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await listPlanItems(planId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_development_plan_item_list")
  );

  server.tool(
    "hr_development_plan_item_update",
    "Update a development plan item",
    {
      id: z.union([z.number(), z.string()]).describe("Item ID"),
      title: z.string().optional().describe("Item title"),
      description: z.string().optional().describe("Item description"),
      status: z.string().optional().describe("Item status"),
      targetDate: z.string().optional().describe("Target date (ISO 8601)"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const result = await updatePlanItem(id, data, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_development_plan_item_update")
  );

  server.tool(
    "hr_development_plan_item_create",
    "Add a new item to a development plan",
    {
      planId: z.union([z.number(), z.string()]).describe("Plan ID"),
      title: z.string().min(1).describe("Item title"),
      description: z.string().optional().describe("Item description"),
      targetDate: z.string().optional().describe("Target date (ISO 8601)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const result = await addPlanItem({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_development_plan_item_create")
  );

  // ── Payslip Question ──────────────────────────────────────────────────
  server.tool(
    "hr_payslip_question_list",
    "List payslip questions, optionally filtered by payslip",
    {
      payslipId: z.union([z.number(), z.string()]).optional().describe("Filter by payslip ID"),
    },
    withToolError(async ({ payslipId } = {}) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const where = payslipId ? { payslipId: Number(payslipId) } : {};
      const data = await prisma.payslipQuestion.findMany({ where, orderBy: { createdAt: "desc" } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payslip_question_list")
  );

  server.tool(
    "hr_payslip_question_get",
    "Get a payslip question by ID",
    { id: z.union([z.number(), z.string()]).describe("Question ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await prisma.payslipQuestion.findUnique({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payslip_question_get")
  );

  server.tool(
    "hr_payslip_question_update",
    "Update a payslip question response",
    {
      id: z.union([z.number(), z.string()]).describe("Question ID"),
      answer: z.string().optional().describe("Answer text"),
      status: z.string().optional().describe("Question status"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      const result = await prisma.payslipQuestion.update({ where: { id: Number(id) }, data });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_payslip_question_update")
  );

  server.tool(
    "hr_payslip_question_delete",
    "Delete a payslip question",
    { id: z.union([z.number(), z.string()]).describe("Question ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:payroll", user.isAdmin);
      await prisma.payslipQuestion.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_payslip_question_delete")
  );
}
