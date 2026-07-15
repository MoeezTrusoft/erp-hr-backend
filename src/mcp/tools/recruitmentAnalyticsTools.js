// src/mcp/tools/recruitmentAnalyticsTools.js
//
// Recruitment Analytics MCP surface — one read tool (computed KPIs) and one
// export tool (funnel + source effectiveness as a flat table). Both are
// tenant-scoped via the request context and gated on the `hr:recruitment` RBAC
// code (deny-by-default), matching the rest of the recruitment surface.
//
// IMPORTANT: every cost figure returned here is ILLUSTRATIVE (fixed constants,
// not DB spend) — the payload carries `illustrativeCostData: true` and each
// cost object carries `costModel: "illustrative"`. All other metrics (hires,
// funnel, time-to-hire, offer-acceptance, source effectiveness) are real.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { exportRows } from "../../lib/export.util.js";
import { computeRecruitmentAnalytics } from "../../services/recruitmentAnalytics.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const today = () => new Date().toISOString().slice(0, 10);

export function registerRecruitmentAnalyticsTools(server) {
  server.tool(
    "hr_recruitment_analytics_get",
    "Compute tenant-scoped recruitment analytics: total hires, time-to-hire (days), offer acceptance rate, hiring funnel, source effectiveness, per-hire metrics, and an ILLUSTRATIVE cost-per-hire / cost breakdown (constants, not DB spend — flagged illustrativeCostData:true).",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await computeRecruitmentAnalytics(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_recruitment_analytics_get")
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
