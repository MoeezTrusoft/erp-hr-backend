// src/mcp/tools/onboardingScheduleTools.js — Onboarding Schedule (sessions) +
// Documents MCP tools.
//
// Surfaces the onboarding "Schedule" (session) and "Documents" screens:
//   hr_onboarding_schedule_list    — sessions for a checklist (enriched)
//   hr_onboarding_schedule_create  — create an OnboardingSession
//   hr_onboarding_schedule_update  — update an OnboardingSession
//   hr_onboarding_documents_list   — documents for a checklist (enriched)
//   hr_onboarding_document_add     — create an OnboardingDocument (DAM mediaId
//                                    is passed in; upload happens elsewhere)
//
// Auth: every handler runs getCtx() → assertPermission(METHOD, "hr:onboarding")
// → service(..., user.tenantId), matching the existing onboardingTools.js
// surface. All reads/writes are tenant-scoped by the verified user.tenantId.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listSchedule,
  createSession,
  updateSession,
  listDocuments,
  addDocument,
} from "../../services/onboardingSchedule.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOnboardingScheduleTools(server) {
  // ── SCHEDULE (sessions) ──────────────────────────────────────────────────

  server.tool(
    "hr_onboarding_schedule_list",
    "List onboarding schedule sessions for a checklist (candidate, role, joining date, timing, assignee)",
    {
      checklistId: z
        .union([z.string(), z.number()])
        .describe("Onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
    },
    withToolError(async ({ checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await listSchedule(checklistId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_schedule_create",
    "Create an onboarding schedule session for a checklist",
    {
      checklistId: z
        .union([z.string(), z.number()])
        .describe("Parent onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
      title: z.string().min(1).describe("Session title"),
      sessionDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD (or datetime)"),
      fromTime: z.string().optional().describe('Start time, free-form "HH:mm" e.g. "09:00"'),
      toTime: z.string().optional().describe('End time, free-form "HH:mm" e.g. "10:00"'),
      sessionType: z.string().optional().describe("Free-form session type e.g. orientation | training | meeting"),
      location: z.string().optional().describe("Room name or meeting link"),
      assigneeId: z.coerce.number().int().optional().describe("Employee id of the session owner (references Employee)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await createSession(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_schedule_update",
    "Update an onboarding schedule session",
    {
      id: z.union([z.string(), z.number()]).describe("Onboarding session id (references OnboardingSession; Number()-coerced)"),
      title: z.string().min(1).optional().describe("Session title"),
      sessionDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD (or datetime)"),
      fromTime: z.string().optional().describe('Start time, free-form "HH:mm" e.g. "11:00"'),
      toTime: z.string().optional().describe('End time, free-form "HH:mm" e.g. "12:00"'),
      sessionType: z.string().optional().describe("Free-form session type e.g. orientation | training | meeting"),
      location: z.string().optional().describe("Room name or meeting link"),
      assigneeId: z.coerce.number().int().optional().describe("Employee id of the session owner (references Employee)"),
    },
    withToolError(async ({ id, ...patch }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const data = await updateSession(id, patch, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── DOCUMENTS ────────────────────────────────────────────────────────────

  server.tool(
    "hr_onboarding_documents_list",
    "List onboarding documents for a checklist (name, type, uploaded date, sign status, mediaId)",
    {
      checklistId: z
        .union([z.string(), z.number()])
        .describe("Onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
    },
    withToolError(async ({ checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await listDocuments(checklistId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_onboarding_document_add",
    "Attach an already-uploaded DAM document (by mediaId) to an onboarding checklist. Upload the media via the DAM upload tool first, then pass the resulting mediaId here.",
    {
      checklistId: z
        .union([z.string(), z.number()])
        .describe("Parent onboarding checklist id (references OnboardingChecklist; Number()-coerced)"),
      employeeId: z.coerce.number().int().describe("Employee id the document belongs to (references Employee)"),
      title: z.string().min(1).describe("Document display name"),
      mediaId: z.coerce.number().int().describe("DAM media id of the already-uploaded file (references DAM Media)"),
      category: z.string().optional().describe("Free-form document category e.g. offer | contract | policy"),
      requiresSign: z.boolean().optional().describe("Whether the document needs a signature; defaults to false"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await addDocument(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
