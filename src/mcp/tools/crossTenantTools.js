import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { withToolError } from "../utils/toolError.js";
import prisma from "../../lib/prisma.js";
import logger from "../../lib/logger.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const listAllShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().optional(),
  status: z.string().optional(),
};

export function registerCrossTenantTools(server) {
  server.tool(
    "hr_employees_list_all",
    "List employees across ALL companies (admin only). Returns employees from every tenant with tenantId on each row.",
    listAllShape,
    withToolError(async (args) => {
      const { user } = getCtx();
      if (!user.isAdmin) {
        throw Object.assign(new Error("HR-4031 Only admins can list employees across all companies"), { status: 403 });
      }

      const page = args.page ?? 1;
      const pageSize = args.pageSize ?? 50;
      const skip = (page - 1) * pageSize;

      const where = {};
      if (args.q) {
        where.OR = [
          { employee_name: { contains: args.q, mode: "insensitive" } },
          { employee_code: { contains: args.q, mode: "insensitive" } },
          { work_email: { contains: args.q, mode: "insensitive" } },
        ];
      }
      if (args.status) {
        where.OR = [
          { employement_status: { equals: args.status, mode: "insensitive" } },
          { status: { equals: args.status, mode: "insensitive" } },
        ];
      }

      const [items, total] = await mcpRequestContext.run({ system: true }, async () => {
        const [items, total] = await Promise.all([
          prisma.employee.findMany({
            where,
            select: {
              id: true,
              tenant_id: true,
              employee_name: true,
              employee_code: true,
              job_title: true,
              work_email: true,
              employement_status: true,
              status: true,
              hire_date: true,
              joining_date: true,
            },
            orderBy: { created_at: "desc" },
            skip,
            take: pageSize,
          }),
          prisma.employee.count({ where }),
        ]);
        return [items, total];
      });

      logger.info({ total, page, pageSize, requestedBy: user.userId }, "hr_employees_list_all");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          }),
        }],
      };
    }, "hr_employees_list_all")
  );

  server.tool(
    "hr_payroll_runs_list_all",
    "List payroll runs across ALL companies (admin only). Returns runs from every tenant with tenantId on each row.",
    {
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
      status: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user } = getCtx();
      if (!user.isAdmin) {
        throw Object.assign(new Error("HR-4031 Only admins can list payroll runs across all companies"), { status: 403 });
      }

      const page = args.page ?? 1;
      const pageSize = args.pageSize ?? 50;
      const skip = (page - 1) * pageSize;

      const where = {};
      if (args.status) {
        where.status = { equals: args.status, mode: "insensitive" };
      }

      const [items, total] = await mcpRequestContext.run({ system: true }, async () => {
        const [items, total] = await Promise.all([
          prisma.payrollRun.findMany({
            where,
            select: {
              id: true,
              tenantId: true,
              periodStart: true,
              periodEnd: true,
              status: true,
              employeeCount: true,
              totalGross: true,
              totalNet: true,
              processedBy: true,
              approvedBy: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: pageSize,
          }),
          prisma.payrollRun.count({ where }),
        ]);
        return [items, total];
      });

      logger.info({ total, page, pageSize, requestedBy: user.userId }, "hr_payroll_runs_list_all");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          }),
        }],
      };
    }, "hr_payroll_runs_list_all")
  );
}
