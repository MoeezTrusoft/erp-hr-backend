// src/mcp/tools/talentPoolMgmtTools.js
//
// Talent Pool MANAGEMENT MCP tools. These wrap talentPoolMgmt.service.js and
// follow the recruitmentTools.js conventions: local getCtx() over the mcpCtx
// AsyncLocalStorage store, deny-by-default assertPermission on hr:recruitment,
// withToolError envelope, and a tenant-scoped service call.
//
// EXISTING (owned by recruitmentTools.js — NOT duplicated here):
//   hr_talent_pool_add    — add a candidate to a pool
//   hr_talent_pool_remove — remove a membership from a pool
//   hr_talent_pool_list   — resource-style pool listing

import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { toListEnvelope } from "../utils/listEnvelope.js";
import {
  listManagedPool,
  getPoolProfile,
  moveToPipeline,
  inviteCandidate,
} from "../../services/talentPoolMgmt.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTalentPoolMgmtTools(server) {
  // ── LIST ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_manage_list",
    "List talent-pool members (paginated) with derived role, department, experience and skills for the HR talent-pool management screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      q: z.string().optional().describe("Filter by candidate name (first/last, case-insensitive)"),
      filter: z.string().optional().describe("Filter by poolName"),
      sort: z.string().optional().describe("Sort field (addedAt)"),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listManagedPool({
        tenantId: user.tenantId,
        q: args.q,
        poolName: args.filter,
        sort: args.sort,
        order: args.order,
        page: args.page,
        limit: args.pageSize,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }],
      };
    }, "hr_talent_pool_manage_list")
  );

  // ── PROFILE ────────────────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_profile_get",
    "Get a consolidated talent-pool candidate profile: contact, previous roles applied, avg interview score, last interview date, notes and skills",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate id"),
    },
    withToolError(async ({ candidateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getPoolProfile({ candidateId, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_profile_get")
  );

  // ── MOVE TO PIPELINE ───────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_move_to_pipeline",
    "Move a talent-pool candidate into a job's pipeline by creating an application (stage applied, status open). No-op if the candidate already has an application for that requisition.",
    {
      candidateId: z.coerce.number().int().positive().describe("Candidate id (references Candidate)"),
      jobRequisitionId: z.coerce.number().int().positive().describe("Job requisition id (references JobRequisition)"),
    },
    withToolError(async ({ candidateId, jobRequisitionId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await moveToPipeline({
        candidateId,
        jobRequisitionId,
        tenantId: user.tenantId,
        addedById: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_move_to_pipeline")
  );

  // ── INVITE ─────────────────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_invite",
    "Invite a talent-pool candidate to apply: records an 'Invited to apply' note on the pool membership (or candidate). If a jobRequisitionId is given, also moves them into that job's pipeline.",
    {
      candidateId: z.coerce.number().int().positive().describe("Candidate id (references Candidate)"),
      jobRequisitionId: z.coerce.number().int().positive().optional().describe("Optional job requisition id (references JobRequisition); when given, also moves the candidate into that job's pipeline"),
    },
    withToolError(async ({ candidateId, jobRequisitionId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await inviteCandidate({
        candidateId,
        jobRequisitionId,
        tenantId: user.tenantId,
        addedById: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_invite")
  );
}
