// src/mcp/tools/claimsTools.js — MCP tools for the Claims & Reimbursements domain.
//
// A NEW tool file backed by src/services/claims.service.js (distinct from the
// legacy reimbursement tools in complianceTools.js). resourceKey `hr:reimbursement`.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getClaimKpis,
  listClaims,
  getClaim,
  createClaim,
  updateClaim,
  submitClaim,
  decideClaimApproval,
  rejectClaim,
  withdrawClaim,
  markPaid,
  requestClaimInfo,
  respondClaimInfo,
  exportClaimsCsv,
} from "../../services/claims.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const RESOURCE = "hr:reimbursement";

const claimStatusEnum = z.enum([
  "DRAFT",
  "SUBMITTED",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "PAID",
]);

const itemSchema = z.object({
  name: z.string().min(1).describe("Line-item label (ClaimItem.name)"),
  description: z.string().optional().describe("Optional line-item detail"),
  amount: z.coerce.number().describe("Line-item amount (ClaimItem.amount)"),
  mediaId: z.coerce.number().int().optional().describe("DAM attachment asset id for this line (ClaimItem.mediaId)"),
});

const approvalStepSchema = z.object({
  level: z.coerce.number().int().optional().describe("Step order (1,2,3…); auto-assigned by position when omitted"),
  role: z.string().optional().describe("Approver role label for the step (ClaimApproval.role)"),
  approverId: z.coerce.number().int().optional().describe("Specific approver employee id (ClaimApproval.approverId)"),
});

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerClaimsTools(server) {
  // ── KPIs ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_kpis",
    "Claims & Reimbursements KPIs: pending-review / approved / rejected counts + total reimbursed (PAID) amount, optionally within a date window.",
    {
      from: z.string().optional().describe("ISO date lower bound (on submittedAt, falling back to created_at)"),
      to: z.string().optional().describe("ISO date upper bound"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getClaimKpis({ tenantId: user.tenantId, from: args.from, to: args.to });
      return ok(data);
    }, "hr_claim_kpis")
  );

  // ── list ─────────────────────────────────────────────────────────────────
  server.tool(
    "hr_claims_list",
    "List reimbursement claims (filtered, sorted, paginated). Row: claimId, title, employee{id,name,avatar,department}, category, amount, submittedAt, status.",
    {
      q: z.string().optional().describe("Search over claim title and employee name"),
      status: claimStatusEnum.optional().describe("Filter by claim status"),
      category: z.string().optional().describe("Filter by category"),
      employeeId: z.coerce.number().int().optional().describe("Filter by claimant employee id"),
      from: z.string().optional().describe("ISO date lower bound (submittedAt / created_at)"),
      to: z.string().optional().describe("ISO date upper bound"),
      sortBy: z.enum(["submittedAt", "amount", "status"]).optional().describe("Sort field (default submittedAt)"),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
      page: z.coerce.number().int().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().optional().describe("Rows per page (default 20, max 200)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listClaims({ tenantId: user.tenantId, ...args });
      return ok(data);
    }, "hr_claims_list")
  );

  // ── get (drawer) ───────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_get",
    "Get one reimbursement claim with full detail: header, employee, line items, approval chain, and info requests.",
    { id: z.coerce.number().int().describe("Reimbursement claim id") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getClaim({ tenantId: user.tenantId, id });
      return ok(data);
    }, "hr_claim_get")
  );

  // ── create ─────────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_create",
    "Create a reimbursement claim (status DRAFT) with optional line items. If items are given and no top-level amount, amount = sum(items).",
    {
      employeeId: z.coerce.number().int().optional().describe("Claimant employee id (defaults to the caller's employeeId)"),
      title: z.string().min(1).describe("Claim title (ReimbursementClaim.title, NOT NULL)"),
      description: z.string().optional().describe("Claim description"),
      category: z.string().optional().describe("Category, e.g. TRAVEL, MEALS, EQUIPMENT"),
      amount: z.coerce.number().optional().describe("Total amount; if omitted with items, computed from item sum"),
      currency: z.string().optional().describe("ISO 4217 currency code (default USD)"),
      items: z.array(itemSchema).optional().describe("Line items {name, description?, amount, mediaId?}"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const employeeId = args.employeeId != null ? args.employeeId : user.employeeId;
      if (employeeId == null) throw Object.assign(new Error("No employeeId provided or in session"), { status: 400 });
      const data = await createClaim({ tenantId: user.tenantId, ...args, employeeId });
      return ok(data);
    }, "hr_claim_create")
  );

  // ── update ─────────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_update",
    "Update editable fields of a claim while it is DRAFT or NEEDS_INFO. Optionally replace its line items.",
    {
      id: z.coerce.number().int().describe("Reimbursement claim id"),
      title: z.string().min(1).optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      category: z.string().optional().describe("New category"),
      amount: z.coerce.number().optional().describe("New total amount"),
      currency: z.string().optional().describe("New currency code"),
      items: z.array(itemSchema).optional().describe("Replacement line items (replaces all existing items)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updateClaim({ tenantId: user.tenantId, ...args });
      return ok(data);
    }, "hr_claim_update")
  );

  // ── submit ─────────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_submit",
    "Submit a claim (status SUBMITTED, submittedAt=now) and create its ordered approval chain. With no chain, a single level-1 step is created.",
    {
      id: z.coerce.number().int().describe("Reimbursement claim id"),
      approvalChain: z.array(approvalStepSchema).optional().describe("Ordered approval steps {level?, role?, approverId?}"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await submitClaim({ tenantId: user.tenantId, ...args });
      return ok(data);
    }, "hr_claim_submit")
  );

  // ── approval decision (advance / finalize) ──────────────────────────────────
  server.tool(
    "hr_claim_approval_decide",
    "Approve or reject one step of a claim's approval chain. Approve advances to the next pending step; the final approval APPROVES the claim; any reject REJECTS the claim.",
    {
      claimId: z.coerce.number().int().describe("Reimbursement claim id"),
      approvalId: z.coerce.number().int().describe("ClaimApproval step id being decided"),
      decision: z.enum(["approve", "reject"]).describe("approve | reject"),
      comments: z.string().optional().describe("Decision comments (ClaimApproval.comments)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await decideClaimApproval({ tenantId: user.tenantId, ...args, approverId: user.employeeId });
      return ok(data);
    }, "hr_claim_approval_decide")
  );

  // ── reject ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_reject",
    "Reject a claim outright (status REJECTED with an optional reason).",
    {
      id: z.coerce.number().int().describe("Reimbursement claim id"),
      reason: z.string().optional().describe("Rejection reason (ReimbursementClaim.rejectedReason)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await rejectClaim({ tenantId: user.tenantId, ...args, approverId: user.employeeId });
      return ok(data);
    }, "hr_claim_reject")
  );

  // ── withdraw ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_withdraw",
    "Withdraw a claim (status WITHDRAWN). Only allowed from DRAFT, SUBMITTED, or NEEDS_INFO.",
    { id: z.coerce.number().int().describe("Reimbursement claim id") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await withdrawClaim({ tenantId: user.tenantId, id });
      return ok(data);
    }, "hr_claim_withdraw")
  );

  // ── mark paid ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_mark_paid",
    "Mark an APPROVED claim as PAID (status PAID, paidAt=now).",
    { id: z.coerce.number().int().describe("Reimbursement claim id") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await markPaid({ tenantId: user.tenantId, id });
      return ok(data);
    }, "hr_claim_mark_paid")
  );

  // ── request info ───────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_request_info",
    "Request additional information on a claim (creates a PENDING info request and sets the claim to NEEDS_INFO).",
    {
      claimId: z.coerce.number().int().describe("Reimbursement claim id"),
      question: z.string().min(1).describe("The information being requested (ClaimInformation.question)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await requestClaimInfo({ tenantId: user.tenantId, ...args, requestedById: user.employeeId });
      return ok(data);
    }, "hr_claim_request_info")
  );

  // ── respond info ───────────────────────────────────────────────────────────
  server.tool(
    "hr_claim_respond_info",
    "Respond to a claim info request (marks it RESPONDED and returns the claim to SUBMITTED for review).",
    {
      infoId: z.coerce.number().int().describe("ClaimInformation id being answered"),
      response: z.string().min(1).describe("The answer text (ClaimInformation.response)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await respondClaimInfo({ tenantId: user.tenantId, ...args });
      return ok(data);
    }, "hr_claim_respond_info")
  );

  // ── export ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_claims_export",
    "Export the claims list as CSV (Claim ID, Title, Employee, Category, Amount, Submitted, Status).",
    {
      status: claimStatusEnum.optional().describe("Filter by status"),
      category: z.string().optional().describe("Filter by category"),
      format: z.enum(["csv"]).optional().describe("Export format (csv)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await exportClaimsCsv({ tenantId: user.tenantId, status: args.status, category: args.category });
      return ok(data);
    }, "hr_claims_export")
  );
}
