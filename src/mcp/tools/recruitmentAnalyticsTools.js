// src/mcp/tools/recruitmentAnalyticsTools.js
//
// Recruitment Analytics MCP surface — one read tool (computed KPIs) and one
// export tool (funnel + source effectiveness as a flat table). Both are
// tenant-scoped via the request context and gated on the `hr:recruitment` RBAC
// code (deny-by-default), matching the rest of the recruitment surface.
//
// Costs are actual configured spend or explicitly unavailable.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { exportRows } from "../../lib/export.util.js";
import { computeRecruitmentAnalytics, drillDownRecruitmentMetric } from "../../services/recruitmentAnalytics.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const today = () => new Date().toISOString().slice(0, 10);

export function registerRecruitmentAnalyticsTools(server) {
  server.tool(
    "hr_recruitment_analytics_get",
    "Compute tenant-scoped recruitment analytics: total hires, time-to-hire (days), offer acceptance rate, hiring funnel, source effectiveness, per-hire metrics, and actual configured cost-per-hire (unavailable when a filtered cohort has no cost allocation). Optional drill-down filters (FR-11): dateFrom/dateTo (ISO), requisitionIds, departmentId, stage, source.",
    {
      dateFrom: z.string().optional().describe("ISO date — include applications applied at or after this instant"),
      dateTo: z.string().optional().describe("ISO date — include applications applied at or before this instant"),
      requisitionIds: z.array(z.string()).optional().describe("Restrict to these requisition ids (numeric strings)"),
      departmentId: z.string().optional().describe("Restrict to this department id (numeric string)"),
      stage: z.string().optional().describe("Restrict to this current application stage (e.g. 'interview')"),
      source: z.string().optional().describe("Restrict to this candidate source string"),
    },
    withToolError(async ({ dateFrom, dateTo, requisitionIds, departmentId, stage, source }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const filters = {
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
        ...(requisitionIds?.length ? { requisitionIds: requisitionIds.map(Number) } : {}),
        ...(departmentId ? { departmentId: Number(departmentId) } : {}),
        ...(stage ? { stage } : {}),
        ...(source ? { source } : {}),
      };
      const data = await computeRecruitmentAnalytics(user.tenantId, filters);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_recruitment_analytics_get")
  );

  // NFR-12 reporting integrity — "allow drill-down to the data behind metrics".
  // Runs the SAME filter + fetch pipeline the metric payload used, so the rows
  // returned are the rows the number was computed from (never a parallel query
  // that can silently disagree with it).
  server.tool(
    "hr_recruitment_analytics_drilldown",
    "Return the ROW-LEVEL evidence behind one recruitment metric (NFR-12): pass the metric you are explaining plus the SAME filters the metric was computed with. Canonical metrics (totalHires, timeToFillDays, timeToFirstFillDays, timeToHireDays, stageConversion, dropOff, offerAcceptanceRate, sourceEffectiveness) or a group slice (funnel:<stage>, source:<name>, disposition:<code>). Returns the filter echo, total/returned counts, a truncated flag, and rows (applications, or requisitions for fill/rate metrics).",
    {
      metric: z.string().min(1).describe("Metric to explain, e.g. 'totalHires' or 'funnel:interview'"),
      dateFrom: z.string().optional().describe("Same filter the metric was computed with (ISO date)"),
      dateTo: z.string().optional().describe("Same filter the metric was computed with (ISO date)"),
      requisitionIds: z.array(z.string()).optional().describe("Same filter the metric was computed with"),
      departmentId: z.string().optional().describe("Same filter the metric was computed with"),
      stage: z.string().optional().describe("Same filter the metric was computed with"),
      source: z.string().optional().describe("Same filter the metric was computed with"),
      limit: z.string().optional().describe("Max rows to return (1-500); defaults to 100"),
    },
    withToolError(async ({ metric, dateFrom, dateTo, requisitionIds, departmentId, stage, source, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const filters = {
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
        ...(requisitionIds?.length ? { requisitionIds: requisitionIds.map(Number) } : {}),
        ...(departmentId ? { departmentId: Number(departmentId) } : {}),
        ...(stage ? { stage } : {}),
        ...(source ? { source } : {}),
      };
      const parsedLimit = Number(limit);
      const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100;
      const data = await drillDownRecruitmentMetric(user.tenantId, metric, filters, { limit: safeLimit });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_recruitment_analytics_drilldown")
  );

  server.tool(
    "hr_recruitment_analytics_export",
    "Export the recruitment hiring funnel + source effectiveness as a flat table (csv/pdf). Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf"]).default("csv"),
      dateFrom: z.string().optional(), dateTo: z.string().optional(), requisitionIds: z.array(z.string()).optional(), departmentId: z.string().optional(), stage: z.string().optional(), source: z.string().optional(),
    },
    withToolError(async ({ format, ...filters }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "EXPORT", "hr:recruitment", false);
      const analytics = await computeRecruitmentAnalytics(user.tenantId, filters, { method: "EXPORT" });

      // Flatten funnel (one row per stage) + source effectiveness (one row per
      // source) into a single labelled table.
      const rows = [
        ...(analytics.canonicalMetrics?.stageFunnel ?? Object.entries(analytics.hiringFunnel).map(([stage, entered])=>({stage,entered}))).map(({stage, entered:count}) => ({
          section: "Funnel",
          label: stage,
          candidates: count,
          hires: "",
        })),
        ...(analytics.canonicalMetrics?.sourceEffectiveness ?? analytics.sourceEffectiveness).map((s) => ({
          section: "Source",
          label: s.source,
          candidates: s.applications ?? s.candidates,
          hires: s.hires,
        })),
      ];

      const columns = [
        { key: "section", header: "Section" },
        { key: "label", header: "Stage / Source" },
        { key: "candidates", header: "Count" },
        { key: "hires", header: "Hires" },
      ];

      const out = await exportRows(format, {
        title: "Recruitment Analytics — Funnel & Source Effectiveness",
        subtitle: `${analytics.totalHires} hire(s) — generated ${today()} — filters: ${JSON.stringify(analytics.filters)}`,
        columns,
        rows,
      });

      const data = {
        format,
        fileName: `recruitment-analytics-${today()}.${out.ext}`,
        mimeType: out.mimeType,
        count: rows.length,
        filters: analytics.filters,
        metricsVersion: analytics.canonicalMetrics?.version ?? null,
        generatedAt: analytics.generatedAt,
        base64: out.buffer.toString("base64"),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_recruitment_analytics_export")
  );
}
