// src/mcp/tools/onboardingDashboardTools.js — Onboarding Dashboard MCP tools.
//
// Four tools, all tenant-scoped via the verified user.tenantId (RBAC
// Company.uuid) and gated on hr:onboarding, following the
// getCtx → assertPermission → service(..., user.tenantId) pattern used by the
// existing onboarding + org-chart tools:
//   hr_onboarding_dashboard_get    — summary + paginated dashboard list (GET)
//   hr_onboarding_add_new_hire     — create a checklist for a new hire (POST)
//   hr_onboarding_export           — export the dashboard list csv/pdf/png (GET)
//   hr_onboarding_quick_progress   — per-checklist progress popover (GET)
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { exportRows } from "../../lib/export.util.js";
import {
  getOnboardingDashboard,
  addNewHire,
  getOnboardingExportRows,
  getQuickProgress,
  EXPORT_COLUMNS,
} from "../../services/onboardingDashboard.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const today = () => new Date().toISOString().slice(0, 10);

export function registerOnboardingDashboardTools(server) {
  server.tool(
    "hr_onboarding_dashboard_get",
    "Onboarding dashboard: returns { summary:{ total, completed, inProgress, notStarted, overdue }, items:[{ id, employeeId, newHireName, role, department, startDate, stage, currentStage, manager, progress, members, readyToCollect, status }], page, pageSize, total, totalPages, sort, order, filters }. Supports page/pageSize, q (name/title), status, department or businessUnitId, and sort (startDate|status|progress).",
    {
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().optional(),
      q: z.string().optional().describe("Search by new-hire name or checklist title"),
      status: z.string().optional().describe("NOT_STARTED|IN_PROGRESS|COMPLETED|OVERDUE"),
      department: z.string().optional().describe("Business unit name filter"),
      businessUnitId: z.union([z.number(), z.string()]).optional(),
      sort: z.enum(["startDate", "status", "progress"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await getOnboardingDashboard(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_dashboard_get")
  );

  server.tool(
    "hr_onboarding_add_new_hire",
    "Add a new hire to the onboarding dashboard: creates an OnboardingChecklist (status NOT_STARTED, stage pre_joining) and seeds default tasks for the chosen template. Returns the created checklist with employee + tasks.",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee id"),
      startDate: z.string().describe("ISO 8601 date"),
      department: z.string().optional(),
      managerId: z.union([z.number(), z.string()]).optional(),
      template: z.string().optional().describe("default|engineering|sales (drives seeded tasks)"),
      members: z
        .array(z.object({ employeeId: z.union([z.number(), z.string()]), name: z.string().optional(), role: z.string().optional() }))
        .optional()
        .describe("Assigned onboarding team members"),
      title: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:onboarding", user.isAdmin);
      const data = await addNewHire(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_add_new_hire")
  );

  server.tool(
    "hr_onboarding_export",
    "Export the onboarding dashboard list as csv/pdf/png. Columns: New Hire, Role, Department, Manager, Start Date, Stage, Progress, Status. Accepts the same filters as the dashboard (q/status/department/businessUnitId/sort/order). Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf", "png"]).default("csv"),
      q: z.string().optional(),
      status: z.string().optional(),
      department: z.string().optional(),
      businessUnitId: z.union([z.number(), z.string()]).optional(),
      sort: z.enum(["startDate", "status", "progress"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async ({ format, ...filters }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const rows = await getOnboardingExportRows(filters, user.tenantId);
      const out = await exportRows(format, {
        title: "Onboarding Dashboard",
        subtitle: `${rows.length} new hire(s) — generated ${today()}`,
        columns: EXPORT_COLUMNS,
        rows,
      });
      const data = {
        format,
        fileName: `onboarding-dashboard-${today()}.${out.ext}`,
        mimeType: out.mimeType,
        count: rows.length,
        base64: out.buffer.toString("base64"),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_export")
  );

  server.tool(
    "hr_onboarding_quick_progress",
    "Quick-progress popover for one onboarding checklist: returns { id, newHireName, progress, tasksTotal, tasksDone, byStage:[{ stage, total, done }] }.",
    {
      id: z.union([z.number(), z.string()]).describe("Onboarding checklist id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await getQuickProgress(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_onboarding_quick_progress")
  );
}
