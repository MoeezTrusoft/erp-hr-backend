// src/mcp/tools/payrollConfigTools.js — Payroll Setup MCP tools.
//
// Facade over the three Payroll Setup services:
//   • Tax slabs        → payrollTaxSlab.service.js
//   • Cycle & Calendar → payrollCalendar.service.js
//   • Approval Matrix  → payrollApprovalMatrix.service.js
//
// All tools are gated on the C4 payroll resource `hr:payroll` (deny-by-default)
// with the standard method→action mapping, wrapped in withToolError, and thread
// the VERIFIED tenant (ctx.user.tenantId) into every service call. No console.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
    createTaxSlab,
    updateTaxSlab,
    deleteTaxSlab,
    listTaxSlabs,
} from "../../services/payrollTaxSlab.service.js";
import {
    getCalendar,
    upsertCalendar,
} from "../../services/payrollCalendar.service.js";
import {
    createApprovalLevel,
    updateApprovalLevel,
    deleteApprovalLevel,
    listApprovalLevels,
} from "../../services/payrollApprovalMatrix.service.js";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

const RESOURCE = "hr:payroll";

export function registerPayrollConfigTools(server) {
    // ── TAX SLABS ─────────────────────────────────────────────────────────────
    server.tool(
        "hr_tax_slab_create",
        "Create an income-tax slab (FBR-style bracket) for the payroll tax table",
        {
            countryCode: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code (2 letters, default PK) — TaxRate.countryCode"),
            bracketMin: z.number().describe("Slab lower bound / 'from' — taxable income at which this slab starts (≥0) — TaxRate.bracketMin"),
            bracketMax: z.number().nullable().optional().describe("Slab upper bound / 'upto' — must be > bracketMin; null (or omitted) for the open-ended top slab — TaxRate.bracketMax"),
            baseTax: z.number().optional().describe("Cumulative tax owed up to bracketMin (default 0) — TaxRate.baseTax"),
            rate: z.number().describe("Rate on the excess above bracketMin, as a fraction 0–1 (e.g. 0.15 = 15%). A value >1 is treated as a percent and divided by 100 — TaxRate.rate"),
            effectiveFrom: z.string().optional().describe("Effective-from date — ISO 8601 YYYY-MM-DD (defaults to now) — TaxRate.effectiveFrom"),
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Row status — one of ACTIVE | INACTIVE (default ACTIVE) — TaxRate.status"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
            const data = await createTaxSlab({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_tax_slab_create")
    );

    server.tool(
        "hr_tax_slab_update",
        "Update an existing income-tax slab",
        {
            id: z.coerce.number().int().positive().describe("TaxRate.id of the slab to update"),
            countryCode: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code (2 letters) — TaxRate.countryCode"),
            bracketMin: z.number().optional().describe("Slab lower bound / 'from' (≥0) — TaxRate.bracketMin"),
            bracketMax: z.number().nullable().optional().describe("Slab upper bound / 'upto' (> bracketMin), or null for the open-ended top slab — TaxRate.bracketMax"),
            baseTax: z.number().optional().describe("Cumulative tax owed up to bracketMin — TaxRate.baseTax"),
            rate: z.number().optional().describe("Rate on excess, fraction 0–1 (e.g. 0.15); >1 treated as percent/100 — TaxRate.rate"),
            effectiveFrom: z.string().optional().describe("Effective-from date — ISO 8601 YYYY-MM-DD — TaxRate.effectiveFrom"),
            effectiveTo: z.string().nullable().optional().describe("Effective-to date — ISO 8601 YYYY-MM-DD, or null to clear — TaxRate.effectiveTo"),
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Row status — one of ACTIVE | INACTIVE — TaxRate.status"),
        },
        withToolError(async ({ id, ...fields }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const data = await updateTaxSlab({ tenantId: user.tenantId, id, ...fields });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_tax_slab_update")
    );

    server.tool(
        "hr_tax_slab_delete",
        "Delete an income-tax slab",
        {
            id: z.coerce.number().int().positive().describe("TaxRate.id of the slab to delete"),
        },
        withToolError(async ({ id }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
            const data = await deleteTaxSlab({ tenantId: user.tenantId, id });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_tax_slab_delete")
    );

    server.tool(
        "hr_tax_slab_list",
        "List income-tax slabs (paginated), sorted for the FBR slab table",
        {
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Filter by row status — one of ACTIVE | INACTIVE — TaxRate.status"),
            countryCode: z.string().length(2).optional().describe("Filter by ISO 3166-1 alpha-2 country code (2 letters) — TaxRate.countryCode"),
            sortBy: z.enum(["from", "effectiveFrom", "status"]).optional().describe("Sort field — one of from (bracketMin, default) | effectiveFrom | status"),
            sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction — asc (default) | desc"),
            page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
            pageSize: z.coerce.number().int().positive().optional().describe("Rows per page (default 20, max 200)"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const data = await listTaxSlabs({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_tax_slab_list")
    );

    // ── CYCLE & CALENDAR ───────────────────────────────────────────────────────
    server.tool(
        "hr_payroll_calendar_get",
        "Get the tenant's payroll cycle & calendar config (singleton; defaults if unset)",
        {},
        withToolError(async () => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const data = await getCalendar({ tenantId: user.tenantId });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_payroll_calendar_get")
    );

    server.tool(
        "hr_payroll_calendar_upsert",
        "Create or update the tenant's payroll cycle & calendar (any edit re-drafts to DRAFT and bumps version)",
        {
            payFrequency: z.enum(["WEEKLY", "BI_WEEKLY", "SEMI_MONTHLY", "MONTHLY"]).optional().describe("Pay frequency — one of WEEKLY | BI_WEEKLY | SEMI_MONTHLY | MONTHLY (default MONTHLY) — PayrollCalendar.payFrequency"),
            periodStartAnchor: z.enum(["FIXED_DATE", "FIRST_OF_MONTH", "LAST_OF_MONTH"]).optional().describe("Period-start anchor — one of FIXED_DATE | FIRST_OF_MONTH | LAST_OF_MONTH (default FIRST_OF_MONTH) — PayrollCalendar.periodStartAnchor"),
            periodStartDate: z.string().nullable().optional().describe("Period-start date when anchor is FIXED_DATE — ISO 8601 YYYY-MM-DD — PayrollCalendar.periodStartDate"),
            periodEndAnchor: z.enum(["FIXED_DATE", "FIRST_OF_MONTH", "LAST_OF_MONTH"]).optional().describe("Period-end anchor — one of FIXED_DATE | FIRST_OF_MONTH | LAST_OF_MONTH (default LAST_OF_MONTH) — PayrollCalendar.periodEndAnchor"),
            periodEndDate: z.string().nullable().optional().describe("Period-end date when anchor is FIXED_DATE — ISO 8601 YYYY-MM-DD — PayrollCalendar.periodEndDate"),
            attendanceCutoff: z.string().nullable().optional().describe("Attendance cutoff datetime — ISO 8601; after this, shift/OT edits are locked — PayrollCalendar.attendanceCutoff"),
            approvalsClose: z.string().nullable().optional().describe("Approvals-close datetime — ISO 8601 — PayrollCalendar.approvalsClose"),
            payDateAnchor: z.enum(["FIXED_DATE", "FIRST_OF_MONTH", "LAST_OF_MONTH"]).optional().describe("Pay-date anchor — one of FIXED_DATE | FIRST_OF_MONTH | LAST_OF_MONTH (default LAST_OF_MONTH) — PayrollCalendar.payDateAnchor"),
            payDate: z.string().nullable().optional().describe("Pay date when anchor is FIXED_DATE — ISO 8601 YYYY-MM-DD (day-of-month is used) — PayrollCalendar.payDate"),
            payDateWeekendShift: z.boolean().optional().describe("If true (default), a pay date on Sat/Sun is pulled EARLIER to the nearest Friday — PayrollCalendar.payDateWeekendShift"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const data = await upsertCalendar({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_payroll_calendar_upsert")
    );

    // ── APPROVAL MATRIX ──────────────────────────────────────────────────────
    server.tool(
        "hr_approval_matrix_create",
        "Create a payroll approval level in the approval matrix",
        {
            level: z.coerce.number().int().describe("Approval level — higher number = higher authority — PayrollApprovalMatrix.level"),
            role: z.string().min(1).describe("Approving role name — PayrollApprovalMatrix.role"),
            approverId: z.coerce.number().int().positive().nullable().optional().describe("Specific approver Employee.id, optional — PayrollApprovalMatrix.approverId"),
            thresholdRequired: z.boolean().optional().describe("Whether this level engages only above thresholdAmount (default false) — PayrollApprovalMatrix.thresholdRequired"),
            thresholdAmount: z.number().nullable().optional().describe("Amount that triggers this level when thresholdRequired — PayrollApprovalMatrix.thresholdAmount"),
            autoEscalateAfter: z.string().nullable().optional().describe("SLA datetime after which the item auto-escalates — ISO 8601 — PayrollApprovalMatrix.autoEscalateAfter"),
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Row status — one of ACTIVE | INACTIVE (default ACTIVE) — PayrollApprovalMatrix.status"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
            const data = await createApprovalLevel({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_approval_matrix_create")
    );

    server.tool(
        "hr_approval_matrix_update",
        "Update a payroll approval level",
        {
            id: z.coerce.number().int().positive().describe("PayrollApprovalMatrix.id of the level to update"),
            level: z.coerce.number().int().optional().describe("Approval level — higher number = higher authority — PayrollApprovalMatrix.level"),
            role: z.string().min(1).optional().describe("Approving role name — PayrollApprovalMatrix.role"),
            approverId: z.coerce.number().int().positive().nullable().optional().describe("Specific approver Employee.id, or null to clear — PayrollApprovalMatrix.approverId"),
            thresholdRequired: z.boolean().optional().describe("Whether this level engages only above thresholdAmount — PayrollApprovalMatrix.thresholdRequired"),
            thresholdAmount: z.number().nullable().optional().describe("Amount that triggers this level, or null to clear — PayrollApprovalMatrix.thresholdAmount"),
            autoEscalateAfter: z.string().nullable().optional().describe("SLA datetime — ISO 8601, or null to clear — PayrollApprovalMatrix.autoEscalateAfter"),
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Row status — one of ACTIVE | INACTIVE — PayrollApprovalMatrix.status"),
        },
        withToolError(async ({ id, ...fields }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const data = await updateApprovalLevel({ tenantId: user.tenantId, id, ...fields });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_approval_matrix_update")
    );

    server.tool(
        "hr_approval_matrix_delete",
        "Delete a payroll approval level",
        {
            id: z.coerce.number().int().positive().describe("PayrollApprovalMatrix.id of the level to delete"),
        },
        withToolError(async ({ id }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
            const data = await deleteApprovalLevel({ tenantId: user.tenantId, id });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_approval_matrix_delete")
    );

    server.tool(
        "hr_approval_matrix_list",
        "List payroll approval levels (paginated), approver resolved to {id,name,avatar}",
        {
            status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Filter by row status — one of ACTIVE | INACTIVE — PayrollApprovalMatrix.status"),
            sortBy: z.enum(["level", "status"]).optional().describe("Sort field — one of level (default) | status"),
            sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction — asc (default) | desc"),
            page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
            pageSize: z.coerce.number().int().positive().optional().describe("Rows per page (default 20, max 200)"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const data = await listApprovalLevels({ tenantId: user.tenantId, ...args });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_approval_matrix_list")
    );
}
