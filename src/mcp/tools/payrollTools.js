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
  mcpExportBankDisbursementFile,
} from "../controllers/payrollMcpController.js";
import {
  mcpListYearEndTaxForms,
  mcpExportYearEndTaxForms,
} from "../controllers/taxFormMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { runMcpIdempotent } from "../../middlewares/idempotency.middleware.js";
import { toListEnvelope, toListQuery } from "../utils/listEnvelope.js";

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

  // IC-1: the HR FE binds the Payslips LIST screen to the `hr_payslips_list`
  // TOOL (tools/call). A same-named RESOURCE exists but callTool could not
  // resolve it, so the screen fell back to mock data. This TOOL wraps the
  // existing payslips list service, tenant-scoped via ctx, and returns the
  // FE-expected paginated envelope. Gated on hr:payroll:VIEW (deny-by-default).
  server.tool(
    "hr_payslips_list",
    "List payslips (paginated) for the HR payroll screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      payrollRunId: z.union([z.string(), z.number()]).optional(),
      employeeId: z.union([z.string(), z.number()]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await mcpListPayslips(user, toListQuery(args));
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_payslips_list")
  );

  server.tool(
    "hr_payroll_run_create",
    "Create a new payroll run",
    {
      periodStart: z.string().describe("Payroll period start — ISO 8601 date YYYY-MM-DD (PayrollRun.periodStart)"),
      periodEnd: z.string().describe("Payroll period end — ISO 8601 date YYYY-MM-DD (PayrollRun.periodEnd)"),
      countryCode: z.string().length(2).describe("ISO 3166-1 alpha-2 country code (2 letters, e.g. US, PK) — PayrollRun.countryCode"),
      currencyCode: z.string().length(3).describe("ISO 4217 currency code (3 letters, e.g. USD, PKR) — PayrollRun.currencyCode"),
      // API-3: optional idempotency key. Retrying a payroll-run create with the
      // same key replays the first run instead of creating a duplicate run.
      idempotencyKey: z.string().optional().describe("Optional idempotency key. Repeat the same value to safely retry this payroll run create without producing a duplicate."),
    },
    withToolError(async ({ idempotencyKey, ...args }) => {
      const ctx = getCtx();
      const { user, permissions } = ctx;
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const { value: data } = await runMcpIdempotent({
        toolName: "hr_payroll_run_create",
        idempotencyKey,
        ctx,
        run: () => mcpCreatePayrollRun(user, args),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_process",
    "Process a payroll run (calculate earnings/deductions)",
    { id: z.string().min(1).describe("Payroll run ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      const data = await mcpProcessPayrollRun(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_finalize",
    "Finalize a processed payroll run",
    { id: z.string().min(1).describe("Payroll run id (numeric string) — PayrollRun.id to finalize") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      const data = await mcpFinalizePayrollRun(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_run_delete",
    "Cancel/delete a payroll run",
    { id: z.string().min(1).describe("Payroll run id (numeric string) — PayrollRun.id to cancel/delete") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:payroll", user.isAdmin);
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
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await mcpDistributePayslip(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_employment_terms_create",
    "Create employment terms (salary, benefits) for an employee",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string) — Employee.id the terms belong to"),
      baseSalary: z.number().positive().describe("Base salary in major units (C4-encrypted at rest) — EmploymentTerms.baseSalary"),
      currency: z.string().default("USD").describe("ISO 4217 currency code (default USD) — EmploymentTerms.currency"),
      effectiveFrom: z.string().describe("Effective-from date — ISO 8601 date YYYY-MM-DD (EmploymentTerms.effectiveFrom)"),
      payFrequency: z.enum(["WEEKLY", "BI_WEEKLY", "SEMI_MONTHLY", "MONTHLY"]).describe("Pay frequency — one of WEEKLY | BI_WEEKLY | SEMI_MONTHLY | MONTHLY (PayFrequency enum)"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await mcpCreateEmploymentTerms(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_assignment_create",
    "Assign a recurring earning/deduction line to an employee",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string) — Employee.id the assignment belongs to"),
      earningTypeId: z.coerce.number().int().positive().optional().describe("PayrollEarningType.id this line pays (mutually exclusive with deductionTypeId)"),
      deductionTypeId: z.coerce.number().int().positive().optional().describe("PayrollDeductionType.id this line deducts (mutually exclusive with earningTypeId)"),
      amount: z.number().optional().describe("Fixed amount in major units (PayrollAssignment.amount)"),
      rate: z.number().optional().describe("Rate/multiplier applied instead of a fixed amount (PayrollAssignment.rate)"),
      effectiveFrom: z.string().describe("Effective-from date — ISO 8601 date YYYY-MM-DD (PayrollAssignment.effectiveFrom)"),
      effectiveTo: z.string().optional().describe("Effective-to date — ISO 8601 date YYYY-MM-DD; open-ended if omitted (PayrollAssignment.effectiveTo)"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await mcpCreatePayrollAssignment(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_earning_type_create",
    "Create a new earning type",
    {
      name: z.string().min(1).describe("Earning type display name — PayrollEarningType.name"),
      code: z.string().min(1).describe("Unique earning code within the tenant — PayrollEarningType.code"),
      isTaxable: z.boolean().optional().describe("Whether this earning is taxable (defaults to true) — PayrollEarningType.isTaxable"),
      description: z.string().optional().describe("Optional description — PayrollEarningType.description"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await mcpCreateEarningType(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_payroll_deduction_type_create",
    "Create a new deduction type",
    {
      name: z.string().min(1).describe("Deduction type display name — PayrollDeductionType.name"),
      code: z.string().min(1).describe("Unique deduction code within the tenant — PayrollDeductionType.code"),
      preTax: z.boolean().optional().describe("Whether the deduction is applied pre-tax (defaults to false) — PayrollDeductionType.preTax (pending migration)"),
      description: z.string().optional().describe("Optional description — PayrollDeductionType.description"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await mcpCreateDeductionType(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── BANK / ACH DISBURSEMENT EXPORT (HR-BANKFILE-03 / HR-PAY-04) ────────────
  server.tool(
    "hr_payroll_bank_file_export",
    "Export the bank/ACH disbursement file for a FINALIZED payroll run",
    {
      id: z.string().min(1).describe("Payroll run ID (must be FINALIZED)"),
      format: z.enum(["nacha", "csv"]).optional().describe("Wire format (default: nacha)"),
    },
    withToolError(async ({ id, format }) => {
      const { user, permissions } = getCtx();
      // Same C4 payroll gate as GET /hr/api/payroll/runs/:id/bank-file.
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await mcpExportBankDisbursementFile(user, id, format ? { format } : {});
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    })
  );

  // ── YEAR-END TAX FORMS — W-2 / 1099-NEC (HR-PAY-07 / HR-SEC-05) ────────────
  server.tool(
    "hr_tax_forms_list",
    "List statutory year-end tax forms (W-2 / 1099-NEC) for a tax year",
    { taxYear: z.string().min(1).describe("Tax year, e.g. 2025") },
    withToolError(async ({ taxYear }) => {
      const { user, permissions } = getCtx();
      // Same C4 payroll gate as GET /hr/api/payroll/tax-forms/:taxYear.
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await mcpListYearEndTaxForms(user, taxYear);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_tax_forms_export",
    "Export year-end tax forms (W-2 / 1099-NEC) for a tax year as a file artifact",
    {
      taxYear: z.string().min(1).describe("Tax year, e.g. 2025"),
      formType: z.enum(["w2", "1099"]).optional().describe("Form type (default: w2)"),
      format: z.enum(["csv"]).optional().describe("Export format (default: csv)"),
    },
    withToolError(async ({ taxYear, formType, format }) => {
      const { user, permissions } = getCtx();
      // Same C4 payroll gate as GET /hr/api/payroll/tax-forms/:taxYear/export.
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const query = {};
      if (formType) query.formType = formType;
      if (format) query.format = format;
      const data = await mcpExportYearEndTaxForms(user, taxYear, query);
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    })
  );
}
