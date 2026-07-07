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
      employeeId: z.string().min(1),
      templateId: z.string().optional().describe("Use a predefined template"),
      startDate: z.string().optional().describe("ISO 8601 date"),
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
      id: z.string().min(1),
      status: z.string().optional(),
      notes: z.string().optional(),
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
      checklistId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      dueDate: z.string().optional().describe("ISO 8601 date"),
      assigneeId: z.string().optional(),
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
      taskId: z.string().min(1),
      status: z.string().optional().describe("e.g. PENDING, IN_PROGRESS, COMPLETED"),
      notes: z.string().optional(),
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
      docId: z.string().min(1),
      signedBy: z.string().optional(),
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
      checklistId: z.string().min(1),
      buddyId: z.string().min(1).describe("Employee ID of the buddy"),
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
      employeeId: z.string().min(1),
      surveyType: z.enum(["30_DAY", "60_DAY", "90_DAY"]),
      responses: z.record(z.string(), z.unknown()).describe("Survey question responses"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await mcpSubmitOnboardingSurvey(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
