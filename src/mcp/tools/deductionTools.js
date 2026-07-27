// src/mcp/tools/deductionTools.js — Deductions screen MCP facade
//
// Three tools powering the Deductions screen:
//   hr_deduction_kpi   — KPI summary (active components, active loans, tax withheld, garnishments)
//   hr_deduction_get   — Single component by ID
//   hr_deduction_list  — Table rows (code, component, type, formula, frequency, status)
//
// SalaryComponent is a config model (no employee relation). Employee-level
// deductions live in PayrollAssignment (via deductionTypeId).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const DEDUCTIONS_KEY = "hr:payroll";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerDeductionTools(server) {
  // ── KPI ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_kpi",
    "Get Deductions KPI summary (Active Components, Active Loans, Tax Withheld, Garnishments)",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", DEDUCTIONS_KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tenantId = user.tenantId;
      const tFilter = tenantId ? { tenantId } : {};

      const [activeComponents, activeLoans, taxWithheld, garnishments] =
        await Promise.all([
          prisma.salaryComponent.count({
            where: { ...tFilter, type: "DEDUCTION", active: true },
          }),
          prisma.loan.count({
            where: { ...tFilter, status: "ACTIVE" },
          }),
          prisma.payrollDeduction.aggregate({
            where: {
              ...tFilter,
              deductionType: { name: { contains: "tax", mode: "insensitive" } },
            },
            _sum: { amount: true },
          }),
          prisma.payrollDeduction.aggregate({
            where: {
              ...tFilter,
              deductionType: { name: { contains: "garnish", mode: "insensitive" } },
            },
            _sum: { amount: true },
          }),
        ]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            activeComponents,
            activeLoans,
            taxWithheld: Number(taxWithheld._sum.amount || 0),
            garnishments: Number(garnishments._sum.amount || 0),
          }),
        }],
      };
    }, "hr_deduction_kpi")
  );

  // ── GET ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_get",
    "Get a single deduction component by ID with full details",
    { id: z.string().min(1).describe("Salary component ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", DEDUCTIONS_KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tenantId = user.tenantId;
      const tFilter = tenantId ? { tenantId } : {};

      const component = await prisma.salaryComponent.findFirst({
        where: { id: Number(id), ...tFilter },
      });

      if (!component) throw Object.assign(new Error("Deduction component not found"), { status: 404 });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: component.id,
            code: component.code,
            name: component.name,
            type: component.type,
            computation: component.computation,
            formula: component.formula,
            value: component.value,
            taxable: component.taxable,
            active: component.active,
            sortOrder: component.sortOrder,
            status: component.status,
            createdAt: component.createdAt,
            updatedAt: component.updatedAt,
          }),
        }],
      };
    }, "hr_deduction_get")
  );

  // ── LIST ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_list",
    "List deduction components with code, component, type, formula, and status",
    {
      page: z.coerce.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20, max 100)"),
      type: z.enum(["DEDUCTION"]).optional().describe("Filter by component type (default DEDUCTION)"),
      active: z.boolean().optional().describe("Filter by active status"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", DEDUCTIONS_KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tenantId = user.tenantId;
      const tFilter = tenantId ? { tenantId } : {};

      const page = args.page || 1;
      const pageSize = Math.min(args.pageSize || 20, 100);
      const skip = (page - 1) * pageSize;

      const where = {
        ...tFilter,
        type: args.type || "DEDUCTION",
        ...(args.active !== undefined ? { active: args.active } : {}),
      };

      const [components, total] = await Promise.all([
        prisma.salaryComponent.findMany({
          where,
          orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
          skip,
          take: pageSize,
        }),
        prisma.salaryComponent.count({ where }),
      ]);

      const rows = components.map((c) => ({
        id: c.id,
        code: c.code,
        component: c.name,
        type: c.type,
        computation: c.computation,
        formula: c.computation === "FORMULA"
          ? c.formula
          : c.computation === "PERCENTAGE"
            ? `${c.value}%`
            : c.value != null
              ? String(c.value)
              : null,
        taxable: c.taxable,
        active: c.active,
        status: c.status,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          }),
        }],
      };
    }, "hr_deduction_list")
  );
}
