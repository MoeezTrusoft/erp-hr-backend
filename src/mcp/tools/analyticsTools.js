import { z } from "zod";
import {
  mcpExportAnalyticsReport,
  mcpGetAnalyticsAbsence,
  mcpGetAnalyticsDashboardOverview,
  mcpGetAnalyticsDashboardPerformance,
  mcpGetAnalyticsDashboardRecruitment,
  mcpGetAnalyticsEeo,
  mcpGetAnalyticsHeadcount,
  mcpGetAnalyticsLeaveBalances,
  mcpGetAnalyticsRecruitmentPipeline,
  mcpGetAnalyticsSalary,
  mcpGetAnalyticsTurnover,
} from "../controllers/analyticsMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// IC-15 — every analytics resource/report is gated by the single RBAC code
// `hr:analytics` (VIEW). Previously the read resources carried NO MCP-boundary
// permission check (deny-by-default violation) and instead leaned on hard-coded
// role-name lists buried in the controllers — which 403'd a holder of
// hr:analytics whose role wasn't literally HR_ADMIN/HR_MANAGER/RECRUITER (e.g.
// the super-admin RBAC_ADMIN). Gating on the actual granted code is the
// IC-2/IC-4-class fix: deny-by-default for non-holders, allow every holder.
const ANALYTICS_RESOURCE_CODE = "hr:analytics";

export function registerAnalyticsTools(server) {
  // ── RESOURCES (all analytics dashboards and reports as read resources) ───

  // Wrap a resource loader with the hr:analytics:VIEW gate (deny-by-default).
  const analyticsResource = (loader) => async (uri) => {
    const { user, permissions } = getCtx();
    assertPermission(permissions, "GET", ANALYTICS_RESOURCE_CODE, user.isAdmin);
    const data = await loader(user);
    return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
  };

  server.resource(
    "hr_analytics_dashboard_overview",
    "hr://analytics/dashboards/overview",
    { description: "HR dashboard overview KPIs (headcount, turnover, open positions)" },
    analyticsResource(mcpGetAnalyticsDashboardOverview)
  );

  server.resource(
    "hr_analytics_dashboard_recruitment",
    "hr://analytics/dashboards/recruitment",
    { description: "Recruitment dashboard metrics (pipeline, time-to-hire)" },
    analyticsResource(mcpGetAnalyticsDashboardRecruitment)
  );

  server.resource(
    "hr_analytics_dashboard_performance",
    "hr://analytics/dashboards/performance",
    { description: "Performance management dashboard metrics" },
    analyticsResource(mcpGetAnalyticsDashboardPerformance)
  );

  server.resource(
    "hr_analytics_report_headcount",
    "hr://analytics/reports/headcount",
    { description: "Headcount report by department, location, and employment type" },
    analyticsResource(mcpGetAnalyticsHeadcount)
  );

  server.resource(
    "hr_analytics_report_turnover",
    "hr://analytics/reports/turnover",
    { description: "Employee turnover report" },
    analyticsResource(mcpGetAnalyticsTurnover)
  );

  server.resource(
    "hr_analytics_report_salary",
    "hr://analytics/reports/salary",
    { description: "Salary distribution and compensation report" },
    analyticsResource(mcpGetAnalyticsSalary)
  );

  server.resource(
    "hr_analytics_report_leave_balances",
    "hr://analytics/reports/leave-balances",
    { description: "Leave balance summary report across all employees" },
    analyticsResource(mcpGetAnalyticsLeaveBalances)
  );

  server.resource(
    "hr_analytics_report_absence",
    "hr://analytics/reports/absence",
    { description: "Absence and attendance report" },
    analyticsResource(mcpGetAnalyticsAbsence)
  );

  server.resource(
    "hr_analytics_report_eeo",
    "hr://analytics/reports/eeo",
    { description: "Equal employment opportunity (EEO) compliance report" },
    analyticsResource(mcpGetAnalyticsEeo)
  );

  server.resource(
    "hr_analytics_report_recruitment_pipeline",
    "hr://analytics/reports/recruitment-pipeline",
    { description: "Recruitment pipeline analytics report" },
    analyticsResource(mcpGetAnalyticsRecruitmentPipeline)
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_analytics_export_report",
    "Export an analytics report in a specified format",
    {
      reportType: z.string().min(1).describe("e.g. headcount, turnover, salary, leave-balances"),
      format: z.enum(["CSV", "EXCEL", "PDF"]).default("CSV"),
      filters: z.record(z.string(), z.unknown()).optional().describe("Optional filters (date range, departments, etc.)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      // IC-15 — was gated on the path `/hr/api/analytics/reports/export`, a key
      // the gateway never grants (it grants the code `hr:analytics`), so export
      // 403'd for every legitimate holder. Gate on the granted code instead.
      assertPermission(permissions, "POST", ANALYTICS_RESOURCE_CODE, user.isAdmin);
      const data = await mcpExportAnalyticsReport(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

}
