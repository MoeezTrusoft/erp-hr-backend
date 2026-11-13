// src/mcp/tools/offerMgmtTools.js — Offer Management MCP tools.
//
// Enhanced offer-management surface (structured comp/terms/approvals, preview
// letter, full-create, pre-boarding). Gated on hr:recruitment (VIEW/CREATE/EDIT).
// Sensitive fields (salary, compensation.baseSalary) additionally gated on
// hr:payroll VIEW — masked with "••••••" unless the caller is admin OR holds
// hr:payroll VIEW (mirrors employeeTools.js showSensitive computation).
//
// Existing simple offer tools live in recruitmentTools.js (hr_offer_create,
// hr_offer_send, hr_offer_update) — these do NOT duplicate them.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listOffersManage,
  getOfferManage,
  previewOfferManage,
  createOfferFull,
  markOfferPreboarding,
} from "../../services/offerMgmt.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Sensitive salary/comp is surfaced only to admins or hr:payroll VIEW holders.
function computeShowSensitive(user, permissions) {
  return (
    Boolean(user?.isAdmin) ||
    (Array.isArray(permissions?.["hr:payroll"]) && permissions["hr:payroll"].includes("VIEW"))
  );
}

export function registerOfferMgmtTools(server) {
  // 1 ── LIST ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_offers_manage_list",
    "List offers for the Offer Management screen (structured comp/terms/approvals; salary masked unless caller holds hr:payroll VIEW)",
    {
      q: z.string().optional().describe("Search by candidate name"),
      status: z.string().optional().describe("DRAFT|SENT|ACCEPTED|DECLINED|EXPIRED|WITHDRAWN"),
      offerType: z.string().optional(),
      sort: z.enum(["sentAt", "startDate"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const showSensitive = computeShowSensitive(user, permissions);
      const data = await listOffersManage({ ...args, tenantId: user.tenantId, showSensitive });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offers_manage_list")
  );

  // 2 ── GET (full detail + preview) ───────────────────────────────────────────
  server.tool(
    "hr_offer_manage_get",
    "Get a single offer with full detail and a computed offer-letter preview (salary masked unless caller holds hr:payroll VIEW)",
    { id: z.union([z.string(), z.number()]) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const showSensitive = computeShowSensitive(user, permissions);
      const data = await getOfferManage(id, { tenantId: user.tenantId, showSensitive });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offer_manage_get")
  );

  // 3 ── FULL CREATE ───────────────────────────────────────────────────────────
  server.tool(
    "hr_offer_create_full",
    "Create a full offer (structured compensation, terms, employment type) in DRAFT status",
    {
      applicationId: z.coerce.number().int().positive().describe("Application id (references Application; NOT NULL @unique FK on Offer)"),
      candidateId: z.coerce.number().int().positive().describe("Candidate id (references Candidate; NOT NULL FK on Offer)"),
      jobRequisitionId: z.coerce.number().int().positive().describe("Job requisition id (references JobRequisition; NOT NULL FK on Offer)"),
      jobTitle: z.string().optional(),
      employmentType: z.string().min(1).optional().describe("Employment type, e.g. Full-time | Part-time | Contract (nullable on Offer)"),
      department: z.string().optional(),
      hiringManager: z.string().optional(),
      startDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD (nullable on Offer)"),
      workLocation: z.string().optional(),
      probationMonths: z.coerce.number().int().nonnegative().optional(),
      noticePeriodDays: z.coerce.number().int().nonnegative().optional(),
      baseSalary: z.coerce.number().positive().describe("Base salary as a number; persisted C4-encrypted (Offer.salary NOT NULL)"),
      salaryFrequency: z.string().optional().describe("e.g. Monthly | Annual"),
      bonus: z.union([z.number(), z.string()]).optional(),
      allowances: z.union([z.number(), z.string()]).optional(),
      currency: z.string().default("PKR"),
      benefits: z.array(z.string()).default([]),
      specialClauses: z.string().optional(),
      offerType: z.string().default("Standard").describe("Offer type, e.g. Standard | Contract | Internship | Promotion"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const showSensitive = computeShowSensitive(user, permissions);
      const data = await createOfferFull(args, {
        tenantId: user.tenantId,
        createdById: user.employeeId,
        showSensitive,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offer_create_full")
  );

  // 4 ── PREVIEW (no mutation) ─────────────────────────────────────────────────
  server.tool(
    "hr_offer_preview",
    "Render an offer-letter preview for an offer without mutating it (salary masked unless caller holds hr:payroll VIEW)",
    { id: z.union([z.string(), z.number()]) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const showSensitive = computeShowSensitive(user, permissions);
      const data = await previewOfferManage(id, { tenantId: user.tenantId, showSensitive });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offer_preview")
  );

  // 5 ── PREBOARDING ───────────────────────────────────────────────────────────
  server.tool(
    "hr_offer_preboarding",
    "Mark an offer as moving into pre-boarding (sets terms.preboarding=true and appends a notes entry)",
    {
      id: z.union([z.string(), z.number()]),
      note: z.string().optional().describe("Optional pre-boarding note appended to the offer notes"),
    },
    withToolError(async ({ id, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const showSensitive = computeShowSensitive(user, permissions);
      const data = await markOfferPreboarding(id, { tenantId: user.tenantId, showSensitive, note });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offer_preboarding")
  );
}
