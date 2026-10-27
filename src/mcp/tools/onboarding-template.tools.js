// src/mcp/tools/onboarding-template.tools.js — FR-13 residue.
//
// Tenant-configurable onboarding checklist templates: read the current
// configuration, write a template, deactivate one. The accepted-offer handoff
// consumes the active default (services/onboarding-template.service.js); these
// tools are how an operator sets it.
//
// Gating mirrors the rest of the recruitment surface: reads need the recruitment
// read grant, writes the update grant — the gateway's edge map pins the same
// permission, so a tool the edge lets through is one HR will accept.
//
// Recruitment Phase 4 — a template may also carry the orientation and
// compliance `sessions` created on handoff. Optional on the set tool: omitted
// leaves the stored list unchanged, null restores the baseline set.
//
// Recruitment Phase 6 — hr_onboarding_template_reactivate brings a deactivated
// template back (optionally as the default), hr_onboarding_template_default_unset
// stops using one as the default without deactivating it (new hires then get
// the baseline). Both on the recruitment update grant, like the other writes.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listTemplates,
  upsertTemplate,
  deactivateTemplate,
  reactivateTemplate,
  unsetDefaultTemplate,
} from "../../services/onboarding-template.service.js";
import { ONBOARDING_TASK_ASSIGNEES, ONBOARDING_TASK_STAGES } from "../../lib/onboarding-defaults.util.js";
import { ONBOARDING_SESSION_ASSIGNEES, ONBOARDING_SESSION_TYPES } from "../../lib/onboarding-sessions.util.js";

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

const sessionShape = z.object({
  key: z.string().min(1).max(64).describe('Stable key, unique in the template (lowercase letters, digits, "-" or "_"); one session per hire and key'),
  title: z.string().min(1).describe("Session title shown on the schedule and the calendar invite"),
  sessionType: z.enum(ONBOARDING_SESSION_TYPES).describe("orientation | training | meeting | compliance"),
  dayOffset: z.coerce.number().int().describe("Working days from the start date (0 = day one; weekends are skipped)"),
  fromTime: z.string().optional().describe('Start time "HH:MM" in the company time zone'),
  toTime: z.string().optional().describe('End time "HH:MM", after fromTime'),
  location: z.string().optional().describe("Room or meeting link"),
  required: z.boolean().optional().describe("Attendance is required (default false)"),
  assigneeType: z.enum(ONBOARDING_SESSION_ASSIGNEES).describe("Who runs it: HR (the hire's recruiter), MANAGER, BUDDY or NEW_HIRE (no host)"),
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
      sessions: z
        .array(sessionShape)
        .max(20)
        .nullable()
        .optional()
        .describe("Orientation and compliance sessions created on handoff; omit to keep the stored list, null for the baseline set, [] for none"),
    },
    withToolError(async ({ name, description, tasks, makeDefault, sessions }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await upsertTemplate({
        tenantId: user.tenantId,
        name,
        description: description ?? null,
        tasks,
        ...(sessions !== undefined ? { sessions } : {}),
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

  server.tool(
    "hr_onboarding_template_reactivate",
    "Reactivate a deactivated onboarding checklist template so it can be used again. It comes back as a plain active template; set makeDefault to also make it the tenant default (the previous default is cleared in the same transaction). Reactivating an active template changes nothing (changed false).",
    {
      templateId: z.string().min(1).describe("Template id; numeric string"),
      makeDefault: z.coerce.boolean().optional().describe("Also promote it to the tenant default"),
    },
    withToolError(async ({ templateId, makeDefault }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await reactivateTemplate({ tenantId: user.tenantId, templateId, makeDefault: Boolean(makeDefault) });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_template_reactivate")
  );

  server.tool(
    "hr_onboarding_template_default_unset",
    "Stop using an onboarding checklist template as the tenant default without deactivating it. With no default, newly provisioned hires get the documented baseline tasks and sessions. A template that is not the default changes nothing (changed false).",
    {
      templateId: z.string().min(1).describe("Template id; numeric string"),
    },
    withToolError(async ({ templateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await unsetDefaultTemplate({ tenantId: user.tenantId, templateId });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_template_default_unset")
  );
}
