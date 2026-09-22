// src/mcp/tools/onboardingTemplateTools.js — FR-13 residue.
//
// Tenant-configurable onboarding checklist templates: read the current
// configuration, write a template, deactivate one. The accepted-offer handoff
// consumes the active default (services/onboardingTemplate.service.js); these
// tools are how an operator sets it.
//
// Gating mirrors the rest of the recruitment surface: reads need the recruitment
// read grant, writes the update grant — the gateway's edge map pins the same
// permission, so a tool the edge lets through is one HR will accept.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listTemplates,
  upsertTemplate,
  deactivateTemplate,
} from "../../services/onboardingTemplate.service.js";
import { ONBOARDING_TASK_ASSIGNEES, ONBOARDING_TASK_STAGES } from "../../lib/onboardingDefaults.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const taskShape = z.object({
  title: z.string().min(1).describe("Task title shown on the onboarding checklist"),
  description: z.string().optional().describe("Optional detail for the assignee"),
  stage: z.enum(ONBOARDING_TASK_STAGES).describe("Onboarding stage the task belongs to"),
  category: z.string().min(1).describe("Task category (e.g. HR_DOCUMENTATION, IT_ACCESS_SETUP)"),
  assigneeType: z.enum(ONBOARDING_TASK_ASSIGNEES).describe("Who owns the task"),
  dueInDays: z.coerce.number().int().describe("Days relative to the hire date; negative = before day one"),
});

export function registerOnboardingTemplateTools(server) {
  server.tool(
    "hr_onboarding_template_list",
    "List the tenant's onboarding checklist templates (newest default first). The active default is what a newly provisioned hire's checklist is seeded from; with no template configured the documented baseline applies.",
    {
      includeInactive: z.coerce.boolean().optional().describe("Include deactivated templates (default false)"),
    },
    withToolError(async ({ includeInactive }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listTemplates({ tenantId: user.tenantId, includeInactive: Boolean(includeInactive) });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_template_list")
  );

  server.tool(
    "hr_onboarding_template_set",
    "Create or update an onboarding checklist template by name (upsert on tenant+name). The task list is validated before it is stored. Set makeDefault to make it the template every subsequently provisioned hire is seeded from — promoting a default clears the previous one in the same transaction, so exactly one default exists.",
    {
      name: z.string().min(1).describe("Template name (unique per tenant)"),
      description: z.string().optional().describe("Optional description of when this template applies"),
      tasks: z.array(taskShape).min(1).describe("Ordered task definitions; at least one"),
      makeDefault: z.coerce.boolean().optional().describe("Promote this template to the tenant default"),
    },
    withToolError(async ({ name, description, tasks, makeDefault }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await upsertTemplate({
        tenantId: user.tenantId,
        name,
        description: description ?? null,
        tasks,
        makeDefault: Boolean(makeDefault),
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_template_set")
  );

  server.tool(
    "hr_onboarding_template_deactivate",
    "Deactivate an onboarding checklist template. Deactivating the tenant's default leaves the tenant on the documented baseline — provisioning never fails and never produces an empty checklist because of a configuration change.",
    {
      templateId: z.string().min(1).describe("Template id; numeric string"),
    },
    withToolError(async ({ templateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await deactivateTemplate({ tenantId: user.tenantId, templateId });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_template_deactivate")
  );
}
