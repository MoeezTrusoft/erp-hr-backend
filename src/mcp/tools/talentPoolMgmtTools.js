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
import {
  listInvitations,
  respondToInvitation,
  segmentTalentPool,
  sweepTalentPoolRetention,
  withdrawInvitation,
} from "../../services/talentPoolInvitation.service.js";

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
    "Invite a talent-pool candidate to apply: opens an invitation (status INVITED with an expiry) and records an 'Invited to apply' note. Re-inviting while an invitation is open returns the SAME invitation. If a jobRequisitionId is given, also moves them into that job's pipeline.",
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

  // ── INVITATION LIFECYCLE (FR-10 residue) ────────────────────────────────
  server.tool(
    "hr_talent_pool_invitation_list",
    "List talent-pool invitations with status, expiry, answer and the derived 'expired' flag (newest first; optionally narrowed by status or candidate)",
    {
      status: z.enum(["INVITED", "ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"]).optional(),
      candidateId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    },
    withToolError(async ({ status, candidateId, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listInvitations({
        tenantId: user.tenantId,
        status: status ?? null,
        candidateId: candidateId ?? null,
        limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_invitation_list")
  );

  server.tool(
    "hr_talent_pool_invitation_respond",
    "Advance a talent-pool invitation: record the candidate's answer (ACCEPTED/DECLINED) or withdraw it. One-way — an answered invitation cannot be re-answered; re-inviting is a new invitation.",
    {
      invitationId: z.coerce.number().int().positive().describe("Invitation id (references TalentPoolInvitation)"),
      action: z.enum(["respond", "withdraw"]).describe("respond = the candidate's answer; withdraw = the recruiter pulls it back"),
      response: z.enum(["ACCEPTED", "DECLINED"]).optional().describe("Required when action=respond"),
      note: z.string().optional().describe("Answer note, or the withdrawal reason"),
    },
    withToolError(async ({ invitationId, action, response, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = action === "withdraw"
        ? await withdrawInvitation({ tenantId: user.tenantId, invitationId, reason: note })
        : await respondToInvitation({ tenantId: user.tenantId, invitationId, response, note });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_invitation_respond")
  );

  // ── SEGMENTATION (FR-10 residue) ────────────────────────────────────────
  server.tool(
    "hr_talent_pool_segment",
    "Segment talent-pool candidates by skills, location, source, experience and invitation state; reports how many matched and, per filter, why the rest were excluded",
    {
      poolNames: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional().describe("Any-of: a candidate with one of these skills is in the segment"),
      locations: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
      minExperienceYears: z.number().nonnegative().optional(),
      maxExperienceYears: z.number().nonnegative().optional(),
      invitedWithinDays: z.number().int().nonnegative().optional(),
      hasOpenInvitation: z.boolean().optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const { limit, ...filters } = args;
      const data = await segmentTalentPool({ tenantId: user.tenantId, filters, limit });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_segment")
  );

  // ── POOL RETENTION SWEEP (FR-10 residue) ────────────────────────────────
  server.tool(
    "hr_talent_pool_retention_sweep",
    "Sweep the TALENT_POOL retention clock: DRY RUN by default. Removes pool memberships whose clock has closed (never erases a candidate — that is the APPLICANT sweep's action) and reports legal-hold suspensions.",
    {
      asOf: z.string().optional().describe("ISO date to evaluate as of (defaults to now)"),
      dryRun: z.boolean().optional().describe("Defaults to true; apply mode is flag-gated (HR_RECRUITMENT_RETENTION_AUTOMATION)"),
      limit: z.coerce.number().int().positive().max(2000).optional(),
    },
    withToolError(async ({ asOf, dryRun, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await sweepTalentPoolRetention({
        tenantId: user.tenantId,
        asOf: asOf ? new Date(asOf) : new Date(),
        dryRun: dryRun !== false,
        limit,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_retention_sweep")
  );
}
