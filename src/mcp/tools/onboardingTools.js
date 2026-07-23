import { z } from "zod";
import {
  mcpAddOnboardingTask,
  mcpAssignOnboardingBuddy,
  mcpCreateOnboardingChecklist,
  mcpDeleteOnboardingTask,
  mcpListOnboardingChecklists,
  mcpListOnboardingSurveys,
  mcpSignOnboardingDocument,
  mcpSubmitOnboardingSurvey,
  mcpUpdateOnboardingChecklist,
  mcpUpdateOnboardingTask,
} from "../controllers/onboardingMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOnboardingTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_onboarding_checklists_list",
    "hr://onboarding/checklists",
    { description: "List all onboarding checklists" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListOnboardingChecklists(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_onboarding_surveys_list",
    "hr://onboarding/surveys",
    { description: "List onboarding surveys (30/60/90 day)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListOnboardingSurveys(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_onboarding_checklist_create",
    "Create an onboarding checklist for a new employee",
    {
      employeeId: z.string().min(1).describe("Employee id this checklist is for (references Employee; Number()-coerced)"),
      title: z.string().min(1).optional().describe("Checklist title; defaults to 'Employee Onboarding' when omitted"),
      templateId: z
        .string()
        .min(1)
        .optional()
        .describe("Onboarding template name; persisted to OnboardingChecklist.template (seeds no tasks)"),
      startDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD; defaults to today when omitted"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await mcpCreateOnboardingChecklist(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_checklist_update",
    "Update an onboarding checklist",
    {
      id: z.string().min(1).describe("Onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
      status: z
        .enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "OVERDUE"])
        .optional()
        .describe("OnboardingStatus — one of NOT_STARTED | IN_PROGRESS | COMPLETED | OVERDUE"),
      notes: z.string().optional().describe("Free-text checklist notes"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const data = await mcpUpdateOnboardingChecklist(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_task_add",
    "Add a task to an onboarding checklist",
    {
      checklistId: z.string().min(1).describe("Parent onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
      title: z.string().min(1).describe("Task title"),
      description: z.string().optional().describe("Task description"),
      assigneeType: z
        .enum(["HR", "MANAGER", "NEW_HIRE", "IT"])
        .optional()
        .describe("TaskAssigneeType — one of HR | MANAGER | NEW_HIRE | IT; defaults to HR when omitted"),
      dueDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD"),
      assigneeId: z.string().optional().describe("Employee id of the task assignee (references Employee; Number()-coerced)"),
    },
    withToolError(async ({ checklistId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await mcpAddOnboardingTask(user, checklistId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_task_update",
    "Update an onboarding task (mark complete, update notes)",
    {
      taskId: z.string().min(1).describe("Onboarding task id (references OnboardingTask; Number()-coerced)"),
      status: z
        .enum(["PENDING", "IN_PROGRESS", "COMPLETED"])
        .optional()
        .describe("Virtual status mapped to the `completed` boolean: COMPLETED → completed=true; PENDING/IN_PROGRESS → completed=false"),
      notes: z.string().optional().describe("Free-text notes; written to the task `description` column"),
    },
    withToolError(async ({ taskId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const data = await mcpUpdateOnboardingTask(user, taskId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_task_delete",
    "Delete an onboarding task",
    { taskId: z.string().min(1) },
    withToolError(async ({ taskId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:onboarding", user.isAdmin);
      const data = await mcpDeleteOnboardingTask(user, taskId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_document_sign",
    "Mark an onboarding document as signed",
    {
      docId: z.string().min(1).describe("Onboarding document id (references OnboardingDocument; Number()-coerced)"),
      signedBy: z
        .string()
        .optional()
        .describe("Employee id of the signer (references Employee; persisted to OnboardingDocument.signedByEmpId)"),
    },
    withToolError(async ({ docId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const data = await mcpSignOnboardingDocument(user, docId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_buddy_assign",
    "Assign an onboarding buddy to a new employee",
    {
      checklistId: z.string().min(1).describe("Onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
      buddyId: z.string().min(1).describe("Employee id of the buddy (references Employee; Number()-coerced)"),
    },
    withToolError(async ({ checklistId, buddyId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await mcpAssignOnboardingBuddy(user, checklistId, { buddyId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_survey_submit",
    "Submit a 30/60/90-day onboarding survey",
    {
      employeeId: z.string().min(1).describe("Employee id whose latest checklist the survey binds to (references Employee; Number()-coerced)"),
      surveyType: z
        .enum(["30_DAY", "60_DAY", "90_DAY"])
        .describe("Survey milestone (wire form) — one of 30_DAY | 60_DAY | 90_DAY; stored as SurveyType DAY_30/DAY_60/DAY_90"),
      responses: z.record(z.string(), z.unknown()).describe("Survey question responses keyed by question id; stored verbatim as JSON"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await mcpSubmitOnboardingSurvey(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
