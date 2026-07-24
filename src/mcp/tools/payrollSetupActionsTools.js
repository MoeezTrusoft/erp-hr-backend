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
    {},
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
    {},
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
    {},
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
    {},
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
}
