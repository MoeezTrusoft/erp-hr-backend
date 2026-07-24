// src/mcp/tools/reportsTools.js
//
// HR Reports → Document Expiry Alerts MCP tools. Reuses the SAME resourceKey as
// the compliance/document-expiry surface (hr:compliance) so the entitlement
// wiring is shared with complianceTools.js. Reads gate on GET (VIEW); the
// send-reminder write gates on POST (CREATE). Every zod field carries an
// ERP-grade .describe(); each tool is wrapped in withToolError.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
    getDocumentExpiryKpis,
    listExpiringDocuments,
    sendDocumentExpiryReminder,
    getDocumentForView,
} from "../../services/documentExpiryReport.service.js";

// Same resourceKey as complianceTools.js document/compliance reads.
const RESOURCE_KEY = "hr:compliance";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

export function registerReportsTools(server) {
    server.tool(
        "hr_document_expiry_kpis",
        "Document Expiry Alerts KPI counts (expired / expiring in 30-60-90 days / healthy / total) across all employee documents that have a parseable expiry date.",
        {},
        withToolError(async () => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
            const data = await getDocumentExpiryKpis({ tenantId: user.tenantId });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_document_expiry_kpis")
    );

    server.tool(
        "hr_document_expiry_list",
        "Paginated, filtered and sorted list of expiring employee documents for the Document Expiry Alerts report.",
        {
            q: z
                .string()
                .optional()
                .describe("Free-text search (case-insensitive) across employee name, document name, department and location."),
            status: z
                .enum(["expired", "active"])
                .optional()
                .describe("Filter by document status — one of: expired (expiry date is in the past) | active (expiry date is now or in the future)."),
            department: z
                .string()
                .optional()
                .describe("Filter to documents whose employee's department (BusinessUnit name) contains this value (case-insensitive)."),
            location: z
                .string()
                .optional()
                .describe("Filter to documents whose employee location (city, country — or region name fallback) contains this value (case-insensitive)."),
            sortBy: z
                .enum(["expiry", "employee", "document", "department", "status"])
                .optional()
                .describe("Sort column — one of: expiry (default, by expiry date) | employee (employee name) | document (document name) | department | status."),
            sortDir: z
                .enum(["asc", "desc"])
                .optional()
                .describe("Sort direction — asc (default; for expiry this is soonest-expiring first) | desc."),
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
            const data = await listExpiringDocuments({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_document_expiry_list")
    );

    server.tool(
        "hr_document_expiry_send_reminder",
        "Send a manual document-expiry reminder for one employee document. Records a DocumentExpiryAlert and emits hr.document.expiry_reminder.v1; the in-app notification is produced downstream by notification-hub if it maps that event. Email is disabled at the source.",
        {
            employeeMediaId: z.coerce
                .number()
                .int()
                .positive()
                .describe("Required. The EmployeeMedia document id to send the expiry reminder for (references EmployeeMedia.id)."),
            message: z
                .string()
                .optional()
                .describe("Optional custom reminder message included in the emitted event payload."),
        },
        withToolError(async ({ employeeMediaId, message }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", RESOURCE_KEY, user.isAdmin);
            const actor = {
                userId: user.userId,
                email: user.email,
                employeeId: user.employeeId,
                correlationId: getCtx().correlationId,
            };
            const data = await sendDocumentExpiryReminder({
                tenantId: user.tenantId,
                employeeMediaId,
                message,
                actor,
            });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_document_expiry_send_reminder")
    );

    server.tool(
        "hr_document_view",
        "Fetch the metadata needed to view/download an employee document — the EmployeeMedia meta plus fail-soft DAM asset metadata and a download-url fallback.",
        {
            employeeMediaId: z.coerce
                .number()
                .int()
                .positive()
                .describe("Required. The EmployeeMedia document id to view (references EmployeeMedia.id)."),
        },
        withToolError(async ({ employeeMediaId }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE_KEY, user.isAdmin);
            const data = await getDocumentForView({ tenantId: user.tenantId, employeeMediaId });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_document_view")
    );
}
