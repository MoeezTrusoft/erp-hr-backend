// src/mcp/tools/myPayslipTools.js — My Payslip (employee self-service) MCP tools.
//
// The employee views their OWN payslip, so every tool self-scopes to the acting
// employee: `employeeId` defaults to the ctx `user.employeeId` and is only
// overridable by an explicit arg (the FE never sends one for self-service; the
// arg exists for admin/support flows that still pass the hr:payroll gate). A
// tool 400s when neither an explicit employeeId nor a ctx employeeId is present.
//
// AUTHZ (HR-RBAC-01, 2026-09-21): the VIEW gate alone no longer unlocks the
// admin-view selector. resolveActorScope classifies the session — only the
// payroll/employee WRITE/EXPORT surface (or a verified admin claim) may pass
// explicit employeeId/payslipId selecting OTHER employees. Employee-scoped
// sessions are pinned to their own rows: a foreign employeeId 403s, a foreign
// payslipId 404s (same generic text as a missing slip — no enumeration).
// The tools still assert the per-method hr:payroll gate first; the scope check
// beneath it is what stops the IDOR (audit C1 / plan T1.2+T1.3).
// TENANCY is threaded from ctx.user.tenantId into the service, which folds it
// through scopedWhere (fail-closed) + FORCE-RLS.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission, hasPermission } from "../utils/assertPermission.js";
import { assertEmployeeScope, resolveActorScope } from "../utils/actorScope.js";
import { withToolError } from "../utils/toolError.js";
import {
  getMyPayslip,
  getPayslipDistribution,
  getEarningTrend6mo,
  listMyPayslips,
  questionPayslip,
} from "../../services/myPayslip.service.js";

const RESOURCE_KEY = "hr:payroll";

// HR-RBAC-01 T1.3c — self-service entitlement for the my-payslip family.
// After the Employee-role grant remediation (D1=A) a plain employee holds
// hr:self VIEW and NO hr:payroll grant, so the old bare
// assertPermission(GET, hr:payroll) locked employees out of their OWN slips.
// A session passes with hr:self read OR any hr:payroll grant; scope narrowing
// (pin to acting employee, refuse foreign ids) is resolveActorScope's job —
// VIEW alone never grants the admin surface (T1.7).
function assertSelfOrPayrollRead(user, permissions) {
  // The verified admin claim rides the service JWT (never a client header) and
  // outranks the blob — same precedence as assertPermission's call sites.
  const ok =
    user?.isAdmin === true ||
    hasPermission(permissions, "hr:self", "VIEW") ||
    hasPermission(permissions, "hr:payroll", "VIEW");
  if (!ok) {
    throw Object.assign(
      new Error("Insufficient permissions: hr:self:VIEW or hr:payroll grant required"),
      { status: 403, code: "HR-4030" },
    );
  }
}

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Resolve the self-scoped employeeId (HR-RBAC-01): employee-scope sessions are
// pinned to the verified claim id — a DIFFERENT explicit employeeId is refused
// (403), not honored. Admin-surface sessions keep the old behavior: explicit
// arg wins; none needed on payslipId-keyed flows (HR-PAYSLIP-ADMIN-VIEW-01,
// the slip row identifies the subject).
function resolveEmployeeId(user, permissions, explicit, { allowUnbound = false } = {}) {
  const { actingEmployeeId, canViewOthers } = resolveActorScope(user, permissions);
  return assertEmployeeScope({ user, permissions, explicit, actingEmployeeId, canViewOthers, allowUnbound });
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
      assertSelfOrPayrollRead(user, permissions);
      const empId = resolveEmployeeId(user, permissions, employeeId, { allowUnbound: payslipId != null });
      const data = await getMyPayslip({
        tenantId: user.tenantId,
        employeeId: empId,
        payslipId,
        // HR-RBAC-01: when the caller is NOT on the admin surface, the explicit
        // payslipId resolves only inside the caller's own slips (service-side
        // where-clause) — the IDOR fix beneath the tool gate.
        employeeScoped: !resolveActorScope(user, permissions).canViewOthers,
      });
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
      assertSelfOrPayrollRead(user, permissions);
      const empId = resolveEmployeeId(user, permissions, employeeId, { allowUnbound: payslipId != null });
      const data = await getPayslipDistribution({
        tenantId: user.tenantId,
        employeeId: empId,
        payslipId,
        employeeScoped: !resolveActorScope(user, permissions).canViewOthers,
      });
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
      assertSelfOrPayrollRead(user, permissions);
      const empId = resolveEmployeeId(user, permissions, employeeId);
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
      assertSelfOrPayrollRead(user, permissions);
      const empId = resolveEmployeeId(user, permissions, employeeId);
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
      const empId = resolveEmployeeId(user, permissions, employeeId, { allowUnbound: true });
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
