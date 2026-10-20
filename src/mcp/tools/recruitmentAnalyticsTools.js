// src/mcp/tools/recruitmentAnalyticsTools.js
//
// Recruitment Analytics MCP surface — one read tool (computed KPIs) and one
// export tool (funnel + source effectiveness as a flat table). Both are
// tenant-scoped via the request context and gated on the `hr:recruitment` RBAC
// code (deny-by-default), matching the rest of the recruitment surface.
//
// Phase 5 — no illustrative figures: every number comes from the tenant's rows.
// Cost per hire is actual spend (the tenant's cost configuration plus referral
// bonuses paid) or null with a reason; any metric with no data is null and the
// payload's `reasons` map (or the metric's own `reason`) says why.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { exportRows } from "../../lib/export.util.js";
import { assertNoAgencyExport, assertNotAgencyCaller } from "../../lib/agency-access.util.js";
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
    "Compute tenant-scoped recruitment analytics from live data only: total hires, time-to-hire (days), offer acceptance rate, hiring funnel, source effectiveness, per-hire metrics, actual cost per hire and its breakdown (null with a reason when no cost configuration exists or a filter is applied), plus the canonical block (time to fill, time to start, recruiter workload, SLA aging, ...). A metric with no data is null and `reasons` says why. Optional filters (FR-11): dateFrom/dateTo (ISO), requisitionIds, departmentId, stage, source.",
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
      assertNotAgencyCaller(user);
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
    "Return the ROW-LEVEL evidence behind one recruitment metric (NFR-12): pass the metric you are explaining plus the SAME filters the metric was computed with. Canonical metrics (totalHires, timeToFillDays, timeToFirstFillDays, timeToHireDays, stageConversion, dropOff, offerAcceptanceRate, sourceEffectiveness, timeToStartDays, recruiterWorkload, costPerHire) or a group slice (funnel:<stage>, source:<name>, disposition:<code>). Returns the filter echo, total/returned counts, a truncated flag, and rows (applications; requisitions for fill metrics; offers for acceptance; hires for time to start and cost per hire, with the cost components; recruiters for workload).",
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
      assertNotAgencyCaller(user);
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
    },
    withToolError(async ({ format }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      assertNoAgencyExport(user);
      const analytics = await computeRecruitmentAnalytics(user.tenantId);

      // Flatten funnel (one row per stage) + source effectiveness (one row per
      // source) into a single labelled table.
      const rows = [
        ...Object.entries(analytics.hiringFunnel).map(([stage, count]) => ({
          section: "Funnel",
          label: stage,
          candidates: count,
          hires: "",
        })),
        ...analytics.sourceEffectiveness.map((s) => ({
          section: "Source",
          label: s.source,
          candidates: s.candidates,
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
        subtitle: `${analytics.totalHires} hire(s) — generated ${today()}`,
        columns,
        rows,
      });

      const data = {
        format,
        fileName: `recruitment-analytics-${today()}.${out.ext}`,
        mimeType: out.mimeType,
        count: rows.length,
        base64: out.buffer.toString("base64"),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_recruitment_analytics_export")
  );
}
