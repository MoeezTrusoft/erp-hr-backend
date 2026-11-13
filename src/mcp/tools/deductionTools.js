// src/mcp/tools/deductionTools.js — Deductions screen MCP facade (CRUD)
//
// Tools:
//   hr_deduction_kpi   — KPI summary
//   hr_deduction_list  — Table rows
//   hr_deduction_get   — Single component by ID
//   hr_deduction_create — Create a new deduction component
//   hr_deduction_update — Update a deduction component
//   hr_deduction_delete — Delete a deduction component
import { z } from "zod";
import logger from "../../lib/logger.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const KEY = "hr:payroll";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerDeductionTools(server) {
  // ── KPI ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_kpi",
    "Get Deductions KPI summary (Active Components, Active Loans)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};
      const dedFilter = { ...tFilter, type: "DEDUCTION" };

      let activeComponents = 0;
      let totalComponents = 0;
      let activeLoans = 0;
      try {
        activeComponents = await prisma.salaryComponent.count({ where: { ...dedFilter, active: true } });
        totalComponents = await prisma.salaryComponent.count({ where: dedFilter });
      } catch (err) {
        logger.error({ err, tenantId: user.tenantId }, "salaryComponent count failed");
      }
      try {
        // HR-PAYROLL-ADVANCE-01 — this tile says "Active Loans"; a salary advance
        // is a different instrument and is counted on the loan KPI separately.
        activeLoans = await prisma.loan.count({ where: { ...tFilter, kind: "LOAN", status: "ACTIVE" } });
      } catch (err) {
        logger.error({ err, tenantId: user.tenantId }, "loan count failed");
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ activeComponents, totalComponents, activeLoans }) }],
      };
    }, "hr_deduction_kpi")
  );

  // ── GET ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_get",
    "Get a single deduction component by ID",
    { id: z.string().min(1).describe("Salary component ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};

      const c = await prisma.salaryComponent.findFirst({ where: { id: Number(id), ...tFilter } });
      if (!c) throw Object.assign(new Error("Deduction component not found"), { status: 404 });

      return {
        content: [{ type: "text", text: JSON.stringify({
          id: c.id, code: c.code, name: c.name, type: c.type,
          computation: c.computation, formula: c.formula, value: c.value,
          taxable: c.taxable, active: c.active, sortOrder: c.sortOrder,
          status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt,
        }) }],
      };
    }, "hr_deduction_get")
  );

  // ── LIST ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_list",
    "List deduction components with code, type, formula, and status",
    {
      page: z.coerce.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20, max 100)"),
      active: z.boolean().optional().describe("Filter by active status"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};
      const page = args.page || 1;
      const pageSize = Math.min(args.pageSize || 20, 100);

      const where = { ...tFilter, type: "DEDUCTION", ...(args.active !== undefined ? { active: args.active } : {}) };
      const [items, total] = await Promise.all([
        prisma.salaryComponent.findMany({ where, orderBy: [{ sortOrder: "asc" }, { code: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.salaryComponent.count({ where }),
      ]);

      return {
        content: [{ type: "text", text: JSON.stringify({
          items: items.map((c) => ({
            id: c.id, code: c.code, component: c.name, type: c.type,
            computation: c.computation,
            formula: c.computation === "FORMULA" ? c.formula : c.computation === "PERCENTAGE" ? `${c.value}%` : c.value != null ? String(c.value) : null,
            taxable: c.taxable, active: c.active, status: c.status,
          })),
          total, page, pageSize, totalPages: Math.ceil(total / pageSize),
        }) }],
      };
    }, "hr_deduction_list")
  );

  // ── CREATE ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_create",
    "Create a new deduction salary component",
    {
      code: z.string().min(1).max(50).describe("Unique code (e.g. TAX-FED)"),
      name: z.string().min(1).describe("Display name"),
      computation: z.enum(["FIXED", "PERCENTAGE", "FORMULA"]).optional().describe("Default FIXED"),
      value: z.number().optional().describe("Fixed amount or percentage (0-100)"),
      formula: z.string().optional().describe("Formula expression (when computation=FORMULA)"),
      taxable: z.boolean().optional().describe("Is this deduction taxable (default true)"),
      sortOrder: z.number().int().optional().describe("Sort order (default 0)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};

      const existing = await prisma.salaryComponent.findFirst({ where: { ...tFilter, code: args.code } });
      if (existing) throw Object.assign(new Error(`Code '${args.code}' already exists`), { status: 409 });

      const c = await prisma.salaryComponent.create({
        data: {
          ...tFilter,
          code: args.code,
          name: args.name,
          type: "DEDUCTION",
          computation: args.computation || "FIXED",
          value: args.value,
          formula: args.formula,
          taxable: args.taxable ?? true,
          sortOrder: args.sortOrder ?? 0,
          status: "DRAFT",
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, id: c.id, code: c.code, name: c.name }) }],
      };
    }, "hr_deduction_create")
  );

  // ── UPDATE ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_update",
    "Update an existing deduction salary component",
    {
      id: z.string().min(1).describe("Salary component ID"),
      name: z.string().optional().describe("Display name"),
      computation: z.enum(["FIXED", "PERCENTAGE", "FORMULA"]).optional(),
      value: z.number().nullable().optional(),
      formula: z.string().nullable().optional(),
      taxable: z.boolean().optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};

      const existing = await prisma.salaryComponent.findFirst({ where: { id: Number(args.id), ...tFilter } });
      if (!existing) throw Object.assign(new Error("Deduction component not found"), { status: 404 });

      const data = {};
      if (args.name !== undefined) data.name = args.name;
      if (args.computation !== undefined) data.computation = args.computation;
      if (args.value !== undefined) data.value = args.value;
      if (args.formula !== undefined) data.formula = args.formula;
      if (args.taxable !== undefined) data.taxable = args.taxable;
      if (args.active !== undefined) data.active = args.active;
      if (args.sortOrder !== undefined) data.sortOrder = args.sortOrder;

      const c = await prisma.salaryComponent.update({ where: { id: existing.id }, data });

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, id: c.id, code: c.code, name: c.name }) }],
      };
    }, "hr_deduction_update")
  );

  // ── DELETE ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_deduction_delete",
    "Delete a deduction salary component",
    { id: z.string().min(1).describe("Salary component ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", KEY, user.isAdmin);

      const { default: prisma } = await import("../../lib/prisma.js");
      const tFilter = user.tenantId ? { tenantId: user.tenantId } : {};

      const existing = await prisma.salaryComponent.findFirst({ where: { id: Number(id), ...tFilter } });
      if (!existing) throw Object.assign(new Error("Deduction component not found"), { status: 404 });

      await prisma.salaryComponent.delete({ where: { id: existing.id } });

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, deleted: existing.id }) }],
      };
    }, "hr_deduction_delete")
  );
}
