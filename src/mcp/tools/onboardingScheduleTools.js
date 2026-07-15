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
    { checklistId: z.string().min(1) },
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
      checklistId: z.string().min(1),
      title: z.string().min(1),
      sessionDate: z.string().optional().describe("ISO 8601 date/datetime"),
      fromTime: z.string().optional().describe('e.g. "09:00"'),
      toTime: z.string().optional().describe('e.g. "10:00"'),
      sessionType: z.string().optional().describe("orientation | training | meeting"),
      location: z.string().optional().describe("room or link"),
      assigneeId: z.coerce.number().int().optional().describe("Employee id of the session owner"),
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
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      sessionDate: z.string().optional().describe("ISO 8601 date/datetime"),
      fromTime: z.string().optional(),
      toTime: z.string().optional(),
      sessionType: z.string().optional(),
      location: z.string().optional(),
      assigneeId: z.coerce.number().int().optional(),
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
    { checklistId: z.string().min(1) },
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
      checklistId: z.string().min(1),
      employeeId: z.coerce.number().int(),
      title: z.string().min(1),
      mediaId: z.coerce.number().int().describe("DAM media id of the already-uploaded file"),
      category: z.string().optional(),
      requiresSign: z.boolean().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await addDocument(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
