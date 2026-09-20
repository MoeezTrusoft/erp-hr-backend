// src/mcp/tools/candidatePrivacyTools.js — Phase 2.5/10 candidate privacy tools.
//
// Gated on hr:recruitment with the method-matching action, mirroring the REST
// surface mounted under /api/recruitment/privacy. The actor is the verified
// employee from the MCP request context — never a tool argument, so a caller
// cannot attribute a statutory action (DNC, erasure) to someone else.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import * as privacy from "../../services/candidatePrivacy.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

function getTenant(user) {
  const tenantId = user?.tenantId ?? null;
  if (!tenantId) throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  return tenantId;
}

export function registerCandidatePrivacyTools(server) {
  // 1 ── CONSENT: RECORD ──────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_consent_record",
    "Record a candidate consent decision (append-only history; PROCESSING also updates the candidate's aggregate status)",
    {
      candidateId: z.coerce.number().int().positive(),
      purpose: z.enum(["PROCESSING", "TALENT_POOL", "MARKETING"]),
      status: z.enum(["GRANTED", "WITHDRAWN"]),
      policyVersion: z.string().optional(),
      source: z.string().optional(),
      evidence: z.string().max(2000).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await privacy.recordConsent({
        ...args,
        tenantId: getTenant(user),
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_consent_record")
  );

  // 2 ── CONSENT: HISTORY ─────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_consent_list",
    "List a candidate's consent history and current aggregate consent status",
    { candidateId: z.coerce.number().int().positive() },
    withToolError(async ({ candidateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await privacy.listConsent({ tenantId: getTenant(user), candidateId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_consent_list")
  );

  // 3 ── DNC: RECORD ──────────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_dnc_record",
    "Add a candidate to the do-not-contact register (email-keyed; a compliance reason code and reason are mandatory)",
    {
      email: z.string().min(3),
      candidateId: z.coerce.number().int().positive().optional(),
      reasonCode: z.string().min(1).describe("Compliance reason code, e.g. CANDIDATE_REQUEST | LEGAL | ABUSE"),
      reason: z.string().min(1).max(2000),
      scope: z.string().optional(),
      expiresAt: z.string().optional().describe("ISO 8601 — omit for an indefinite block"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await privacy.recordDnc({
        ...args,
        tenantId: getTenant(user),
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_dnc_record")
  );

  // 4 ── DNC: LIST ────────────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_dnc_list",
    "List do-not-contact entries for the tenant (optionally filtered by status or email)",
    {
      status: z.enum(["ACTIVE", "LIFTED"]).optional(),
      email: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await privacy.listDnc({ ...args, tenantId: getTenant(user) });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_dnc_list")
  );

  // 5 ── DNC: LIFT ───────────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_dnc_lift",
    "Lift a do-not-contact entry (requires a reason; the original entry is retained as LIFTED)",
    { id: z.coerce.number().int().positive(), reason: z.string().min(1).max(2000) },
    withToolError(async ({ id, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.liftDnc({
        tenantId: getTenant(user),
        id,
        reason,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_dnc_lift")
  );

  // 6 ── LEGAL HOLD: PLACE ────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_legal_hold_place",
    "Place a legal hold on a candidate — suspends retention and blocks anonymization",
    { candidateId: z.coerce.number().int().positive(), reason: z.string().min(1).max(2000) },
    withToolError(async ({ candidateId, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await privacy.placeLegalHold({
        tenantId: getTenant(user),
        candidateId,
        reason,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_legal_hold_place")
  );

  // 7 ── LEGAL HOLD: RELEASE ─────────────────────────────────────────────────
  server.tool(
    "hr_candidate_legal_hold_release",
    "Release a candidate's active legal hold (requires a reason)",
    { candidateId: z.coerce.number().int().positive(), reason: z.string().min(1).max(2000) },
    withToolError(async ({ candidateId, reason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.releaseLegalHold({
        tenantId: getTenant(user),
        candidateId,
        reason,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_legal_hold_release")
  );

  // 8 ── RETENTION POLICY ─────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_retention_policy_set",
    "Set the tenant's candidate retention policy (drives the retention clock stamped on new candidates)",
    {
      appliesTo: z.enum(["APPLICANT", "TALENT_POOL"]),
      retentionMonths: z.coerce.number().int().positive(),
      legalBasis: z.string().max(1000).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.setRetentionPolicy({
        ...args,
        tenantId: getTenant(user),
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_retention_policy_set")
  );

  // 9 ── RETENTION PREVIEW ────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_retention_preview",
    "List candidates whose retention window has closed, separating those suspended by a legal hold",
    { asOf: z.string().optional().describe("ISO 8601 cutoff (defaults to now)"), limit: z.coerce.number().int().positive().optional() },
    withToolError(async ({ asOf, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await privacy.previewRetentionDue({
        tenantId: getTenant(user),
        asOf: asOf ? new Date(asOf) : new Date(),
        limit: limit ?? 100,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_retention_preview")
  );

  // 10 ── RETENTION APPLY ─────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_retention_apply",
    "Apply retention to due candidates. DRY RUN unless dryRun is explicitly false — anonymization is irreversible",
    {
      dryRun: z.boolean().optional().describe("Defaults to true; the destructive path requires an explicit false"),
      asOf: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    },
    withToolError(async ({ dryRun, asOf, limit }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.applyRetention({
        tenantId: getTenant(user),
        asOf: asOf ? new Date(asOf) : new Date(),
        actorId: user.employeeId ?? null,
        dryRun: dryRun !== false,
        limit: limit ?? 100,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_retention_apply")
  );

  // 11 ── ANONYMIZE ───────────────────────────────────────────────────────────
  server.tool(
    "hr_candidate_anonymize",
    "Irreversibly anonymize a candidate (PII redacted, pipeline aggregates preserved). Refused while a legal hold is active",
    {
      candidateId: z.coerce.number().int().positive(),
      reason: z.string().min(1).max(2000),
      legalBasis: z.string().max(1000).optional(),
    },
    withToolError(async ({ candidateId, reason, legalBasis }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.anonymizeCandidate({
        tenantId: getTenant(user),
        candidateId,
        reason,
        legalBasis: legalBasis ?? null,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_anonymize")
  );

  // 12 ── DATA-SUBJECT REQUEST: RECORD ───────────────────────────────────────
  server.tool(
    "hr_candidate_request_record",
    "Record a candidate data-subject request (ACCESS | CORRECTION | ERASURE) and start its statutory SLA clock",
    {
      subjectEmail: z.string().min(3),
      type: z.enum(["ACCESS", "CORRECTION", "ERASURE"]),
      candidateId: z.coerce.number().int().positive().optional(),
      dueAt: z.string().optional().describe("ISO 8601; defaults to now + 30 days"),
      notes: z.string().max(2000).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await privacy.recordDataAccessRequest({
        ...args,
        tenantId: getTenant(user),
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_request_record")
  );

  // 13 ── DATA-SUBJECT REQUEST: LIST ─────────────────────────────────────────
  server.tool(
    "hr_candidate_request_list",
    "List candidate data-subject requests, optionally by status",
    { status: z.enum(["RECEIVED", "IN_PROGRESS", "FULFILLED", "REJECTED"]).optional() },
    withToolError(async ({ status }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await privacy.listDataAccessRequests({ tenantId: getTenant(user), status: status ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_request_list")
  );

  // 14 ── DATA-SUBJECT REQUEST: CLOSE ────────────────────────────────────────
  server.tool(
    "hr_candidate_request_close",
    "Close a data-subject request as FULFILLED or REJECTED (a rejection requires a reason)",
    {
      id: z.coerce.number().int().positive(),
      status: z.enum(["FULFILLED", "REJECTED"]),
      notes: z.string().max(2000).optional(),
      rejectionReason: z.string().max(2000).optional(),
    },
    withToolError(async ({ id, status, notes, rejectionReason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await privacy.closeDataAccessRequest({
        tenantId: getTenant(user),
        id,
        status,
        notes: notes ?? null,
        rejectionReason: rejectionReason ?? null,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_candidate_request_close")
  );
}
