// src/mcp/tools/onboardingPortalScreenTools.js — MCP facade for the FE
// "Onboarding Portal" (new-employee self-service screen).
//
// Thin adapters over onboardingPortalScreen.service.js. Every tool resolves the
// request context, asserts the hr:onboarding permission for its HTTP method, and
// threads the VERIFIED tenant (user.tenantId). Reads default to the CALLER'S own
// onboarding (employeeId from the session); an explicit employeeId/checklistId
// lets HR/admins view another new hire (mirrors the my-payslip pattern).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  ONBOARDING_TASK_CATEGORIES,
} from "../../lib/onboardingTaxonomy.js";
import {
  getOnboardingPortal,
  createPortalTask,
  updatePortalTask,
  completePortalTask,
  deletePortalTask,
  getFeedbackQuestions,
  submitPortalFeedback,
  sendTaskReminder,
} from "../../services/onboardingPortalScreen.service.js";

const RESOURCE_KEY = "hr:onboarding";
const CATEGORY_ENUM = z.enum(ONBOARDING_TASK_CATEGORIES);

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// self-scope: explicit employeeId wins, else the session's bound employee.
function selfEmployeeId(user, explicit) {
  return explicit != null ? explicit : user?.employeeId;
}

export function registerOnboardingPortalScreenTools(server) {
  // 1 — portal loader (header + tasks + progress + feedback status)
  server.tool(
    "hr_onboarding_portal_get",
    "Onboarding Portal for a new employee: profile header (self, manager, buddy, location, joining date) + onboarding tasks (each with category, deadline, responsible employee and done status) grouped by category + progress + whether feedback was submitted. Defaults to the calling employee; pass employeeId or checklistId to view another new hire.",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("Employee id whose portal to load. Defaults to the caller's own session employee."),
      checklistId: z.union([z.string(), z.number()]).optional().describe("Explicit OnboardingChecklist id (wins over employeeId)."),
    },
    withToolError(async ({ employeeId, checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const data = await getOnboardingPortal({
        tenantId: user.tenantId,
        employeeId: selfEmployeeId(user, employeeId),
        checklistId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_get")
  );

  // 2 — create task
  server.tool(
    "hr_onboarding_portal_task_create",
    "Add an onboarding task to a new hire's portal. Category is the KIND of setup (IT & Access, Workspace, ...); responsibleId is any employee accountable for it (incl. the onboarding person). deadline is an ISO timestamp.",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("New hire's employee id (resolves their active checklist). Defaults to the caller."),
      checklistId: z.union([z.string(), z.number()]).optional().describe("Explicit OnboardingChecklist id (wins over employeeId)."),
      title: z.string().min(1).describe("Task title"),
      category: CATEGORY_ENUM.optional().describe(`Task category — one of: ${ONBOARDING_TASK_CATEGORIES.join(" | ")} (default OTHER)`),
      deadline: z.string().optional().describe("ISO 8601 deadline timestamp"),
      responsibleId: z.union([z.string(), z.number()]).optional().describe("Employee id of the responsible person (any employee)"),
      description: z.string().optional().describe("Free-text detail"),
      stage: z.string().optional().describe("Optional onboarding stage (pre_joining | first_week | ...)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE_KEY, user.isAdmin);
      const data = await createPortalTask({
        tenantId: user.tenantId,
        employeeId: selfEmployeeId(user, args.employeeId),
        checklistId: args.checklistId,
        title: args.title,
        category: args.category,
        deadline: args.deadline,
        responsibleId: args.responsibleId,
        description: args.description,
        stage: args.stage,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_task_create")
  );

  // 3 — update task (full edit)
  server.tool(
    "hr_onboarding_portal_task_update",
    "Edit an onboarding task — any of title, category, deadline, responsible employee, description, or done status. Recomputes completedAt when `done` changes.",
    {
      taskId: z.union([z.string(), z.number()]).describe("OnboardingTask id"),
      title: z.string().min(1).optional(),
      category: CATEGORY_ENUM.optional().describe(`One of: ${ONBOARDING_TASK_CATEGORIES.join(" | ")}`),
      deadline: z.string().optional().describe("ISO 8601 deadline; pass empty to clear"),
      responsibleId: z.union([z.string(), z.number()]).optional().describe("Reassign to this employee id"),
      description: z.string().optional(),
      stage: z.string().optional(),
      done: z.boolean().optional().describe("Mark the task done (true) or not (false)"),
    },
    withToolError(async ({ taskId, ...patch }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE_KEY, user.isAdmin);
      const data = await updatePortalTask({ tenantId: user.tenantId, taskId, ...patch });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_task_update")
  );

  // 4 — mark task done (the explicit "Task done" action)
  server.tool(
    "hr_onboarding_portal_task_complete",
    "Mark an onboarding task done (or reopen it). Convenience action for the portal's task checkbox.",
    {
      taskId: z.union([z.string(), z.number()]).describe("OnboardingTask id"),
      done: z.boolean().optional().describe("true (default) marks done; false reopens"),
    },
    withToolError(async ({ taskId, done }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE_KEY, user.isAdmin);
      const data = await completePortalTask({ tenantId: user.tenantId, taskId, done: done ?? true });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_task_complete")
  );

  // 5 — delete task
  server.tool(
    "hr_onboarding_portal_task_delete",
    "Delete an onboarding task from a new hire's portal.",
    {
      taskId: z.union([z.string(), z.number()]).describe("OnboardingTask id"),
    },
    withToolError(async ({ taskId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE_KEY, user.isAdmin);
      const data = await deletePortalTask({ tenantId: user.tenantId, taskId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_task_delete")
  );

  // 6 — feedback questionnaire (questions + radio options + any prior answers)
  server.tool(
    "hr_onboarding_portal_feedback_questions",
    "Get the onboarding-feedback questionnaire (questions, each with its radio options) plus any answers already submitted for this checklist.",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("Defaults to the caller's session employee."),
      checklistId: z.union([z.string(), z.number()]).optional().describe("Explicit OnboardingChecklist id."),
    },
    withToolError(async ({ employeeId, checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
      const data = await getFeedbackQuestions({
        tenantId: user.tenantId,
        employeeId: selfEmployeeId(user, employeeId),
        checklistId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_feedback_questions")
  );

  // 7 — submit feedback (radio answers validated against the canonical options)
  server.tool(
    "hr_onboarding_portal_feedback_submit",
    "Submit onboarding feedback (by the new hire). answers is an array of { questionId, answer } where each answer must be one of that question's radio options (see hr_onboarding_portal_feedback_questions). One submission per checklist — re-submitting overwrites.",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("Defaults to the caller's session employee."),
      checklistId: z.union([z.string(), z.number()]).optional().describe("Explicit OnboardingChecklist id."),
      answers: z
        .array(
          z.object({
            questionId: z.string().describe("Canonical question id (e.g. role_clarity)"),
            answer: z.string().describe("Selected radio option — must match one of the question's options"),
          })
        )
        .min(1)
        .describe("Radio answers, one per question answered"),
      comments: z.string().optional().describe("Optional free-text comments"),
    },
    withToolError(async ({ employeeId, checklistId, answers, comments }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE_KEY, user.isAdmin);
      const data = await submitPortalFeedback({
        tenantId: user.tenantId,
        employeeId: selfEmployeeId(user, employeeId),
        checklistId,
        answers,
        comments,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_feedback_submit")
  );

  // 8 — send reminder (recipient auto-selected = task's responsible person)
  server.tool(
    "hr_onboarding_portal_send_reminder",
    "Send a reminder for an onboarding task. The recipient is AUTO-selected as the task's responsible person; subject and message default sensibly if omitted. Emits an in-app notification event (email channel disabled at source). Returns the resolved recipient.",
    {
      taskId: z.union([z.string(), z.number()]).describe("OnboardingTask id to remind about"),
      subject: z.string().optional().describe("Override subject (defaults to 'Reminder: <task title>')"),
      message: z.string().optional().describe("Override message (defaults to a sensible reminder body)"),
    },
    withToolError(async ({ taskId, subject, message }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE_KEY, user.isAdmin);
      const data = await sendTaskReminder({
        tenantId: user.tenantId,
        taskId,
        subject,
        message,
        actor: { employeeId: user.employeeId, userId: user.userId, email: user.email },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_portal_send_reminder")
  );
}
