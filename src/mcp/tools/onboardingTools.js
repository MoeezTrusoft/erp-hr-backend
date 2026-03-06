import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


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
      const data = await self("GET", "/api/onboarding/checklists", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_onboarding_surveys_list",
    "hr://onboarding/surveys",
    { description: "List onboarding surveys (30/60/90 day)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/onboarding/surveys", user);
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
      assertPermission(permissions, "POST", "/hr/api/onboarding/checklists", user.isAdmin);
      const data = await self("POST", "/api/onboarding/checklists", user, args);
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
      assertPermission(permissions, "PUT", `/hr/api/onboarding/checklists/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/onboarding/checklists/${id}`, user, rest);
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
      assertPermission(permissions, "POST", `/hr/api/onboarding/checklists/${checklistId}/tasks`, user.isAdmin);
      const data = await self("POST", `/api/onboarding/checklists/${checklistId}/tasks`, user, rest);
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
      assertPermission(permissions, "PUT", `/hr/api/onboarding/tasks/${taskId}`, user.isAdmin);
      const data = await self("PUT", `/api/onboarding/tasks/${taskId}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_task_delete",
    "Delete an onboarding task",
    { taskId: z.string().min(1) },
    withToolError(async ({ taskId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/onboarding/tasks/${taskId}`, user.isAdmin);
      const data = await self("DELETE", `/api/onboarding/tasks/${taskId}`, user);
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
      assertPermission(permissions, "PUT", `/hr/api/onboarding/documents/${docId}/sign`, user.isAdmin);
      const data = await self("PUT", `/api/onboarding/documents/${docId}/sign`, user, rest);
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
      assertPermission(permissions, "POST", `/hr/api/onboarding/checklists/${checklistId}/buddy`, user.isAdmin);
      const data = await self("POST", `/api/onboarding/checklists/${checklistId}/buddy`, user, { buddyId });
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
      assertPermission(permissions, "POST", "/hr/api/onboarding/surveys", user.isAdmin);
      const data = await self("POST", "/api/onboarding/surveys", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
