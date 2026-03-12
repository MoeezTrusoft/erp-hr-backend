import { z } from "zod";
import {
  mcpCancelPayrollRun,
  mcpCreateDeductionType,
  mcpCreateEarningType,
  mcpCreateEmploymentTerms,
  mcpCreatePayrollAssignment,
  mcpCreatePayrollRun,
  mcpDistributePayslip,
  mcpFinalizePayrollRun,
  mcpListDeductionTypes,
  mcpListEarningTypes,
  mcpListPayrollAuditLogs,
  mcpListPayrollRuns,
  mcpListPayslips,
  mcpProcessPayrollRun,
} from "../controllers/payrollMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

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
      const data = await mcpListPayrollRuns(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payslips_list",
    "hr://payroll/payslips",
    { description: "List all payslips" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListPayslips(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_earning_types",
    "hr://payroll/earning-types",
    { description: "List all earning types" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListEarningTypes(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_deduction_types",
    "hr://payroll/deduction-types",
    { description: "List all deduction types" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListDeductionTypes(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_payroll_audit_logs",
    "hr://payroll/audit-logs",
    { description: "List payroll audit logs" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListPayrollAuditLogs(user);
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
      const data = await mcpCreatePayrollRun(user, args);
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
      const data = await mcpProcessPayrollRun(user, id);
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
      const data = await mcpFinalizePayrollRun(user, id);
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
      const data = await mcpCancelPayrollRun(user, id);
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
      const data = await mcpDistributePayslip(user, id);
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
      const data = await mcpCreateEmploymentTerms(user, employeeId, rest);
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
      const data = await mcpCreatePayrollAssignment(user, employeeId, rest);
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
      const data = await mcpCreateEarningType(user, args);
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
      const data = await mcpCreateDeductionType(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
