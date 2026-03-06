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

export function registerRecruitmentTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_requisitions_list",
    "hr://recruitment/requisitions",
    { description: "List all job requisitions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/requisitions", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_candidates_list",
    "hr://recruitment/candidates",
    { description: "List all candidates" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/recruitment/candidates", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_applications_list",
    "hr://recruitment/applications",
    { description: "List all job applications" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/recruitment/applications", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_talent_pool_list",
    "hr://recruitment/talent-pool",
    { description: "List talent pool entries" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/talent-pool", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_recruitment_tags_list",
    "hr://recruitment/tags",
    { description: "List all recruitment tags" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/recruitment/tags", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── REQUISITION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_requisition_create",
    "Create a job requisition",
    {
      title: z.string().min(1),
      positionId: z.string().optional(),
      departmentId: z.string().optional(),
      headcount: z.number().int().positive().optional(),
      targetDate: z.string().optional().describe("ISO 8601 date"),
      justification: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/requisitions", user.isAdmin);
      const data = await self("POST", "/api/requisitions", user, args);
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
      const data = await self("PUT", `/api/requisitions/approve/${id}`, user, rest);
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
      const data = await self("POST", `/api/requisitions/post/${id}`, user, rest);
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
      const data = await self("DELETE", `/api/requisitions/${id}`, user);
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
      const data = await self("POST", "/api/recruitment/candidates", user, args);
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
      const data = await self("PUT", `/api/recruitment/candidates/${id}`, user, rest);
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
      const data = await self("POST", "/api/recruitment/applications", user, args);
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
      const data = await self("PUT", `/api/recruitment/applications/${id}/stage`, user, { stage });
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
      const data = await self("PUT", `/api/recruitment/applications/${id}/status`, user, { status });
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
      const data = await self("POST", "/api/interviews", user, args);
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
      currency: z.string().default("USD"),
      startDate: z.string().describe("ISO 8601 date"),
      expiryDate: z.string().optional().describe("ISO 8601 date"),
      benefits: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/offers", user.isAdmin);
      const data = await self("POST", "/api/offers", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
