// src/mcp/tools/application.tools.js — Application LIST + GET (补齐 CRUD).
//
// Application has CREATE/UPDATE_STAGE/UPDATE_STATUS via existing tools; this adds LIST, GET.
// Phase 6 / §4.1–4.3 adds the screening/reason-code/shortlist family.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listApplications,
  getApplication,
  deleteApplication,
} from "../../services/application.service.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import {
  recordScreening,
  listScreenings,
  listDispositionReasons,
  versionDispositionReason,
  deactivateDispositionReason,
  addToShortlist,
  listShortlist,
  removeFromShortlist,
} from "../../services/application-screening.service.js";
import {
  addPacketItem,
  listPacket,
  removePacketItem,
  getPacketForViewer,
} from "../../services/interview-packet.service.js";
import { PACKETABLE_CLASSES } from "../../lib/documentAccess.js";
import { SCREENING_OUTCOMES } from "../../lib/dispositionReasons.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerApplicationTools(server) {
  server.tool(
    "hr_application_list",
    "List recruitment applications with optional filters",
    {
      candidateId: z.union([z.number(), z.string()]).optional().describe("Filter by candidate"),
      requisitionId: z.union([z.number(), z.string()]).optional().describe("Filter by requisition"),
      stage: z.string().optional().describe("Filter by stage"),
      status: z.string().optional().describe("Filter by status"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async ({ requisitionId, ...args }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      // The tool declares `requisitionId` but the service filters on
      // `jobRequisitionId`; passing the argument through under its own name
      // silently dropped the filter and returned the whole page.
      const data = await listApplications({
        ...args,
        jobRequisitionId: requisitionId,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_list")
  );

  server.tool(
    "hr_application_get",
    "Get an application by ID",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getApplication({
        id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      if (!data) {
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-4040",
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_get")
  );

  server.tool(
    "hr_application_delete",
    "Delete a recruitment application",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:recruitment", user.isAdmin);
      const deletedId = await deleteApplication({
        id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      // Same not-found shape as a cross-tenant id: a 403 here would confirm the
      // row exists in another tenant.
      if (deletedId === null) {
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-4040",
        });
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: deletedId }) }] };
    }, "hr_application_delete")
  );

  // ── Phase 6 / §4.1 — screening records (§4.1a: separate from interview feedback) ──

  server.tool(
    `hr_application_screening_record`,
    `Record one screening decision (Phase 6 §4.1). Outcomes: ${SCREENING_OUTCOMES.join(" | ")}. REJECT/HOLD REQUIRE an active tenant reason code (§4.2 — list them first with hr_disposition_reasons_list); OTHER (or any code flagged requiresNotes) demands notes. ADVANCE takes NO reason code. A first rejection in a fresh tenant seeds the default taxonomy automatically.`,
    {
      id: z.union([z.number(), z.string()]).describe("Application ID"),
      outcome: z.enum(SCREENING_OUTCOMES),
      reasonCode: z.string().optional().describe("Required for REJECT/HOLD; must be an active tenant code"),
      notes: z.string().max(5000).optional().describe("Required when the chosen code has requiresNotes"),
      criteria: z
        .array(z.object({ criterion: z.string().min(1), result: z.enum(["PASS", "FAIL", "UNSURE"]), note: z.string().optional() }))
        .optional()
        .describe("Optional criterion results (§4.1)"),
    },
    withToolError(async ({ id, outcome, reasonCode, notes, criteria }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await recordScreening({
        applicationId: id,
        tenantId: user.tenantId,
        outcome,
        reasonCode: reasonCode ?? null,
        notes: notes ?? null,
        criteria: criteria ?? null,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_screening_record")
  );

  server.tool(
    "hr_application_screenings_list",
    "List an application's screening history, newest first — every recorded decision with outcome, reason code, notes, criteria and reviewer.",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listScreenings(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_screenings_list")
  );

  // ── Phase 6 / §4.2 — disposition reason codes ─────────────────────────

  server.tool(
    "hr_disposition_reasons_list",
    "List the tenant's ACTIVE disposition reason codes (the §4.2 picker source). A fresh tenant is seeded with the default taxonomy on first call.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listDispositionReasons(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_disposition_reasons_list")
  );

  server.tool(
    "hr_disposition_reason_version",
    "Create a NEW VERSION of a disposition reason code (label / notes-requirement change) or add a brand-new code. A code's meaning is stable across versions; never edit history in place.",
    {
      code: z.string().min(1).max(100),
      label: z.string().min(1).max(200),
      requiresNotes: z.boolean().optional().describe("Default false; set true for codes like OTHER"),
    },
    withToolError(async ({ code, label, requiresNotes }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await versionDispositionReason({
        tenantId: user.tenantId,
        code,
        label,
        requiresNotes: requiresNotes === true,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_disposition_reason_version")
  );

  server.tool(
    "hr_disposition_reason_deactivate",
    "Deactivate a disposition reason code for the tenant. Versioning keeps historic dispositions resolvable; deactivation only stops new use.",
    { code: z.string().min(1).max(100) },
    withToolError(async ({ code }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await deactivateDispositionReason(user.tenantId, code);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_disposition_reason_deactivate")
  );

  // ── Phase 6 / §4.3 — the requisition shortlist ────────────────────────

  server.tool(
    "hr_application_shortlist_add",
    "Mark an application onto its requisition's shortlist (§4.3 — requisition-specific, no count limit). Idempotent: re-adding refreshes the note and reports alreadyListed. Adding an application with a pending fit-score proposal (source SCORING_PROPOSAL) confirms it as MANUAL.",
    {
      id: z.union([z.number(), z.string()]).describe("Application ID"),
      note: z.string().max(2000).optional().describe("Optional shared note for the hiring team"),
    },
    withToolError(async ({ id, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      // Scoped: a hiring manager shortlists only on their own requisitions.
      const data = await addToShortlist({
        applicationId: id,
        tenantId: user.tenantId,
        note: note ?? null,
        actorId: user.employeeId ?? null,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_shortlist_add")
  );

  server.tool(
    "hr_requisition_shortlist_list",
    "List a requisition's current shortlist with each application's stage and candidate identity (hiring-team view). Each entry's source is MANUAL (a recruiter marked it) or SCORING_PROPOSAL (a fit-score proposal awaiting confirmation).",
    { requisitionId: z.union([z.number(), z.string()]).describe("Requisition ID") },
    withToolError(async ({ requisitionId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listShortlist(requisitionId, user.tenantId, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_requisition_shortlist_list")
  );

  server.tool(
    "hr_application_shortlist_remove",
    "Remove an application from its requisition's shortlist. The screening/disposition record remains the audit of WHY.",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await removeFromShortlist({
        applicationId: id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_shortlist_remove")
  );

  // ── Phase 6 / §4.4 — the interview packet ────────────────────────────────
  // Only matrix-permitted classes can be packeted (the service refuses the
  // rest); the interviewer-context view (hr_interview_packet_view) is the
  // "only if in the interview packet" cells made real, gated on the caller's
  // InterviewInterviewer row.

  server.tool(
    "hr_interview_packet_add",
    "Add a document to an interview's packet. Only PORTFOLIO, GENERAL_APPLICATION_DOC and INTERVIEW_BRIEF are packetable — screening notes, budget/approval and offer documents never are.",
    {
      interviewId: z.union([z.number(), z.string()]).describe("Interview ID"),
      docClass: z.enum(["PORTFOLIO", "GENERAL_APPLICATION_DOC", "INTERVIEW_BRIEF"]).describe("Document class"),
      mediaId: z.union([z.number(), z.string()]).describe("DAM media asset ID"),
      label: z.string().optional().describe("Display label"),
    },
    withToolError(async ({ interviewId, docClass, mediaId, label }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await addPacketItem({
        interviewId,
        docClass,
        mediaId,
        label: label ?? null,
        tenantId: user.tenantId,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_packet_add")
  );

  server.tool(
    "hr_interview_packet_list",
    "List an interview's full packet (recruiter/hiring-team view).",
    { interviewId: z.union([z.number(), z.string()]).describe("Interview ID") },
    withToolError(async ({ interviewId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listPacket({ interviewId, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_packet_list")
  );

  server.tool(
    "hr_interview_packet_remove",
    "Remove a document from an interview's packet.",
    {
      interviewId: z.union([z.number(), z.string()]).describe("Interview ID"),
      itemId: z.union([z.number(), z.string()]).describe("Packet item ID"),
    },
    withToolError(async ({ interviewId, itemId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await removePacketItem({ interviewId, itemId, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_packet_remove")
  );

  server.tool(
    "hr_interview_packet_view",
    "The caller's own packet view for one interview: requires an active interviewer assignment; returns the resume, packeted portfolio/application documents and briefs the caller may see. Not assigned — empty packet.",
    { interviewId: z.union([z.number(), z.string()]).describe("Interview ID") },
    withToolError(async ({ interviewId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getPacketForViewer({
        interviewId,
        tenantId: user.tenantId,
        viewerEmployeeId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_packet_view")
  );
}
