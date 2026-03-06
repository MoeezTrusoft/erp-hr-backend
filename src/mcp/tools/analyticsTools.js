import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerAnalyticsTools(server) {
  // ── RESOURCES (all analytics dashboards and reports as read resources) ───

  server.resource(
    "hr_analytics_dashboard_overview",
    "hr://analytics/dashboards/overview",
    { description: "HR dashboard overview KPIs (headcount, turnover, open positions)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/dashboards/overview", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_dashboard_recruitment",
    "hr://analytics/dashboards/recruitment",
    { description: "Recruitment dashboard metrics (pipeline, time-to-hire)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/dashboards/recruitment", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_dashboard_performance",
    "hr://analytics/dashboards/performance",
    { description: "Performance management dashboard metrics" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/dashboards/performance", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_headcount",
    "hr://analytics/reports/headcount",
    { description: "Headcount report by department, location, and employment type" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/headcount", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_turnover",
    "hr://analytics/reports/turnover",
    { description: "Employee turnover report" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/turnover", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_salary",
    "hr://analytics/reports/salary",
    { description: "Salary distribution and compensation report" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/salary", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_leave_balances",
    "hr://analytics/reports/leave-balances",
    { description: "Leave balance summary report across all employees" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/leave-balances", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_absence",
    "hr://analytics/reports/absence",
    { description: "Absence and attendance report" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/absence", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_eeo",
    "hr://analytics/reports/eeo",
    { description: "Equal employment opportunity (EEO) compliance report" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/eeo", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_analytics_report_recruitment_pipeline",
    "hr://analytics/reports/recruitment-pipeline",
    { description: "Recruitment pipeline analytics report" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/analytics/reports/recruitment-pipeline", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
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
      assertPermission(permissions, "POST", "/hr/api/analytics/reports/export", user.isAdmin);
      const data = await self("POST", "/api/analytics/reports/export", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
