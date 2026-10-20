// src/mcp/tools/onboarding-session-plan.tools.js
//
// Recruitment Phase 4 (plan 6.7 "Orientation scheduling") — the HR side of
// the orientation and compliance sessions created on handoff:
//
//   hr_onboarding_session_plan_preview     GET    what a template would
//       create for a start date (the default template, a named one, or a
//       draft list), so HR can check it before it reaches a new hire
//   hr_onboarding_session_calendar_resync  POST   requeue one session's
//       calendar invite (create, update or cancel as its state needs)
//   hr_onboarding_session_delete           DELETE remove a session; one with
//       an invite is cancelled on the calendar first
//
// Every tool checks hr:onboarding with its HTTP method and passes the
// verified tenant; nothing here is flag-gated (the preview writes nothing,
// and a re-queued invite waits for the flags), each answer says which flags
// are on.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { ONBOARDING_SESSION_ASSIGNEES, ONBOARDING_SESSION_TYPES } from "../../lib/onboarding-sessions.util.js";
import { previewOnboardingSessionPlan } from "../../services/onboarding-session-plan.service.js";
import { requeueOnboardingSessionCalendarSync } from "../../services/onboarding-calendar-sync.service.js";
import { deleteSession } from "../../services/onboardingSchedule.service.js";

const RESOURCE = "hr:onboarding";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  return user;
}

const draftSession = z.object({
  key: z.string().min(1).max(64).describe("Stable key, unique in the list"),
  title: z.string().min(1).describe("Session title"),
  sessionType: z.enum(ONBOARDING_SESSION_TYPES).describe("orientation | training | meeting | compliance"),
  dayOffset: z.coerce.number().int().describe("Working days from the start date (0 = day one)"),
  fromTime: z.string().optional().describe('Start "HH:MM"'),
  toTime: z.string().optional().describe('End "HH:MM"'),
  location: z.string().optional().describe("Room or meeting link"),
  required: z.boolean().optional().describe("Attendance is required"),
  assigneeType: z.enum(ONBOARDING_SESSION_ASSIGNEES).describe("HR | MANAGER | BUDDY | NEW_HIRE"),
});

export function registerOnboardingSessionPlanTools(server) {
  server.tool(
    "hr_onboarding_session_plan_preview",
    "Preview the orientation and compliance sessions a new hire starting on startDate would get: from the tenant's default onboarding template (or the baseline when it has none), a named template (templateId), or a draft list (sessions) before saving it. Each session's date is placed on a working day. Writes nothing.",
    {
      startDate: z.string().min(1).describe("The hire's start date, YYYY-MM-DD"),
      templateId: z.coerce.number().int().positive().optional().describe("Preview this template instead of the default"),
      sessions: z.array(draftSession).max(20).optional().describe("Preview this draft list instead of a stored template"),
    },
    withToolError(async ({ startDate, templateId, sessions }) => {
      const user = authorized("GET");
      const data = await previewOnboardingSessionPlan({ tenantId: user.tenantId, startDate, templateId: templateId ?? null, sessions });
      return text(data);
    }, "hr_onboarding_session_plan_preview"),
  );

  server.tool(
    "hr_onboarding_session_calendar_resync",
    "Queue one onboarding session for a fresh calendar invite through the Communication module (create, update, or cancel for a deleted session), resetting the retry count. Use after a FAILED invite once the cause (for example a missing email address) is fixed.",
    {
      sessionId: z.coerce.number().int().positive().describe("Onboarding session id"),
    },
    withToolError(async ({ sessionId }) => {
      const user = authorized("POST");
      const data = await requeueOnboardingSessionCalendarSync({ sessionId, tenantId: user.tenantId });
      return text(data);
    }, "hr_onboarding_session_calendar_resync"),
  );

  server.tool(
    "hr_onboarding_session_delete",
    "Delete an onboarding schedule session. A session with a calendar invite is hidden at once and removed after its calendar event is cancelled.",
    {
      id: z.coerce.number().int().positive().describe("Onboarding session id"),
    },
    withToolError(async ({ id }) => {
      const user = authorized("DELETE");
      const data = await deleteSession(id, user.tenantId);
      return text(data);
    }, "hr_onboarding_session_delete"),
  );
}

export default registerOnboardingSessionPlanTools;
