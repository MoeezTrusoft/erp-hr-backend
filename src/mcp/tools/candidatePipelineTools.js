import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import {
  getPipelineBoard,
  listPipelineCards,
} from "../../services/candidatePipeline.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerCandidatePipelineTools(server) {
  // ── KANBAN BOARD ─────────────────────────────────────────────────────────
  // Read-only projection of applications into stage columns for the recruitment
  // pipeline (Kanban) screen. Stage/status MOVES are NOT done here — use the
  // existing hr_application_update_stage (drag between columns) and
  // hr_application_update_status (reject → status/stage rejected) tools.
  server.tool(
    "hr_candidate_pipeline_get",
    "Candidate recruitment pipeline as a Kanban board (stage columns with candidate cards)",
    {
      q: z.string().optional().describe("Search candidate name or email"),
      requisitionId: z.union([z.string(), z.number()]).optional().describe("Filter by job requisition id"),
      source: z.string().optional().describe("Filter by candidate source (e.g. LinkedIn, Referral)"),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort cards by appliedAt (default desc)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getPipelineBoard({
        tenantId: user.tenantId,
        q: args.q,
        requisitionId: args.requisitionId,
        source: args.source,
        sort: args.sort,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_pipeline_get")
  );

  // ── FLAT LIST VARIANT ────────────────────────────────────────────────────
  // Same cards as the board, paginated + optionally narrowed to one stage.
  // Returns the standard list envelope (buildListPayload).
  server.tool(
    "hr_candidate_pipeline_list",
    "Candidate recruitment pipeline as a flat paginated list of candidate cards",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      q: z.string().optional().describe("Search candidate name or email"),
      requisitionId: z.union([z.string(), z.number()]).optional().describe("Filter by job requisition id"),
      source: z.string().optional().describe("Filter by candidate source"),
      stage: z
        .enum(["applied", "screening", "interview", "offer", "hired", "rejected"])
        .optional()
        .describe("Filter to a single pipeline stage"),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort by appliedAt (default desc)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const { items, total, page, pageSize } = await listPipelineCards({
        tenantId: user.tenantId,
        q: args.q,
        requisitionId: args.requisitionId,
        source: args.source,
        stage: args.stage,
        sort: args.sort,
        page: args.page,
        pageSize: args.pageSize,
      });
      const payload = buildListPayload({
        items,
        page,
        pageSize,
        total,
        sort: "appliedAt",
        order: args.sort === "asc" ? "asc" : "desc",
        filters: {
          q: args.q ?? null,
          requisitionId: args.requisitionId ?? null,
          source: args.source ?? null,
          stage: args.stage ?? null,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }, "hr_candidate_pipeline_list")
  );
}
