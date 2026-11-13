// src/mcp/tools/auditTrailTools.js
//
// HR Reports → Audit Trail MCP tool. Proxies the central erp-audit service
// (auditTrail.service → audit.client) and maps its events to the FE audit-trail
// table. Reuses the SAME resourceKey as the other Reports/compliance surfaces
// (hr:compliance) so entitlement wiring is shared. Read-only → gates on GET
// (VIEW). Every zod field carries an ERP-grade .describe(); the handler is
// wrapped in withToolError.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getAuditTrail } from "../../services/auditTrail.service.js";

// Same resourceKey as reportsTools.js / complianceTools.js.
const RESOURCE_KEY = "hr:compliance";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

export function registerAuditTrailTools(server) {
    server.tool(
        "hr_audit_trail_list",
        "Paginated, filtered and sorted Audit Trail for the HR Reports screen. Proxies the central erp-audit stream (already tenant-scoped) and maps each event to a row: timestamp, actor (resolved to the employee name for numeric user actors, else the raw actor id such as a service name), entity/action parsed from the event name, HR-local role (job_title) and the raw event payload for detail rendering.",
        {
            q: z
                .string()
                .optional()
                .describe("Free-text search (case-insensitive) across user, entity, action and full event name."),
            entity: z
                .string()
                .optional()
                .describe("Filter to a single entity (exact, case-insensitive) — the 2nd dotted segment of the event name, e.g. employee | attendance | document."),
            action: z
                .string()
                .optional()
                .describe("Filter to a single action (exact, case-insensitive) — the prettified 3rd dotted segment of the event name, e.g. lifecycle | recorded | expiry reminder."),
            actorId: z
                .string()
                .optional()
                .describe("Filter the upstream audit query to a single actor id (an employee id string like \"9\" or a service name like \"erp-hr\")."),
            since: z
                .string()
                .optional()
                .describe("ISO-8601 lower bound (inclusive) on the event occurredAt time."),
            until: z
                .string()
                .optional()
                .describe("ISO-8601 upper bound on the event occurredAt time."),
            sortBy: z
                .enum(["timestamp", "user", "entity", "action"])
                .optional()
                .describe("Sort column — one of: timestamp (default, by event time) | user | entity | action."),
            sortDir: z
                .enum(["asc", "desc"])
                .optional()
                .describe("Sort direction — desc (default; newest first for timestamp) | asc."),
            page: z.coerce
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-based page number (default 1)."),
            pageSize: z.coerce
                .number()
                .int()
                .positive()
                .optional()
                .describe("Rows per page (default 20, maximum 100)."),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
            const data = await getAuditTrail({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_audit_trail_list")
    );
}
