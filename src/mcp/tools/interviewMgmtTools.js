// src/mcp/tools/interviewMgmtTools.js
//
// MCP facade for the HR "Interview Management" screen: shaped list/detail rows
// (candidate + role + interviewers + averaged ratings), the FEEDBACK write
// (per-reviewer scorecard upsert) and the interview OUTCOME write (decision +
// COMPLETED). All gated on hr:recruitment (deny-by-default) and tenant-scoped
// via the verified ctx tenant. Complements the existing schedule/update tools
// (hr_interview_create / hr_interview_update / hr_interviews_list).
import { z } from "zod";
import {
  listInterviewsManaged,
  getInterviewManaged,
  scoreInterview,
  setInterviewOutcome,
  consolidateInterviewFeedback,
} from "../../services/interviewMgmt.service.js";
import {
  cancelInterview,
  requestReschedule,
  confirmReschedule,
  checkInterviewerAvailability,
  markCalendarSync,
  listLifecycleEvents,
} from "../../services/interviewSchedule.service.js";
import {
  createTemplate,
  updateTemplate,
  deactivateTemplate,
  listTemplates,
  linkTemplate,
  resolveForInterview,
} from "../../services/scorecardTemplate.service.js";
import { RESCHEDULE_REASONS } from "../../lib/interviewScheduling.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const ratingsSchema = z.object({
  technicalSkills: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  problemSolving: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  communication: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
  cultureFit: z.coerce.number().int().min(1).max(5).describe("Integer 1-5"),
});

