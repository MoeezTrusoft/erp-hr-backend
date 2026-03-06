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

export function registerPayrollTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_payroll_runs_list",
    "hr://payroll/runs",
    { description: "List all payroll runs" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/payroll/runs", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payslips_list",
    "hr://payroll/payslips",
    { description: "List all payslips" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/payroll/payslips", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_earning_types",
    "hr://payroll/earning-types",
    { description: "List all earning types" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/payroll/earning-types", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_deduction_types",
    "hr://payroll/deduction-types",
    { description: "List all deduction types" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/payroll/deduction-types", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_audit_logs",
    "hr://payroll/audit-logs",
    { description: "List payroll audit logs" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/payroll/audit-logs", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_payroll_run_create",
    "Create a new payroll run",
    {
      period: z.string().describe("Payroll period (e.g. 2024-01)"),
      payGroupId: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/payroll/runs", user.isAdmin);
      const data = await self("POST", "/api/payroll/runs", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_process",
    "Process a payroll run (calculate earnings/deductions)",
    { id: z.string().min(1).describe("Payroll run ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/payroll/runs/${id}/process`, user.isAdmin);
      const data = await self("PUT", `/api/payroll/runs/${id}/process`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_finalize",
    "Finalize a processed payroll run",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/payroll/runs/${id}/finalize`, user.isAdmin);
      const data = await self("PUT", `/api/payroll/runs/${id}/finalize`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_delete",
    "Cancel/delete a payroll run",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/payroll/runs/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/payroll/runs/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payslip_distribute",
    "Distribute a payslip to the employee",
    { id: z.string().min(1).describe("Payslip ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/payroll/payslips/${id}/distribute`, user.isAdmin);
      const data = await self("POST", `/api/payroll/payslips/${id}/distribute`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_employment_terms_create",
    "Create employment terms (salary, benefits) for an employee",
    {
      employeeId: z.string().min(1),
      baseSalary: z.number().positive(),
      currency: z.string().default("USD"),
      effectiveDate: z.string().describe("ISO 8601 date"),
      payFrequency: z.enum(["MONTHLY", "BI_WEEKLY", "WEEKLY"]).optional(),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/payroll/employees/${employeeId}/employment-terms`, user.isAdmin);
      const data = await self("POST", `/api/payroll/employees/${employeeId}/employment-terms`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_assignment_create",
    "Assign an employee to a payroll group",
    {
      employeeId: z.string().min(1),
      payGroupId: z.string().min(1),
      effectiveDate: z.string().describe("ISO 8601 date"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/payroll/employees/${employeeId}/payroll-assignments`, user.isAdmin);
      const data = await self("POST", `/api/payroll/employees/${employeeId}/payroll-assignments`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_earning_type_create",
    "Create a new earning type",
    {
      name: z.string().min(1),
      code: z.string().min(1),
      taxable: z.boolean().optional(),
      description: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/payroll/earning-types", user.isAdmin);
      const data = await self("POST", "/api/payroll/earning-types", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_deduction_type_create",
    "Create a new deduction type",
    {
      name: z.string().min(1),
      code: z.string().min(1),
      preTax: z.boolean().optional(),
      description: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/payroll/deduction-types", user.isAdmin);
      const data = await self("POST", "/api/payroll/deduction-types", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
