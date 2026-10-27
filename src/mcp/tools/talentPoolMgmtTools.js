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
import { talentPoolCampaign } from "../../services/talentPoolCampaign.service.js";
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
  if (!ctx?.user)
    throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTalentPoolMgmtTools(server) {
  // ── LIST ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_manage_list",
    "List talent-pool members (paginated) with derived role, department, experience and skills for the HR talent-pool management screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(100).optional(),
      q: z
        .string()
        .optional()
        .describe("Filter by candidate name (first/last, case-insensitive)"),
      filter: z.string().optional().describe("Filter by poolName"),
      department: z.string().max(200).optional(),
      skill: z.string().max(200).optional(),
      sort: z.enum(["addedAt", "name", "experienceYears"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listManagedPool({
        tenantId: user.tenantId,
        q: args.q,
        poolName: args.filter,
        department: args.department,
        skill: args.skill,
        sort: args.sort,
        order: args.order,
        page: args.page,
        limit: args.pageSize,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...toListEnvelope(data, {
                page: data.page,
                pageSize: data.limit,
              }),
              facets: data.facets,
            }),
          },
        ],
      };
    }, "hr_talent_pool_manage_list"),
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
      const data = await getPoolProfile({
        candidateId,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_profile_get"),
  );

  // ── MOVE TO PIPELINE ───────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_move_to_pipeline",
    "Move a talent-pool candidate into a job's pipeline by creating an application (stage applied, status open). No-op if the candidate already has an application for that requisition.",
    {
      candidateId: z.coerce
        .number()
        .int()
        .positive()
        .describe("Candidate id (references Candidate)"),
      jobRequisitionId: z.coerce
        .number()
        .int()
        .positive()
        .describe("Job requisition id (references JobRequisition)"),
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
    }, "hr_talent_pool_move_to_pipeline"),
  );

  // ── INVITE ─────────────────────────────────────────────────────────────
  server.tool(
    "hr_talent_pool_invite",
    "Invite a consenting talent-pool candidate: atomically record an expiring invitation and queue its message. Repeats reuse the open invitation. Applying is a separate candidate or recruiter action.",
    {
      candidateId: z.coerce
        .number()
        .int()
        .positive()
        .describe("Candidate id (references Candidate)"),
      jobRequisitionId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional publicly posted job requisition to invite the candidate to consider",
        ),
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
    }, "hr_talent_pool_invite"),
  );

  // ── INVITATION LIFECYCLE (FR-10 residue) ────────────────────────────────
  server.tool(
    "hr_talent_pool_invitation_list",
    "List talent-pool invitations with status, expiry, answer and the derived 'expired' flag (newest first; optionally narrowed by status or candidate)",
    {
      status: z
        .enum(["INVITED", "ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"])
        .optional(),
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
    }, "hr_talent_pool_invitation_list"),
  );

  server.tool(
    "hr_talent_pool_invitation_respond",
    "Advance a talent-pool invitation: record the candidate's answer (ACCEPTED/DECLINED) or withdraw it. One-way — an answered invitation cannot be re-answered; re-inviting is a new invitation.",
    {
      invitationId: z.coerce
        .number()
        .int()
        .positive()
        .describe("Invitation id (references TalentPoolInvitation)"),
      action: z
        .enum(["respond", "withdraw"])
        .describe(
          "respond = the candidate's answer; withdraw = the recruiter pulls it back",
        ),
      response: z
        .enum(["ACCEPTED", "DECLINED"])
        .optional()
        .describe("Required when action=respond"),
      note: z
        .string()
        .optional()
        .describe("Answer note, or the withdrawal reason"),
    },
    withToolError(async ({ invitationId, action, response, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data =
        action === "withdraw"
          ? await withdrawInvitation({
              tenantId: user.tenantId,
              invitationId,
              reason: note,
            })
          : await respondToInvitation({
              tenantId: user.tenantId,
              invitationId,
              response,
              note,
            });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_invitation_respond"),
  );

  // ── SEGMENTATION (FR-10 residue) ────────────────────────────────────────
  server.tool(
    "hr_talent_pool_segment",
    "Segment talent-pool candidates by skills, location, source, experience and invitation state; reports how many matched and, per filter, why the rest were excluded",
    {
      poolNames: z.array(z.string()).optional(),
      skills: z
        .array(z.string())
        .optional()
        .describe(
          "Any-of: a candidate with one of these skills is in the segment",
        ),
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
      const data = await segmentTalentPool({
        tenantId: user.tenantId,
        filters,
        limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_segment"),
  );

  server.tool(
    "hr_talent_pool_campaign",
    "Preview the current job-specific talent segment, then explicitly approve its immutable recipient set to queue 30-day invitations. A changed or expired preview must be reviewed again.",
    {
      mode: z.enum(["PREVIEW", "APPROVE"]),
      jobRequisitionId: z.number().int().positive().optional(),
      previewId: z.string().uuid().optional(),
      confirmed: z.boolean().optional(),
      filters: z
        .object({
          poolNames: z.array(z.string()).optional(),
          skills: z.array(z.string()).optional(),
          locations: z.array(z.string()).optional(),
          sources: z.array(z.string()).optional(),
          minExperienceYears: z.number().nonnegative().optional(),
          maxExperienceYears: z.number().nonnegative().optional(),
          invitedWithinDays: z.number().int().nonnegative().optional(),
          hasOpenInvitation: z.boolean().optional(),
        })
        .strict()
        .optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await talentPoolCampaign({
        ...args,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_talent_pool_campaign"),
  );

  // ── POOL RETENTION SWEEP (FR-10 residue) ────────────────────────────────
  server.tool(
    "hr_talent_pool_retention_sweep",
    "Sweep the TALENT_POOL retention clock: DRY RUN by default. Removes pool memberships whose clock has closed (never erases a candidate — that is the APPLICANT sweep's action) and reports legal-hold suspensions.",
    {
      asOf: z
        .string()
        .optional()
        .describe("ISO date to evaluate as of (defaults to now)"),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Defaults to true; apply mode is flag-gated (HR_RECRUITMENT_RETENTION_AUTOMATION)",
        ),
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
    }, "hr_talent_pool_retention_sweep"),
  );
}
