// src/mcp/tools/deductionTools.js — Deductions screen MCP facade
//
// Two tools powering the Deductions screen:
//   hr_deduction_kpi   — KPI summary (active components, active loans, tax withheld, garnishments)
//   hr_deduction_list  — Table rows (code, component, type, formula, frequency, employee, status)
//
// Follows the benefitTools.js / loanTools.js pattern: thin MCP wrappers that
// query Prisma directly (lighter than a full service for read-only aggregates).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const DEDUCTIONS_KEY = "hr:deductions";

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

      const now = new Date();

      const [activeComponents, activeLoans, taxWithheld, garnishments] =
        await Promise.all([
          // Active deduction salary components
          prisma.salaryComponent.count({
            where: { ...tFilter, type: "DEDUCTION", active: true },
          }),
          // Active loans (outstanding balance > 0)
          prisma.loan.count({
            where: { ...tFilter, status: "ACTIVE" },
          }),
          // Tax withheld: sum of payslip deductions whose type name contains "tax"
          prisma.payrollDeduction.aggregate({
            where: {
              ...tFilter,
              deductionType: { name: { contains: "tax", mode: "insensitive" } },
            },
            _sum: { amount: true },
          }),
          // Garnishments: sum of payslip deductions whose type name contains "garnish"
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

  // ── LIST ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_list",
    "List deduction components with code, component, type, formula, frequency, employee, and status",
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
          include: {
            assignments: {
              include: {
                employee: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    email: true,
                    employmentTerms: {
                      orderBy: { effectiveFrom: "desc" },
                      take: 1,
                      select: { payFrequency: true },
                    },
                  },
                },
              },
            },
          },
          orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
          skip,
          take: pageSize,
        }),
        prisma.salaryComponent.count({ where }),
      ]);

      // Flatten: each assignment becomes a row; components with no assignments
      // still show once (with null employee).
      const rows = [];
      for (const component of components) {
        if (component.assignments.length === 0) {
          rows.push({
            code: component.code,
            component: component.name,
            type: component.type,
            formula: component.computation === "FORMULA"
              ? component.formula
              : component.computation === "PERCENTAGE"
                ? `${component.value}%`
                : component.value != null
                  ? String(component.value)
                  : null,
            frequency: null,
            employee: null,
            employeeId: null,
            status: component.active ? "ACTIVE" : "INACTIVE",
          });
        } else {
          for (const a of component.assignments) {
            rows.push({
              code: component.code,
              component: component.name,
              type: component.type,
              formula: component.computation === "FORMULA"
                ? component.formula
                : component.computation === "PERCENTAGE"
                  ? `${component.value}%`
                  : a.amount != null
                    ? String(a.amount)
                    : component.value != null
                      ? String(component.value)
                      : null,
              frequency: a.employee?.employmentTerms?.[0]?.payFrequency || null,
              employee: a.employee
                ? `${a.employee.first_name || ""} ${a.employee.last_name || ""}`.trim()
                : null,
              employeeId: a.employeeId,
              status: a.isActive ? "ACTIVE" : "INACTIVE",
            });
          }
        }
      }

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
