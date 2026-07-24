// Payroll Setup — "Test on a payslip" MCP tool.
//
// Exposes a NON-persisting payslip preview: it computes a full payslip for one
// employee from the current/DRAFT payroll config (salary components, tax slabs,
// pay rules) entirely in memory. Nothing is written — no payroll run, no
// payslip row, no outbox event.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { previewPayslip } from "../../services/payrollPreview.service.js";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

export function registerPayrollPreviewTools(server) {
    server.tool(
        "hr_payroll_test_payslip",
        "Preview a full payslip for ONE employee from the current/draft payroll config " +
            "(salary components, tax slabs, pay rules) WITHOUT persisting anything — no " +
            "payroll run, no payslip row, no events. Use it to sanity-check Payroll Setup.",
        {
            employeeId: z.coerce
                .number()
                .int()
                .describe("Employee.id to compute the preview payslip for (required)."),
            daysWorked: z.coerce
                .number()
                .int()
                .optional()
                .describe("Days actually worked in the period. Defaults to workingDays."),
            workingDays: z.coerce
                .number()
                .int()
                .optional()
                .describe("Total working days in the period. Defaults to 26."),
            lwpDays: z.coerce
                .number()
                .int()
                .optional()
                .describe("Leave-without-pay days used for LWP recovery. Defaults to 0."),
        },
        withToolError(async ({ employeeId, daysWorked, workingDays, lwpDays }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", "hr:payroll", user.isAdmin);
            const data = await previewPayslip({
                tenantId: user.tenantId,
                employeeId,
                daysWorked,
                workingDays,
                lwpDays,
            });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_payroll_test_payslip")
    );
}
