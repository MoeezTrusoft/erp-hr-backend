// src/mcp/tools/myPayslipTools.js — My Payslip (employee self-service) MCP tools.
//
// The employee views their OWN payslip, so every tool self-scopes to the acting
// employee: `employeeId` defaults to the ctx `user.employeeId` and is only
// overridable by an explicit arg (the FE never sends one for self-service; the
// arg exists for admin/support flows that still pass the hr:payroll gate). A
// tool 400s when neither an explicit employeeId nor a ctx employeeId is present.
//
// AUTHZ: all tools gate on the hr:payroll resourceKey per HTTP method
// (GET→VIEW, POST→CREATE) via assertPermission — the same gate as the payroll
// admin surface. TENANCY is threaded from ctx.user.tenantId into the service,
// which folds it through scopedWhere (fail-closed) + FORCE-RLS.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getMyPayslip,
  getPayslipDistribution,
  getEarningTrend6mo,
  listMyPayslips,
  questionPayslip,
} from "../../services/myPayslip.service.js";

const RESOURCE_KEY = "hr:payroll";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Resolve the self-scoped employeeId: explicit arg wins, else ctx.user.employeeId.
// 400 when neither is present.
function resolveEmployeeId(user, explicit) {
  const raw = explicit ?? user?.employeeId;
  if (raw == null || raw === "") {
    throw Object.assign(new Error("employeeId is required (no employee bound to the session)"), {
      status: 400,
      code: "HR-4000",
    });
  }
  return raw;
}

export function registerMyPayslipTools(server) {
  server.tool(
    "hr_my_payslip",
    "Get the employee's own payslip (explicit payslipId, else the latest) with YTD, working-day, leave and overtime detail",
    {
      payslipId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("PayrollPayslip.id to view; omit to get the LATEST payslip by payroll period end"),
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee.id to view (self-service defaults to the acting employee; overridable only under the hr:payroll gate)"),
    },
    withToolError(async ({ payslipId, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const empId = resolveEmployeeId(user, employeeId);
      const data = await getMyPayslip({ tenantId: user.tenantId, employeeId: empId, payslipId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_my_payslip")
  );

  server.tool(
    "hr_my_payslip_distribution",
    "Get the earnings/deductions pie split for the employee's payslip (pct of gross / total deductions)",
    {
      payslipId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("PayrollPayslip.id to split; omit to use the LATEST payslip by payroll period end"),
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee.id to view (self-service defaults to the acting employee)"),
    },
    withToolError(async ({ payslipId, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const empId = resolveEmployeeId(user, employeeId);
      const data = await getPayslipDistribution({ tenantId: user.tenantId, employeeId: empId, payslipId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_my_payslip_distribution")
  );

  server.tool(
    "hr_my_earning_trend",
    "Get the employee's net-pay trend for the last 6 months (0-filled for months with no payslip)",
    {
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee.id to trend (self-service defaults to the acting employee)"),
    },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const empId = resolveEmployeeId(user, employeeId);
      const data = await getEarningTrend6mo({ tenantId: user.tenantId, employeeId: empId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_my_earning_trend")
  );

  server.tool(
    "hr_my_payslips_list",
    "List the employee's past payslips (paginated, newest first)",
    {
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee.id to list (self-service defaults to the acting employee)"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20)"),
    },
    withToolError(async ({ employeeId, page, pageSize }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const empId = resolveEmployeeId(user, employeeId);
      const data = await listMyPayslips({ tenantId: user.tenantId, employeeId: empId, page, pageSize });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_my_payslips_list")
  );

  server.tool(
    "hr_payslip_question_create",
    "Raise a question against the employee's own payslip (creates an OPEN PayslipQuestion and emits a domain event)",
    {
      payslipId: z.coerce
        .number()
        .int()
        .positive()
        .describe("PayrollPayslip.id the question is about (must belong to the acting employee)"),
      question: z.string().min(1).describe("The employee's question about the payslip"),
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee.id raising the question (self-service defaults to the acting employee)"),
    },
    withToolError(async ({ payslipId, question, employeeId }) => {
      const { user, permissions, correlationId } = getCtx();
      assertPermission(permissions, "POST", RESOURCE_KEY, user.isAdmin);
      const empId = resolveEmployeeId(user, employeeId);
      const ctx = { actorId: user.userId ?? user.employeeId, correlationId };
      const data = await questionPayslip({
        tenantId: user.tenantId,
        employeeId: empId,
        payslipId,
        question,
        ctx,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payslip_question_create")
  );
}
