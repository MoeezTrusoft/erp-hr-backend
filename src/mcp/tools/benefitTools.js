// src/mcp/tools/benefitTools.js — HR-BENEFITS-04 (MCP facade)
//
// MCP facade for the EXISTING benefits surface (benefit.routes.js /
// benefit.controller.js). Each tool is a THIN wrapper that dispatches to the
// HTTP controller through runController, so it reuses the same service path,
// tenant scoping (req.user.tenantId — T-P2.1) and {SVC}-nnnn errors — no
// net-new behaviour. Every tool is deny-by-default permission-gated on the SAME
// entitlement the REST route uses: `hr:benefits` (requirePermission in
// benefit.routes.js). The forgeable x-is-admin flag grants nothing.
import { z } from "zod";
import {
  mcpListBenefitPlans,
  mcpGetBenefitPlan,
  mcpCreateBenefitPlan,
  mcpUpdateBenefitPlan,
  mcpDeleteBenefitPlan,
  mcpEnrollBenefit,
  mcpUnenrollBenefit,
  mcpListEmployeeBenefits,
} from "../controllers/benefitMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const BENEFITS_KEY = "hr:benefits";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerBenefitTools(server) {
  // ── RESOURCES ──────────────────────────────────────────────────────────────
  server.resource(
    "hr_benefit_plans_list",
    "hr://benefits/plans",
    { description: "List all benefit plans" },
    async (uri) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", BENEFITS_KEY, user.isAdmin);
      const data = await mcpListBenefitPlans(user, {});
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── BENEFIT PLAN TOOLS ─────────────────────────────────────────────────────
  server.tool(
    "hr_benefit_plan_list",
    "List benefit plans (optionally filter by type/active)",
    {
      type: z.enum(["HEALTH", "RETIREMENT", "ALLOWANCE", "OTHER"]).optional().describe("Filter by benefit type — one of HEALTH | RETIREMENT | ALLOWANCE | OTHER (BenefitType enum)"),
      active: z.boolean().optional().describe("Filter by active flag"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", BENEFITS_KEY, user.isAdmin);
      const data = await mcpListBenefitPlans(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_benefit_plan_get",
    "Get a single benefit plan by id",
    { id: z.string().min(1).describe("Benefit plan id (numeric string) — BenefitPlan.id") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", BENEFITS_KEY, user.isAdmin);
      const data = await mcpGetBenefitPlan(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_benefit_plan_create",
    "Create a benefit plan",
    {
      name: z.string().min(1).describe("Benefit plan name — BenefitPlan.name"),
      type: z.enum(["HEALTH", "RETIREMENT", "ALLOWANCE", "OTHER"]).describe("Benefit type — one of HEALTH | RETIREMENT | ALLOWANCE | OTHER (BenefitType enum)"),
      description: z.string().optional().describe("Optional description — BenefitPlan.description"),
      employerContribution: z.number().nonnegative().optional().describe("Employer contribution in major units (>= 0)"),
      employeeContribution: z.number().nonnegative().optional().describe("Employee contribution in major units (>= 0)"),
      active: z.boolean().optional().describe("Active flag (defaults to true when omitted)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", BENEFITS_KEY, user.isAdmin);
      const data = await mcpCreateBenefitPlan(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_benefit_plan_update",
    "Update a benefit plan",
    {
      id: z.string().min(1).describe("Benefit plan id (numeric string) — BenefitPlan.id to update"),
      name: z.string().min(1).optional().describe("Benefit plan name — BenefitPlan.name"),
      type: z.enum(["HEALTH", "RETIREMENT", "ALLOWANCE", "OTHER"]).optional().describe("Benefit type — one of HEALTH | RETIREMENT | ALLOWANCE | OTHER (BenefitType enum)"),
      description: z.string().optional().describe("Optional description — BenefitPlan.description"),
      employerContribution: z.number().nonnegative().optional().describe("Employer contribution in major units (>= 0)"),
      employeeContribution: z.number().nonnegative().optional().describe("Employee contribution in major units (>= 0)"),
      active: z.boolean().optional().describe("Active flag"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", BENEFITS_KEY, user.isAdmin);
      const data = await mcpUpdateBenefitPlan(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_benefit_plan_delete",
    "Delete a benefit plan",
    { id: z.string().min(1).describe("Benefit plan id (numeric string) — BenefitPlan.id to delete") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", BENEFITS_KEY, user.isAdmin);
      const data = await mcpDeleteBenefitPlan(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── ENROLLMENT TOOLS ───────────────────────────────────────────────────────
  server.tool(
    "hr_benefit_enroll",
    "Enroll an employee into a benefit plan",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string) — Employee.id to enroll"),
      benefitPlanId: z.string().min(1).describe("Benefit plan id (numeric string) — BenefitPlan.id to enroll into"),
      electedAmount: z.number().nonnegative().optional().describe("Elected contribution amount in major units (>= 0)"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", BENEFITS_KEY, user.isAdmin);
      const data = await mcpEnrollBenefit(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_benefit_unenroll",
    "Unenroll an employee from a benefit plan",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string) — Employee.id to unenroll"),
      benefitPlanId: z.string().min(1).describe("Benefit plan id (numeric string) — BenefitPlan.id to unenroll from"),
    },
    withToolError(async ({ employeeId, benefitPlanId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", BENEFITS_KEY, user.isAdmin);
      const data = await mcpUnenrollBenefit(user, employeeId, benefitPlanId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_employee_benefits_list",
    "List an employee's benefit enrollments",
    {
      employeeId: z.string().min(1).describe("Employee id (numeric string) — Employee.id whose enrollments to list"),
      status: z.enum(["ACTIVE", "WAIVED", "TERMINATED"]).optional().describe("Filter by enrollment status — one of ACTIVE | WAIVED | TERMINATED (EmployeeBenefitStatus enum); defaults to ACTIVE when omitted"),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", BENEFITS_KEY, user.isAdmin);
      const data = await mcpListEmployeeBenefits(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
