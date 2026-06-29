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
    "List candidates (paginated) for the HR recruitment screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
      search: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tag ids"),
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
      title: z.string().min(1),
      companyId: z.string().optional(),
      positionId: z.string().optional(),
      departmentId: z.string().optional(),
      employeeId: z.string().optional(),
      openings: z.number().int().positive().optional(),
      headcount: z.number().int().positive().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      description: z.string().optional(),
      targetDate: z.string().optional().describe("ISO 8601 date"),
      justification: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/requisitions", user.isAdmin);
      const data = await mcpCreateRequisition(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_requisition_update",
    "Update a job requisition",
    {
      id: z.string().min(1),
      title: z.string().optional(),
      companyId: z.string().optional(),
      positionId: z.string().optional(),
      departmentId: z.string().optional(),
      employeeId: z.string().optional(),
      openings: z.number().int().positive().optional(),
      headcount: z.number().int().positive().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      description: z.string().optional(),
      targetDate: z.string().optional().describe("ISO 8601 date"),
      justification: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/requisitions/${id}`, user.isAdmin);
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
      assertPermission(permissions, "PUT", `/hr/api/requisitions/approve/${id}`, user.isAdmin);
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
      assertPermission(permissions, "POST", `/hr/api/requisitions/post/${id}`, user.isAdmin);
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
      assertPermission(permissions, "DELETE", `/hr/api/requisitions/${id}`, user.isAdmin);
      const data = await mcpDeleteRequisition(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── CANDIDATE TOOLS ──────────────────────────────────────────────────────

  server.tool(
    "hr_candidate_create",
    "Add a new candidate to the system",
    {
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      phone: z.string().optional(),
      linkedinUrl: z.string().url().optional(),
      source: z.string().optional().describe("e.g. REFERRAL, JOB_BOARD, AGENCY"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/recruitment/candidates", user.isAdmin);
      const data = await mcpCreateCandidate(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_candidate_update",
    "Update candidate information",
    {
      id: z.string().min(1),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      status: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/recruitment/candidates/${id}`, user.isAdmin);
      const data = await mcpUpdateCandidate(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── APPLICATION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_application_create",
    "Create a job application for a candidate",
    {
      candidateId: z.string().min(1),
      requisitionId: z.string().min(1),
      stage: z.string().optional().describe("e.g. SCREENING, INTERVIEW, OFFER"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/recruitment/applications", user.isAdmin);
      const data = await mcpCreateApplication(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_application_update_stage",
    "Move an application to a different recruitment stage",
    {
      id: z.string().min(1),
      stage: z.string().min(1).describe("e.g. SCREENING, INTERVIEW, OFFER, HIRED, REJECTED"),
    },
    withToolError(async ({ id, stage }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/recruitment/applications/${id}/stage`, user.isAdmin);
      const data = await mcpUpdateApplicationStage(user, id, { stage });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_application_update_status",
    "Update the status of a job application",
    {
      id: z.string().min(1),
      status: z.string().min(1).describe("e.g. ACTIVE, WITHDRAWN, HIRED"),
    },
    withToolError(async ({ id, status }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/recruitment/applications/${id}/status`, user.isAdmin);
      const data = await mcpUpdateApplicationStatus(user, id, { status });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── INTERVIEW TOOLS ──────────────────────────────────────────────────────

  server.tool(
    "hr_interview_create",
    "Schedule an interview for an application",
    {
      applicationId: z.string().min(1),
      scheduledAt: z.string().describe("ISO 8601 datetime"),
      interviewType: z.string().optional().describe("e.g. PHONE, VIDEO, ONSITE"),
      interviewerIds: z.array(z.string()).optional(),
      location: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/interviews", user.isAdmin);
      const data = await mcpCreateInterview(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_interview_update",
    "Update an interview",
    {
      id: z.string().min(1),
      scheduledAt: z.string().optional(),
      type: z.string().optional(),
      interviewType: z.string().optional(),
      location: z.string().optional(),
      status: z.string().optional(),
      notes: z.string().optional(),
      decision: z.string().optional(),
      feedback: z
        .object({
          ratings: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
          decision: z.string().optional(),
          recommendation: z.string().optional(),
          comments: z.string().optional(),
        })
        .optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/interviews/${id}`, user.isAdmin);
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
      applicationId: z.string().min(1),
      baseSalary: z.number().positive(),
      candidateId: z.string().optional(),
      jobRequisitionId: z.string().optional(),
      currency: z.string().default("USD"),
      startDate: z.string().describe("ISO 8601 date"),
      expiryDate: z.string().optional().describe("ISO 8601 date"),
      benefits: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/offers", user.isAdmin);
      const data = await mcpCreateOffer(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offer_update",
    "Update a job offer",
    {
      id: z.string().min(1),
      applicationId: z.string().optional(),
      baseSalary: z.number().positive().optional(),
      candidateId: z.string().optional(),
      jobRequisitionId: z.string().optional(),
      currency: z.string().optional(),
      startDate: z.string().optional().describe("ISO 8601 date"),
      expiryDate: z.string().optional().describe("ISO 8601 date"),
      benefits: z.string().optional(),
      status: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/offers/${id}`, user.isAdmin);
      const data = await mcpUpdateOffer(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offer_send",
    "Send an offer",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/offers/${id}/send`, user.isAdmin);
      const data = await mcpSendOffer(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_talent_pool_add",
    "Add a candidate to talent pool",
    {
      candidateId: z.string().min(1),
      poolName: z.string().default("General"),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/recruitment/talent-pool", user.isAdmin);
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
      assertPermission(permissions, "DELETE", `/hr/api/recruitment/talent-pool/${id}`, user.isAdmin);
      const data = await mcpRemoveTalentPool(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
