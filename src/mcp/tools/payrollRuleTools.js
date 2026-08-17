// src/mcp/tools/payrollRuleTools.js
//
// Payroll Setup → Pay Rules MCP tools: discrete tenant-owned policy rules (an
// array on the screen), distinct from the singleton PayrollRuleConfig toggles
// (hr_payroll_rules_get / hr_payroll_rules_update). Each rule is created from a
// human `title` + `description`; the backend camel-cases the title into a stable
// `ruleKey` (e.g. "Mid Month Joiner Proration" → "midMonthJoinerProration"),
// unique per tenant.
//
// All gated on the C4 payroll resource key `hr:payroll` (deny-by-default) via
// assertPermission, matching salaryComponentTools.js / payrollConfigTools.js.
// The verified tenant travels on ctx.user.tenantId (signed service-JWT claim,
// never a spoofable header) and is threaded into every service call.
import { z } from "zod";
import {
  createPayrollRules,
  updatePayrollRule,
  deletePayrollRules,
  listPayrollRules,
  getPayrollRule,
} from "../../services/payrollRule.service.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const RESOURCE = "hr:payroll";

export function registerPayrollRuleTools(server) {
  server.tool(
    "hr_payroll_rule_create",
    "Create one or more Pay Rules (Payroll Setup → Pay Rules). Send `rules` as an ARRAY of { title, description }. The backend camel-cases each title into a stable ruleKey (e.g. \"Mid Month Joiner Proration\" → \"midMonthJoinerProration\"), unique per tenant. Rejects duplicate keys within the batch or against existing rules.",
    {
      rules: z
        .array(
          z.object({
            title: z.string().min(1).describe("Human rule title; camel-cased server-side into ruleKey"),
            description: z.string().optional().describe("Human rule description"),
            enabled: z.boolean().optional().describe("Whether the rule is active (default true)"),
            sortOrder: z.coerce.number().int().optional().describe("Display sort order (default 0)"),
          })
        )
        .min(1)
        .describe("Array of rules to create — each needs a title; description/enabled/sortOrder optional"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await createPayrollRules({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rule_create")
  );

  server.tool(
    "hr_payroll_rule_update",
    "Update a single Pay Rule. Changing the title recomputes ruleKey (re-checking per-tenant uniqueness). Any edit bumps version and reverts the row to DRAFT.",
    {
      id: z.coerce.number().int().describe("PayrollRule.id to update (required)"),
      title: z.string().min(1).optional().describe("New title (recomputes ruleKey)"),
      description: z.string().optional().describe("New description (pass empty string to clear)"),
      enabled: z.boolean().optional().describe("Whether the rule is active"),
      sortOrder: z.coerce.number().int().optional().describe("Display sort order"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updatePayrollRule({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rule_update")
  );

  server.tool(
    "hr_payroll_rule_delete",
    "Delete one or more Pay Rules. Pass a single `id`, or `ids` as an array for bulk delete. Tenant-scoped — cross-tenant ids match nothing.",
    {
      id: z.coerce.number().int().optional().describe("PayrollRule.id to delete (single)"),
      ids: z.array(z.coerce.number().int()).optional().describe("PayrollRule.id list to delete (bulk)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
      const data = await deletePayrollRules({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rule_delete")
  );

  server.tool(
    "hr_payroll_rule_list",
    "List Pay Rules (array) with search / filters / sort. Returns items + total for the tenant.",
    {
      q: z.string().optional().describe("Case-insensitive search over title, ruleKey, description"),
      enabled: z.boolean().optional().describe("Filter by enabled flag"),
      status: z.enum(["DRAFT", "PUBLISHED"]).optional().describe("Filter by config status — DRAFT | PUBLISHED"),
      sortBy: z.enum(["sortOrder", "title", "ruleKey", "createdAt"]).optional().describe("Sort field (default sortOrder)"),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 50, max 200)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listPayrollRules({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rule_list")
  );

  server.tool(
    "hr_payroll_rule_get",
    "Get a single Pay Rule by id.",
    {
      id: z.coerce.number().int().describe("PayrollRule.id to fetch"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getPayrollRule({ tenantId: user.tenantId, id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_payroll_rule_get")
  );
}
