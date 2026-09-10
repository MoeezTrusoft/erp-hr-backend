// src/mcp/tools/payrollSetupActionsTools.js
//
// Payroll Setup → Pay Rules + Global KPIs + Actions (Publish / Export). MCP
// facade over payrollRuleConfig.service + payrollConfigActions.service. Every
// tool is gated on hr:payroll (same C4 payroll resourceKey as the rest of the
// payroll surface) and tenant-scoped via the ctx user (never a spoofable
// header).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getPayrollRules,
  updatePayrollRules,
} from "../../services/payrollRuleConfig.service.js";
import {
  getGlobalKpis,
  getConfigStatus,
  publishConfig,
  exportConfig,
} from "../../services/payrollConfigActions.service.js";
import { seedConfigFromTenant } from "../../services/payrollConfigSeed.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerPayrollSetupActionsTools(server) {
  // ── PAY RULES ──────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_rules_get",
    "Get the tenant's payroll Pay Rules (policy toggles + garnishment cap)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await getPayrollRules({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rules_get")
  );

  server.tool(
    "hr_payroll_rules_update",
    "Update the tenant's payroll Pay Rules (returns config to DRAFT)",
    {
      midMonthJoinerProration: z
        .boolean()
        .optional()
        .describe("Pro-rate a mid-month joiner's pay by calendar days from join date (PayrollRuleConfig.midMonthJoinerProration)"),
      midMonthExitSettlement: z
        .boolean()
        .optional()
        .describe("Run final settlement + gratuity + leave encashment on mid-month exit (PayrollRuleConfig.midMonthExitSettlement)"),
      lwpRecovery: z
        .boolean()
        .optional()
        .describe("Recover leave-without-pay: monthly basic / working days * LWP days (PayrollRuleConfig.lwpRecovery)"),
      complianceHold: z
        .boolean()
        .optional()
        .describe("Block disbursement on unfiled EOBI/PSSF compliance (PayrollRuleConfig.complianceHold)"),
      garnishmentRecovery: z
        .boolean()
        .optional()
        .describe("Enable loan/garnishment recovery from pay (PayrollRuleConfig.garnishmentRecovery)"),
      garnishmentCapPct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Garnishment recovery cap as a percent of net pay, 0-100 (PayrollRuleConfig.garnishmentCapPct)"),
      offCycleRelease: z
        .boolean()
        .optional()
        .describe("Allow single-employee off-cycle disbursement (PayrollRuleConfig.offCycleRelease)"),
      // HR-PAYROLL-DEDUCTION-BASIS-01 — what a deducted day is charged against.
      deductionBasis: z
        .enum(["BASIC", "GROSS"])
        .optional()
        .describe("Basis for deducted-day pricing (LWP + ABSENCE_RECOVERY): BASIC or GROSS (PayrollRuleConfig.deductionBasis)"),
      // HR-PAYROLL-EOBI-01 — statutory switches (off until deliberately enabled).
      eobiEnabled: z
        .boolean()
        .optional()
        .describe("Enable EOBI employee contribution (PayrollRuleConfig.eobiEnabled)"),
      eobiEmployeeRatePct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("EOBI employee rate percent 0-100 (PayrollRuleConfig.eobiEmployeeRatePct)"),
      eobiWageCeilingMinor: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("EOBI wage ceiling in minor units (PayrollRuleConfig.eobiWageCeilingMinor)"),
      // N-01 / T-0.3 — absence pricing (Decision 3 signed fleet-wide 2026-09-09).
      absenceRecoveryEnabled: z
        .boolean()
        .optional()
        .describe("Price unexcused absence/half-day day-credit loss as one ABSENCE_RECOVERY line (PayrollRuleConfig.absenceRecoveryEnabled)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:payroll", user.isAdmin);
      const data = await updatePayrollRules({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rules_update")
  );

  // ── GLOBAL KPIs ─────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_global_kpis",
    "Get payroll-setup global KPIs (active employees, pay components, approval levels)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await getGlobalKpis({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_global_kpis")
  );

  // ── CONFIG STATUS ───────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_config_status",
    "Get the payroll config draft/publish status (status, versions, unpublished flag)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await getConfigStatus({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_config_status")
  );

  // ── PUBLISH ─────────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_config_publish",
    "Publish the payroll config: snapshot + flip DRAFT rows to PUBLISHED + bump meta",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await publishConfig({
        tenantId: user.tenantId,
        publishedById: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_config_publish")
  );

  // ── EXPORT ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_payroll_config_export",
    "Export the payroll config: a specific published version, else the latest, else live",
    {
      version: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Published snapshot version to export (PayrollConfigSnapshot.version); omit for the latest published, or the live config if none published"),
    },
    withToolError(async ({ version }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:payroll", user.isAdmin);
      const data = await exportConfig({ tenantId: user.tenantId, version });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_config_export")
  );

  // ── SEED FROM TENANT (T-2.8 / Decision 5) ─────────────────────────────────
  // Onboarding-only template: copies a source tenant's rule config (as DRAFT),
  // deduction rules, and type catalogs into an EMPTY target. Publish stays the
  // gate. Never touches calendars or snapshots; refuses targets with payroll
  // history. Deliberately cross-tenant (admin-gated) — see the service header.
  server.tool(
    "hr_payroll_config_seed_from_tenant",
    "Seed an empty tenant's payroll config from another tenant (rule config as DRAFT + deduction rules + earning/deduction type catalogs). Onboarding-only: refuses a target with payslips/runs; never copies calendars or snapshots.",
    {
      sourceTenantId: z
        .string()
        .uuid()
        .describe("Source tenant (RBAC Company.uuid) whose ruleset is copied"),
      targetTenantId: z
        .string()
        .uuid()
        .describe("Target tenant (RBAC Company.uuid) — must have no payroll history"),
    },
    withToolError(async ({ sourceTenantId, targetTenantId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
      const data = await seedConfigFromTenant({
        actorTenantId: user.tenantId,
        actorIsAdmin: user.isAdmin === true,
        sourceTenantId,
        targetTenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_config_seed_from_tenant")
  );
}
