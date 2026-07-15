// src/mcp/tools/onboardingPortalTools.js — MCP facade for the onboarding
// pre-boarding portal: readiness board, new-hire feedback, and notes/activity.
//
// Thin adapters over onboardingPortal.service.js. Every tool resolves the
// request context, asserts the hr:onboarding permission for its HTTP method,
// and threads the VERIFIED tenant (user.tenantId) into the service so reads and
// writes stay fail-closed tenant-scoped. Actor for note-add is the caller's
// employeeId (falling back to email) from that same verified context.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getPreboarding,
  updatePreboarding,
  submitFeedback,
  viewFeedback,
  addNote,
  listActivity,
} from "../../services/onboardingPortal.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOnboardingPortalTools(server) {
  server.tool(
    "hr_onboarding_preboarding_get",
    "Get the pre-boarding readiness board for an onboarding checklist (4 grouped boolean checklists + a completion summary)",
    {
      id: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await getPreboarding(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_preboarding_get")
  );

  server.tool(
    "hr_onboarding_preboarding_update",
    "Update the pre-boarding board — either a single { group, key, value } toggle or a full `preboarding` object. Recomputes readyToCollect and returns the refreshed board.",
    {
      id: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
      group: z.enum(["readiness", "itSetup", "engagement", "workspace"]).optional(),
      key: z.string().optional().describe("Item key within the group"),
      value: z.boolean().optional().describe("New boolean value for the item"),
      preboarding: z
        .record(z.string(), z.record(z.string(), z.boolean()))
        .optional()
        .describe("Full preboarding object (the 4 groups of booleans)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const data = await updatePreboarding(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_preboarding_update")
  );

  server.tool(
    "hr_onboarding_feedback_submit",
    "Submit new-hire onboarding feedback (role clarity / team support / onboarding process ratings + comments) for a checklist",
    {
      checklistId: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
      employeeId: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Defaults to the checklist's new hire when omitted"),
      ratings: z
        .object({
          roleClarity: z.union([z.number(), z.string()]).optional(),
          teamSupport: z.union([z.number(), z.string()]).optional(),
          onboardingProcess: z.union([z.number(), z.string()]).optional(),
        })
        .passthrough(),
      comments: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await submitFeedback(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_feedback_submit")
  );

  server.tool(
    "hr_onboarding_feedback_view",
    "View submitted onboarding feedback for a checklist, shaped as a table (candidate, role, ratings, comments, submittedAt)",
    {
      checklistId: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
    },
    withToolError(async ({ checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await viewFeedback(checklistId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_feedback_view")
  );

  server.tool(
    "hr_onboarding_note_add",
    "Append a note to an onboarding checklist's activity log",
    {
      checklistId: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
      text: z.string().min(1),
    },
    withToolError(async ({ checklistId, text }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:onboarding", user.isAdmin);
      const actor = user.employeeId || user.email || "system";
      const data = await addNote({ checklistId, text, actor }, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_note_add")
  );

  server.tool(
    "hr_onboarding_activity_list",
    "List an onboarding checklist's activity log newest-first, with entries grouped by day (Today / Yesterday / date)",
    {
      checklistId: z.union([z.string(), z.number()]).describe("Onboarding checklist id"),
    },
    withToolError(async ({ checklistId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await listActivity(checklistId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_activity_list")
  );
}
