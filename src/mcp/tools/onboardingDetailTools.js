// src/mcp/tools/onboardingDetailTools.js — Onboarding "New Hire Detail" screen:
// detail read, stage-aware task create, and reminder-intent recorder.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getOnboardingDetail,
  createOnboardingTask,
  sendOnboardingReminder,
} from "../../services/onboardingDetail.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx.permissions || {} };
}

const STAGE = z.enum(["pre_joining", "pre_boarding", "first_week", "equipment"]);

export function registerOnboardingDetailTools(server) {
  server.tool(
    "hr_onboarding_detail_get",
    "Get the New Hire onboarding detail: header (name, role, joining date, progress %, status) plus checklist tasks grouped by stage (pre_joining | pre_boarding | first_week | equipment). Returns everything the employee-view / show-more FE needs.",
    {
      id: z.coerce.number().int().positive().describe("OnboardingChecklist id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await getOnboardingDetail(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_detail_get")
  );

  server.tool(
    "hr_onboarding_task_create",
    "Create a stage-aware onboarding task on a checklist (sets `stage`). Unlike hr_onboarding_task_add, this requires the stage bucket the task belongs to.",
    {
      checklistId: z.coerce.number().int().positive(),
      title: z.string().min(1),
      stage: STAGE,
      startDate: z.string().optional().describe("ISO 8601 date → task dueDate"),
      assigneeId: z.coerce.number().int().positive().optional(),
      assigneeType: z.enum(["HR", "MANAGER", "NEW_HIRE", "IT"]).optional().describe("default HR"),
      notes: z.string().optional().describe("→ task description"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await createOnboardingTask(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_task_create")
  );

  server.tool(
    "hr_onboarding_send_reminder",
    "Record a reminder intent against an onboarding checklist. Appends an entry to the checklist activityLog. NOTE: no email is actually sent — this only records the intent.",
    {
      checklistId: z.coerce.number().int().positive(),
      sendTo: z.string().min(1).describe("recipient email or name"),
      subject: z.string().min(1),
      message: z.string().min(1),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await sendOnboardingReminder(
        { ...args, actor: user.email || user.userId || "system" },
        user.tenantId
      );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_send_reminder")
  );
}
