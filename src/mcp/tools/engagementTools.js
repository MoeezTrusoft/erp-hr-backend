// src/mcp/tools/engagementTools.js — Engagement Context Engine MCP facade.
//
// Tools: hr_engagement_* (see src/services/engagement/handlers.js for the
// shared handler map, input schemas and descriptions). REST parity router:
// src/routes/engagement.routes.js (same handlers).
//
// Every handler asserts the hr:engagement entitlement (VIEW for reads, CREATE
// for ingest/generate/propose, EDIT for updates/transitions/sync) on the
// VERIFIED service-JWT scope, inside a tenantTransaction (FORCE RLS).
import { INPUTS, TOOL_DESCRIPTIONS, handlers } from "../../services/engagement/handlers.js";
import { withToolError } from "../utils/toolError.js";

const asText = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

export const engagementHandlers = handlers;

export function registerEngagementTools(server) {
  for (const [name, handler] of Object.entries(handlers)) {
    const schema = INPUTS[name];
    server.tool(
      name,
      TOOL_DESCRIPTIONS[name],
      schema.shape,
      withToolError(async (raw) => asText(await handler(raw ?? {})), name),
    );
  }
}
