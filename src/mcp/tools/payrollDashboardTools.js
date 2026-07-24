// src/mcp/tools/payrollDashboardTools.js — MCP facade for the "Payroll This
// Month" company dashboard. Thin tool wrappers over payrollDashboard.service.js:
// each resolves the verified tenant/user from the request ctx, gates on the
// hr:payroll resource per HTTP method (deny-by-default), and delegates. All
// wrapped in withToolError so failures map to the shared HR-nnnn envelope.
import { z } from "zod";
import {
  getPayrollThisMonth,
  getVarianceVsLastMonth,
  getDeptPayrollCost,
  getBlockingIssues,
  listPayrollEmployees,
  bulkPayslipAction,
  exportPayrollCsv,
} from "../../services/payrollDashboard.service.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const RESOURCE = "hr:payroll";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const jsonResult = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const runIdArg = z
  .coerce.number()
  .int()
  .positive()
  .optional()
  .describe("PayrollRun.id to report on. Omit to use the latest run (max periodEnd) for the tenant.");

export function registerPayrollDashboardTools(server) {
  // ── KPI card ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_this_month",
    "Payroll-This-Month KPI card: net payroll (+MoM %), employee count, processed %, days-until-pay-date, gross/deductions, deduction breakdown, pending approvals.",
    { runId: runIdArg },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getPayrollThisMonth({ tenantId: user.tenantId, runId });
      return jsonResult(data);
    }, "hr_payroll_this_month")
  );

  // ── variance vs last month ──────────────────────────────────────────────────
  server.tool(
    "hr_payroll_variance",
    "Payroll variance vs last month: new hires, exits, increments, and bonuses (count + amount) over the run's period.",
    { runId: runIdArg },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getVarianceVsLastMonth({ tenantId: user.tenantId, runId });
      return jsonResult(data);
    }, "hr_payroll_variance")
  );

  // ── per-department cost ─────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_dept_cost",
    "Per-department payroll cost for the run: net amount + employee count grouped by business unit, sorted desc by amount.",
    { runId: runIdArg },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getDeptPayrollCost({ tenantId: user.tenantId, runId });
      return jsonResult(data);
    }, "hr_payroll_dept_cost")
  );

  // ── blocking issues ─────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_blocking_issues",
    "Payroll-readiness blockers for the run: missing bank details, negative leave balances, pending OT, tax-slab-not-applied, expired salary terms (only buckets with count>0).",
    { runId: runIdArg },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getBlockingIssues({ tenantId: user.tenantId, runId });
      return jsonResult(data);
    }, "hr_payroll_blocking_issues")
  );

  // ── employees table ─────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_employees_list",
    "Paginated Payroll-This-Month employees table (one row per payslip): name/avatar/department, pay grade, basic/allowances/deductions/net, variance %, status.",
    {
      runId: runIdArg,
      q: z.string().optional().describe("Search employees by name (case-insensitive)."),
      department: z
        .coerce.number()
        .int()
        .positive()
        .optional()
        .describe("Filter by department (Employee.businessUnitId)."),
      status: z
        .enum(["pending", "approved", "hold", "disbursed"])
        .optional()
        .describe("Filter by display status (mapped to the PayslipStatus enum)."),
      sortBy: z.enum(["name", "net", "status"]).optional().describe("Sort column (default name)."),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)."),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)."),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page (default 25)."),
    },
    withToolError(async ({ runId, q, department, status, sortBy, sortDir, page, pageSize }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listPayrollEmployees({
        tenantId: user.tenantId,
        runId,
        q,
        department,
        status,
        sortBy,
        sortDir,
        page,
        pageSize,
      });
      return jsonResult(data);
    }, "hr_payroll_employees_list")
  );

  // ── bulk action ─────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_bulk_action",
    "Bulk approve / hold / disburse a set of payslips in one tenant transaction. Returns the number updated.",
    {
      payslipIds: z
        .array(z.coerce.number().int().positive())
        .min(1)
        .describe("PayrollPayslip.id values to act on (required)."),
      action: z
        .enum(["approve", "hold", "disburse"])
        .describe("approve → APPROVED; hold → HOLD; disburse → DISTRIBUTED (required)."),
      reason: z.string().optional().describe("Hold reason (used when action=hold)."),
    },
    withToolError(async ({ payslipIds, action, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await bulkPayslipAction({
        tenantId: user.tenantId,
        payslipIds,
        action,
        reason,
        actorId: user.employeeId,
      });
      return jsonResult(data);
    }, "hr_payroll_bulk_action")
  );

  // ── export ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_export",
    "Export the Payroll-This-Month employees table as a CSV artifact ({format,filename,content}).",
    {
      runId: runIdArg,
      format: z.enum(["csv"]).optional().describe("Export format (default csv)."),
    },
    withToolError(async ({ runId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await exportPayrollCsv({ tenantId: user.tenantId, runId });
      return jsonResult(data);
    }, "hr_payroll_export")
  );
}
