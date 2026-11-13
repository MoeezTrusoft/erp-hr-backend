import { z } from "zod";
import {
  mcpApproveRequisition,
  mcpCreateApplication,
  mcpCreateCandidate,
  mcpCreateInterview,
  mcpCreateOffer,
  mcpCreateRequisition,
  mcpAddTalentPool,
  mcpDeleteRequisition,
  mcpListApplications,
  mcpListCandidates,
  mcpListRecruitmentTags,
  mcpListRequisitions,
  mcpListInterviews,
  mcpListOffers,
  mcpListTalentPool,
  mcpPostRequisition,
  mcpRemoveTalentPool,
  mcpSendOffer,
  mcpUpdateApplicationStage,
  mcpUpdateApplicationStatus,
  mcpUpdateCandidate,
  mcpUpdateInterview,
  mcpUpdateRequisition,
  mcpUpdateOffer,
} from "../controllers/recruitmentMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { runMcpIdempotent } from "../../middlewares/idempotency.middleware.js";
import { toListEnvelope, toListQuery } from "../utils/listEnvelope.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerRecruitmentTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_requisitions_list",
    "hr://recruitment/requisitions",
    { description: "List all job requisitions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListRequisitions(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_candidates_list",
    "hr://recruitment/candidates",
    { description: "List all candidates" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListCandidates(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_applications_list",
    "hr://recruitment/applications",
    { description: "List all job applications" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListApplications(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_talent_pool_list",
    "hr://recruitment/talent-pool",
    { description: "List talent pool entries" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListTalentPool(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_recruitment_tags_list",
    "hr://recruitment/tags",
    { description: "List all recruitment tags" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListRecruitmentTags(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_interviews_list",
    "hr://recruitment/interviews",
    { description: "List scheduled recruitment interviews" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListInterviews(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_offers_list",
    "hr://recruitment/offers",
    { description: "List job offers" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListOffers(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── LIST TOOLS (FE list-screen binding) ──────────────────────────────────
  // IC-1: the HR FE binds the Requisitions + Candidates LIST screens to the
  // `hr_requisitions_list` / `hr_candidates_list` TOOLS (tools/call). Same-named
  // RESOURCES exist but callTool could not resolve them, so the screens fell
  // back to mock data. These TOOLS wrap the existing list services, tenant-scoped
  // via ctx, and return the FE-expected paginated envelope. Both gated on
  // hr:recruitment:VIEW (deny-by-default).
  server.tool(
    "hr_requisitions_list",
    "List job requisitions (paginated) for the HR recruitment screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      status: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await mcpListRequisitions(user);
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_requisitions_list")
  );

  server.tool(
    "hr_candidates_list",
    "List candidates (paginated) for the HR recruitment screen. Supports offset (page/pageSize) OR opaque keyset pagination: pass the `cursor` returned as `nextCursor` to fetch the next page.",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      search: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tag ids"),
      // API-4: opaque keyset cursor. Optional/additive — when supplied the list
      // pages by keyset (createdAt desc, id desc) instead of offset. Echo back
      // the `nextCursor` from the previous response; never construct it yourself.
      cursor: z.string().optional().describe("Opaque keyset cursor from a prior response's nextCursor. Additive: omit to use page/pageSize offset paging."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await mcpListCandidates(user, toListQuery(args));
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_candidates_list")
  );

  // ── REQUISITION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_requisition_create",
    "Create a job requisition",
    {
      title: z.string().min(1).describe("Requisition title, e.g. 'Senior Backend Engineer'"),
      positionId: z.string().optional().describe("Position id (references Position); numeric string"),
      departmentId: z.string().optional().describe("RBAC Department.id; numeric string"),
      employeeId: z.string().optional().describe("Employee id the requisition is linked to (numeric string); also a requester fallback"),
      requestedById: z.string().min(1).describe("Hiring manager employee id (references Employee, requestedById); numeric string. Required — the requisition has a NOT-NULL requester."),
      openings: z.number().int().positive().optional().describe("Number of open seats; defaults to 1"),
      status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED"]).optional().describe("RequisitionStatus enum; defaults to DRAFT"),
      priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Requisition priority (JobRequisition.priority): Low | Medium | High | Urgent"),
      description: z.string().optional().describe("Job description / free text"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpCreateRequisition(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_requisition_update",
    "Update a job requisition",
    {
      id: z.string().min(1).describe("JobRequisition id to update; numeric string"),
      title: z.string().optional().describe("Requisition title"),
      positionId: z.string().optional().describe("Position id (references Position); numeric string"),
      departmentId: z.string().optional().describe("RBAC Department.id; numeric string"),
      employeeId: z.string().optional().describe("Linked employee id; numeric string"),
      requestedById: z.string().optional().describe("Hiring manager employee id (references Employee); numeric string"),
      openings: z.number().int().positive().optional().describe("Number of open seats"),
      status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CLOSED"]).optional().describe("RequisitionStatus enum"),
      priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Requisition priority: Low | Medium | High | Urgent"),
      description: z.string().optional().describe("Job description / free text"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read — a stale value returns -32009"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateRequisition(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_requisition_approve",
    "Approve a job requisition",
    {
      id: z.string().min(1),
      comment: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpApproveRequisition(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_requisition_post",
    "Post an approved job requisition as a job posting",
    {
      id: z.string().min(1),
      postingChannels: z.array(z.string()).optional().describe("e.g. LINKEDIN, INTERNAL, WEBSITE"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpPostRequisition(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_requisition_delete",
    "Delete a job requisition",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:recruitment", user.isAdmin);
      const data = await mcpDeleteRequisition(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── CANDIDATE TOOLS ──────────────────────────────────────────────────────

  server.tool(
    "hr_candidate_create",
    "Add a new candidate to the system",
    {
      firstName: z.string().min(1).describe("Candidate first name"),
      lastName: z.string().optional().describe("Candidate last name (Candidate.lastName is nullable)"),
      email: z.string().email().describe("Candidate email; unique per candidate"),
      phone: z.string().optional().describe("Contact phone, e.g. +15550103000"),
      source: z.string().optional().describe("Candidate source, e.g. REFERRAL, LinkedIn, JOB_BOARD, AGENCY"),
      tags: z.array(z.string()).optional().describe("Tag names to attach (upserted into Tag + CandidateTag), e.g. ['Backend','Go']"),
      resumeMediaId: z.union([z.string(), z.number()]).optional().describe("DAM asset id of the resume"),
      parseResume: z.coerce.boolean().optional().describe("Set true (with resumeMediaId) to AI-extract skills/competencies/certifications on create"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpCreateCandidate(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_candidate_update",
    "Update candidate information",
    {
      id: z.string().min(1).describe("Candidate id to update; numeric string"),
      firstName: z.string().optional().describe("Candidate first name"),
      lastName: z.string().optional().describe("Candidate last name"),
      phone: z.string().optional().describe("Contact phone"),
      source: z.string().optional().describe("Candidate source, e.g. REFERRAL, LinkedIn"),
      tags: z.array(z.string()).optional().describe("Replace the candidate's tags with these tag names (upserted)"),
      status: z.string().optional().describe("Candidate status: active | archived"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read — a stale value returns -32009"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateCandidate(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── APPLICATION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_application_create",
    "Create a job application for a candidate",
    {
      candidateId: z.string().min(1).describe("Candidate id (references Candidate); numeric string"),
      requisitionId: z.string().min(1).describe("Job requisition id (references JobRequisition); numeric string"),
      stage: z.string().optional().describe("Pipeline stage: applied | screening | interview | offer | hired | rejected (default applied)"),
      status: z.string().optional().describe("Application status: open | closed (default open)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpCreateApplication(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_application_update_stage",
    "Move an application to a different recruitment stage",
    {
      id: z.string().min(1).describe("Application id; numeric string"),
      stage: z.string().min(1).describe("Target pipeline stage (lowercased server-side): applied | screening | interview | offer | hired | rejected"),
    },
    withToolError(async ({ id, stage }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateApplicationStage(user, id, { stage });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_application_update_status",
    "Update the status of a job application",
    {
      id: z.string().min(1).describe("Application id; numeric string"),
      status: z.string().min(1).describe("Application status: open | closed | hired | rejected"),
    },
    withToolError(async ({ id, status }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateApplicationStatus(user, id, { status });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── INTERVIEW TOOLS ──────────────────────────────────────────────────────

  server.tool(
    "hr_interview_create",
    "Schedule an interview for an application",
    {
      applicationId: z.string().min(1).describe("Application id (references Application); numeric string"),
      scheduledAt: z.string().datetime().describe("Interview time — ISO 8601 datetime (YYYY-MM-DDTHH:mm:ssZ)"),
      interviewType: z
        .enum(["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"])
        .describe("InterviewType enum — one of PHONE_SCREEN | TECHNICAL | BEHAVIORAL | PANEL | FINAL | ONSITE | VIDEO"),
      interviewerIds: z.array(z.string()).optional().describe("Interviewer employee ids (numeric strings), e.g. ['2002','3003']"),
      location: z.string().optional().describe("Interview location or meeting link, e.g. 'Zoom'"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpCreateInterview(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_interview_update",
    "Update an interview",
    {
      id: z.string().min(1).describe("Interview id to update; numeric string"),
      scheduledAt: z.string().datetime().optional().describe("Reschedule time — ISO 8601 datetime (YYYY-MM-DDTHH:mm:ssZ)"),
      interviewType: z
        .enum(["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"])
        .optional()
        .describe("InterviewType enum — one of PHONE_SCREEN | TECHNICAL | BEHAVIORAL | PANEL | FINAL | ONSITE | VIDEO"),
      location: z.string().optional().describe("Interview location or meeting link"),
      status: z
        .enum(["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"])
        .optional()
        .describe("InterviewStatus enum — one of SCHEDULED | COMPLETED | CANCELLED | NO_SHOW"),
      notes: z.string().optional().describe("Free-text interview notes"),
      decision: z.string().optional().describe("Interview outcome: NEXT_ROUND | HOLD | REJECTED (appended to notes)"),
      feedback: z
        .object({
          ratings: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("Map of criterion -> score, e.g. {technical:4, culture:5}"),
          recommendation: z.string().optional().describe("Reviewer recommendation, e.g. HIRE | NO_HIRE"),
          comments: z.string().optional().describe("Reviewer comments"),
        })
        .optional()
        .describe("Scorecard feedback — persisted to InterviewScorecard for the acting reviewer"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateInterview(user, id, {
        ...rest,
        reviewerId: user?.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── OFFER TOOLS ──────────────────────────────────────────────────────────

  server.tool(
    "hr_offer_create",
    "Create a job offer for a candidate",
    {
      applicationId: z.string().min(1).describe("Application id (references Application, unique per offer); numeric string"),
      baseSalary: z.number().positive().describe("Offered base salary (> 0); stored encrypted at rest"),
      candidateId: z.string().min(1).describe("Candidate id (references Candidate, NOT-NULL FK); numeric string"),
      jobRequisitionId: z.string().min(1).describe("Job requisition id (references JobRequisition, NOT-NULL FK); numeric string"),
      currency: z.string().default("USD").describe("ISO 4217 currency code; default USD"),
      startDate: z.string().optional().describe("Proposed start date — ISO 8601 date YYYY-MM-DD (nullable)"),
      expiryDate: z.string().optional().describe("Offer validity deadline — ISO 8601 date YYYY-MM-DD"),
      benefits: z.string().optional().describe("Benefits summary (free text; stored as notes)"),
      // API-3: optional idempotency key. Retrying an offer create with the same
      // key replays the first offer instead of creating a duplicate.
      idempotencyKey: z.string().optional().describe("Optional idempotency key. Repeat the same value to safely retry this offer create without producing a duplicate."),
    },
    withToolError(async ({ idempotencyKey, ...args }) => {
      const ctx = getCtx();
      const { user, permissions } = ctx;
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const { value: data } = await runMcpIdempotent({
        toolName: "hr_offer_create",
        idempotencyKey,
        ctx,
        run: () => mcpCreateOffer(user, args),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offer_update",
    "Update a job offer",
    {
      id: z.string().min(1).describe("Offer id to update; numeric string"),
      applicationId: z.string().optional().describe("Application id (references Application); numeric string"),
      baseSalary: z.number().positive().optional().describe("Offered base salary (> 0); aliased to salary, stored encrypted"),
      candidateId: z.string().optional().describe("Candidate id (references Candidate, NOT-NULL FK); only reassigned when truthy; numeric string"),
      jobRequisitionId: z.string().optional().describe("Job requisition id (references JobRequisition, NOT-NULL FK); only reassigned when truthy; numeric string"),
      currency: z.string().optional().describe("ISO 4217 currency code; empty falls back to USD"),
      startDate: z.string().optional().describe("Proposed start date — ISO 8601 date YYYY-MM-DD"),
      expiryDate: z.string().optional().describe("Offer validity deadline — ISO 8601 date YYYY-MM-DD"),
      benefits: z.string().optional().describe("Benefits summary (free text; aliased to notes)"),
      status: z.string().optional().describe("OfferStatus: DRAFT | SENT | ACCEPTED | DECLINED | EXPIRED | WITHDRAWN (not enum-enforced)"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read — a stale value returns -32009"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mcpUpdateOffer(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offer_send",
    "Send an offer",
    { id: z.string().min(1).describe("Offer id to send (references Offer); numeric string. Flips status to SENT and emits hr.recruitment.offer_sent.v1") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpSendOffer(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_talent_pool_add",
    "Add a candidate to talent pool",
    {
      candidateId: z.string().min(1).describe("Candidate id (references Candidate); numeric string"),
      poolName: z.string().default("General").describe("Talent pool name; defaults to 'General'"),
      notes: z.string().optional().describe("Free-text notes about the candidate for this pool"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await mcpAddTalentPool(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_talent_pool_remove",
    "Remove a candidate from talent pool",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:recruitment", user.isAdmin);
      const data = await mcpRemoveTalentPool(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