export function registerInterviewMgmtTools(server) {
  server.tool(
    "hr_interviews_manage_list",
    "List interviews for the HR Interview Management screen: candidate, role, interviewers, status/decision, schedule and ratings averaged across scorecards. Supports candidate-name search, status/interviewType/decision filters, scheduledAt sort and pagination.",
    {
      q: z.string().optional().describe("Search by candidate name"),
      status: z.string().optional().describe("SCHEDULED | COMPLETED | CANCELLED | NO_SHOW"),
      interviewType: z.string().optional().describe("PHONE_SCREEN | TECHNICAL | BEHAVIORAL | PANEL | FINAL | ONSITE | VIDEO"),
      decision: z.string().optional().describe("NEXT_ROUND | HOLD | REJECTED"),
      sort: z.string().optional().describe("Sort field (default scheduledAt)"),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      // Phase 1.4 — MCP parity: the same record scope the REST list applies, so a
      // manager cannot read another manager's panels by switching transport.
      const data = await listInterviewsManaged({
        ...args,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interviews_manage_list")
  );

  server.tool(
    "hr_interview_manage_get",
    "Get full detail for a single interview incl. per-reviewer scorecards for the HR Interview Management screen.",
    {
      id: z.union([z.string(), z.number()]).describe("Interview id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getInterviewManaged({ id, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_manage_get")
  );

  server.tool(
    "hr_interview_feedback_consolidate",
    "Consolidate a panel's interview feedback for the hiring manager: per-reviewer overall/recommendation/notes (and whether the scorecard was amended after submission), per-criterion average/min/max/spread with attributed values, recommendations breakdown, and the panel members who have NOT submitted. Reports disagreement; it never approves or rejects anything.",
    {
      id: z.union([z.string(), z.number()]).describe("Interview id"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      // Phase 1.4 — MCP parity: same record scope as the REST interview reads.
      const data = await consolidateInterviewFeedback({
        id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_feedback_consolidate")
  );

  server.tool(
    "hr_interview_score",
    "Submit interview feedback: upsert the caller's scorecard (ratings, overall score, recommendation, comments) and set the interview decision/outcome. A scorecard that has already been submitted is LOCKED — changing it requires amendmentReason, and an identical resubmit is a no-op.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id (references Interview)"),
      ratings: ratingsSchema.describe("Scorecard ratings; each of technicalSkills, problemSolving, communication, cultureFit is an integer 1-5. Stored as the NOT-NULL scores JSON; overallScore is their average."),
      decision: z.enum(["NEXT_ROUND", "HOLD", "REJECTED"]).describe("Interview outcome decision — one of NEXT_ROUND | HOLD | REJECTED"),
      recommendation: z.enum(["STRONG_HIRE", "HIRE", "HOLD", "REJECTED"]).describe("Reviewer recommendation — one of STRONG_HIRE | HIRE | HOLD | REJECTED"),
      reason: z.string().optional().describe("Required when decision is REJECTED"),
      overrideReason: z.string().optional().describe("Required only when recording a decisive outcome with no scorecard on file — the override is stamped on the interview and audited"),
      comments: z.string().optional().describe("Free-text reviewer comments (stored as the scorecard notes)"),
      reviewerId: z.coerce.number().int().positive().optional().describe("Reviewer employee id (references Employee); defaults to the caller's employeeId. Provide when the caller has no employeeId (e.g. an admin scoring on someone's behalf) — the service 400s if neither is present."),
      amendmentReason: z.string().optional().describe("Required only to CHANGE a scorecard that has already been submitted (Phase 3.4 lock). Without it a changed payload is refused with HR-RECRUITMENT-SCORECARD-LOCKED; the reason is appended to the scorecard's amendment log with the values it replaced. Resending the identical payload never needs one."),
    },
    withToolError(async ({ interviewId, ratings, decision, recommendation, comments, reviewerId, reason, overrideReason, amendmentReason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      await scoreInterview({
        interviewId,
        reviewerId: reviewerId ?? user.employeeId,
        ratings,
        recommendation,
        comments,
        tenantId: user.tenantId,
        amendmentReason,
      });
      const data = await setInterviewOutcome({
        interviewId,
        decision,
        reason,
        overrideReason,
        actorId: user.employeeId,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_score")
  );

  server.tool(
    "hr_interview_set_outcome",
    "Set an interview outcome decision (and mark it COMPLETED).",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id (references Interview)"),
      decision: z.enum(["NEXT_ROUND", "HOLD", "REJECTED"]).describe("Interview outcome decision — one of NEXT_ROUND | HOLD | REJECTED; setting it also marks the interview COMPLETED"),
      reason: z.string().optional().describe("Required when decision is REJECTED"),
      overrideReason: z.string().optional().describe("Required only for a decisive outcome (NEXT_ROUND | REJECTED) when no scorecard has been submitted; recorded on the interview and audited"),
    },
    withToolError(async ({ interviewId, decision, reason, overrideReason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await setInterviewOutcome({
        interviewId,
        decision,
        reason,
        overrideReason,
        actorId: user.employeeId,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_set_outcome")
  );

  // ── Phase 7 / §5.1–5.4 — scheduling lifecycle ───────────────────────────

  server.tool(
    "hr_interview_cancel",
    "Cancel an interview with a MANDATORY coded reason (§5.4): CANDIDATE_REQUEST, INTERVIEWER_CONFLICT, BUSINESS_REQUEST, TECHNICAL_ISSUE, LOGISTICS_ISSUE, REQUISITION_CLOSED, OTHER (OTHER requires notes). The cancel is append-only audited; the candidate and panel are notified via the lifecycle event.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
      reasonCode: z.enum(["CANDIDATE_REQUEST", "INTERVIEWER_CONFLICT", "BUSINESS_REQUEST", "TECHNICAL_ISSUE", "LOGISTICS_ISSUE", "REQUISITION_CLOSED", "OTHER"]).describe("Why the interview is being cancelled"),
      notes: z.string().optional().describe("Free-text notes; REQUIRED when reasonCode is OTHER"),
    },
    withToolError(async ({ interviewId, reasonCode, notes }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await cancelInterview({
        interviewId,
        reasonCode,
        notes: notes ?? null,
        tenantId: user.tenantId,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_cancel")
  );

  server.tool(
    "hr_interview_reschedule_request",
    "Record a candidate's reschedule REQUEST (§5.3). Routes to the recruiter only — the panel is NOT notified until the replacement schedule is confirmed (§5.3a, no calendar churn).",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
      reasonCode: z.enum(["CANDIDATE_REQUEST", "INTERVIEWER_CONFLICT", "BUSINESS_REQUEST", "TECHNICAL_ISSUE", "LOGISTICS_ISSUE", "REQUISITION_CLOSED", "OTHER"]).describe("Why the reschedule is requested"),
      requestedFor: z.string().optional().describe("Proposed replacement time (ISO 8601)"),
      notes: z.string().optional().describe("Free-text notes; REQUIRED when reasonCode is OTHER"),
    },
    withToolError(async ({ interviewId, reasonCode, requestedFor, notes }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await requestReschedule({
        interviewId,
        reasonCode,
        notes: notes ?? null,
        requestedFor: requestedFor ?? null,
        tenantId: user.tenantId,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_reschedule_request")
  );

  server.tool(
    "hr_interview_reschedule_confirm",
    "Confirm the replacement schedule (§5.3 recruiter-owned). Runs the §5.2a availability gate first: approved leave = hard block (refused); non-working-day = warning requiring override=true + overrideReason. Moves the time and notifies the panel — the ONLY path that does.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
      scheduledAt: z.string().describe("New time (ISO 8601)"),
      reasonCode: z.enum(["CANDIDATE_REQUEST", "INTERVIEWER_CONFLICT", "BUSINESS_REQUEST", "TECHNICAL_ISSUE", "LOGISTICS_ISSUE", "REQUISITION_CLOSED", "OTHER"]).describe("Why the interview is moving"),
      notes: z.string().optional().describe("Free-text notes; REQUIRED when reasonCode is OTHER"),
      override: z.boolean().optional().describe("Authorize past a non-working-day warning"),
      overrideReason: z.string().optional().describe("Required when override is true"),
    },
    withToolError(async ({ interviewId, scheduledAt, reasonCode, notes, override, overrideReason }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await confirmReschedule({
        interviewId,
        scheduledAt,
        reasonCode,
        notes: notes ?? null,
        override: override === true,
        overrideReason: overrideReason ?? null,
        tenantId: user.tenantId,
        actorId: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_reschedule_confirm")
  );

  server.tool(
    "hr_interview_availability_check",
    "Check interviewer availability for a proposed slot (§5.2/5.2a): returns hard-blocked interviewers (approved leave — never overridable) and non-working-day warnings (overridable with authorization + reason). Call BEFORE scheduling or confirming.",
    {
      scheduledAt: z.string().describe("Proposed slot start (ISO 8601)"),
      durationMinutes: z.coerce.number().int().positive().optional().describe("Slot length (default 60)"),
      interviewerIds: z.array(z.coerce.number().int().positive()).describe("Employee ids to check"),
    },
    withToolError(async ({ scheduledAt, durationMinutes, interviewerIds }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await checkInterviewerAvailability({
        scheduledAt,
        durationMinutes,
        interviewerIds,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_availability_check")
  );

  server.tool(
    "hr_interview_calendar_sync",
    "Record/refresh the external calendar linkage for an interview (§5.1a): provider, provider event id and sync state. Called by the Communication calendar-sync boundary after it writes the provider event — HR stores the linkage, never the event content.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
      provider: z.string().min(1).describe("Calendar provider, e.g. GOOGLE_WORKSPACE | OUTLOOK_365"),
      calendarEventId: z.string().min(1).describe("Provider event id"),
      status: z.enum(["PENDING", "SYNCED", "FAILED"]).describe("Sync state"),
    },
    withToolError(async ({ interviewId, provider, calendarEventId, status }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await markCalendarSync({
        interviewId,
        provider,
        calendarEventId,
        status,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_calendar_sync")
  );

  server.tool(
    "hr_interview_lifecycle_list",
    "The lifecycle history of one interview: every cancel, reschedule and reschedule request with its coded §5.4 reason, notes, actor and the times involved. Oldest first — the order it happened.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
    },
    withToolError(async ({ interviewId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listLifecycleEvents({ interviewId, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_interview_lifecycle_list")
  );

  // ── Phase 7 / §5.5–5.5b — scorecard templates ───────────────────────────

  server.tool(
    "hr_scorecard_template_create",
    "Create a tenant scorecard template: an ordered criteria list [{ key, label?, weight?, required? }]. Weights are optional per §5.5a but all-or-none; equal weighting is the default; required defaults to true.",
    {
      name: z.string().min(1).describe("Template name"),
      description: z.string().optional(),
      criteria: z.array(z.object({
        key: z.string().min(1),
        label: z.string().optional(),
        weight: z.number().positive().optional(),
        required: z.boolean().optional(),
      })).min(1).describe("Ordered criteria"),
    },
    withToolError(async ({ name, description, criteria }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await createTemplate({ name, description: description ?? null, criteria, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_scorecard_template_create")
  );

  server.tool(
    "hr_scorecard_template_update",
    "Update a template's name/description/criteria. History note: submitted scorecards keep the §5.5c lock — updating a template never rewrites past submissions.",
    {
      templateId: z.coerce.number().int().positive(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      criteria: z.array(z.object({
        key: z.string().min(1),
        label: z.string().optional(),
        weight: z.number().positive().optional(),
        required: z.boolean().optional(),
      })).min(1).optional(),
    },
    withToolError(async ({ templateId, name, description, criteria }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await updateTemplate({ templateId, name, description, criteria, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_scorecard_template_update")
  );

  server.tool(
    "hr_scorecard_template_deactivate",
    "Deactivate a template (soft while links exist — it must keep resolving for the scorecards that cite it; hard-deleted only when nothing links to it).",
    { templateId: z.coerce.number().int().positive() },
    withToolError(async ({ templateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await deactivateTemplate({ templateId, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_scorecard_template_deactivate")
  );

  server.tool(
    "hr_scorecard_template_link",
    "Attach a template to a scope: REQUISITION (scopeId = requisition id), STAGE (scopeKey = interview type) or JOB_FAMILY (scopeId = position id). Resolution is most-specific-first: requisition → stage → job family.",
    {
      templateId: z.coerce.number().int().positive(),
      scopeType: z.enum(["REQUISITION", "STAGE", "JOB_FAMILY"]),
      scopeId: z.coerce.number().int().positive().optional(),
      scopeKey: z.string().min(1).optional(),
    },
    withToolError(async ({ templateId, scopeType, scopeId, scopeKey }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await linkTemplate({ templateId, scopeType, scopeId, scopeKey, tenantId: user.tenantId, actorId: user.employeeId ?? null });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_scorecard_template_link")
  );

  server.tool(
    "hr_scorecard_template_resolve",
    "Which template governs one interview? Most-specific-first resolution (requisition → stage → job family); null means free-form scoring.",
    { interviewId: z.coerce.number().int().positive().describe("Interview id") },
    withToolError(async ({ interviewId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await resolveForInterview({ interviewId, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_scorecard_template_resolve")
  );
}
