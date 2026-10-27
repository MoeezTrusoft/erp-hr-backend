import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  readInterviewCalendarAvailability,
  assertInterviewCalendarAvailable,
  lockInterviewPanel,
} from "./recruitmentCalendar.service.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import { pinInterviewAssessment } from "./candidate-assessment/forms.js";
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import {
  resolveRecruitmentScope,
  applicationScopeWhere,
  interviewScopeWhere,
  maskInterviewForScope,
  maskInterviewsForScope,
  hidePeerFeedback,
} from "../lib/recruitmentAccess.js";
import { upsertInterviewScorecard } from "./interview-scorecard.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // GUC-in-tx so the atomic interview+stage write passes FORCE-RLS
import { transitionApplicationStageInTransaction } from "./applicationWorkflow.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { logAction } from "../utils/logs.js";
import { interviewScheduledEvent } from "./hrEvents.js";
// Phase 7 / §5.2/5.2a — the SAME availability rule the reschedule-confirm path
// uses, so a fresh schedule and a moved schedule cannot disagree about what
// counts as a conflict.
import { blockedInterviewers } from "../lib/interviewScheduling.js";

// C.2 — verified tenant (T-P2.1) threaded in as a `tenantId` field on the args
// object / trailing param; folded into reads and stamped on creates, fail-closed
// so tenant B can never read/mutate tenant A's interviews/scorecards.

export const scheduleInterview = async ({
  applicationId,
  type,
  interviewType,
  scheduledAt,
  durationMinutes,
  location,
  siteRef,
  interviewerIds,
  notes,
  tenantId,
  conflictOverride,
  panelRoles = {},
}) => {
  // Scheduling an interview also advances the linked application's pipeline
  // stage to "interview" (parity with hr_application_update_stage), so the
  // recruitment board stays coherent without a separate manual move. The two
  // writes are atomic (one tx) and tenant-scoped. The stage move is guarded so
  // it never REGRESSES an application already further along or closed
  // (offer/hired/rejected) — a follow-up interview must not undo an offer.
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    throw new Error("scheduledAt must be a valid ISO 8601 datetime");
  }
  const ctx = getCtx();
  if (!ctx.actorVerified || ctx.user.tenantId !== tenantId)
    throw Object.assign(new Error("Verified company context required"), {
      status: 401,
    });
  assertPermission(ctx.permissions, "POST", "hr:recruitment", false);
  if (
    !Number.isInteger(Number(durationMinutes ?? 60)) ||
    Number(durationMinutes ?? 60) < 5 ||
    Number(durationMinutes ?? 60) > 480
  )
    throw Object.assign(new Error("Interview duration must be 5–480 minutes"), {
      status: 422,
    });
  return tenantTransaction(prisma, async (tx) => {
    const who = await actor(tx, ctx),
      scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
    if (!["ORG", "MANAGED"].includes(scope.level))
      throw Object.assign(new Error("Recruiter or hiring manager required"), {
        status: 403,
      });
    await tx.$queryRawUnsafe(
      'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
      Number(applicationId),
      tenantId,
    );
    const applicationRow = await tx.application.findFirst({
      where: {
        tenantId,
        id: Number(applicationId),
        ...applicationScopeWhere(scope),
      },
    });
    if (!applicationRow)
      throw Object.assign(new Error("Application not found"), { status: 404 });
    if (["hired", "rejected", "withdrawn"].includes(applicationRow.stage))
      throw Object.assign(
        new Error("A closed application cannot be scheduled"),
        { status: 409 },
      );
    return createScheduledInterview(tx, {
      applicationId,
      type,
      interviewType,
      scheduledAt,
      durationMinutes,
      location,
      siteRef,
      interviewerIds,
      notes,
      tenantId,
      conflictOverride,
      panelRoles,
      actorId: who.id,
    });
  });
};

// Internal transaction primitive: callers must authorize and lock the application first.
// Candidate booking calls this only with a stored, recruiter-approved slot offer.
export async function createScheduledInterview(
  tx,
  {
    applicationId,
    type,
    interviewType,
    scheduledAt,
    durationMinutes,
    location,
    siteRef,
    interviewerIds,
    notes,
    tenantId,
    conflictOverride,
    panelRoles = {},
    actorId = null,
  },
) {
  const scheduledDate = new Date(scheduledAt);
  const who = { id: actorId };
  const panelIds = (interviewerIds ?? []).map(Number);
  if (
    !panelIds.length ||
    panelIds.some((id) => !Number.isInteger(id) || id <= 0) ||
    new Set(panelIds).size !== panelIds.length
  )
    throw Object.assign(new Error("Assign a distinct employee panel"), {
      status: 422,
    });
  const employees = await tx.employee.findMany({
    where: { tenant_id: tenantId, id: { in: panelIds } },
    select: { id: true, status: true, employement_status: true },
  });
  if (
    employees.length !== panelIds.length ||
    employees.some((e) =>
      /inactive|terminated|exited|offboard|separated/i.test(
        [e.status, e.employement_status].join(" "),
      ),
    )
  )
    throw Object.assign(
      new Error("Every panelist must be an active employee in this company"),
      { status: 422 },
    );

  if (isRecruitmentFlagEnabled("calendar")) {
    await lockInterviewPanel(tx, tenantId, panelIds);
    const availability = await readInterviewCalendarAvailability(tx, {
      tenantId,
      scheduledAt: scheduledDate,
      durationMinutes,
      interviewerIds: panelIds,
    });
    assertInterviewCalendarAvailable(availability, conflictOverride);
    if (conflictOverride)
      await logAction({
        employeeId: who.id,
        type: "UPDATE",
        module: "Interview Scheduling",
        result: "SUCCESS",
        notes: `HR calendar override for application "${applicationId}": ${String(conflictOverride).slice(0, 500)}`,
        tenantId,
      });
  }
  // Phase 7 / §5.2a — the availability gate runs BEFORE any write.
  // APPROVED leave on any panelist is a HARD block (refused, not
  // overridable); a non-working-day conflict is only a warning tier, so
  // the scheduling UI may pass it with an authorized override + reason —
  // audited below. Same rule the reschedule-confirm path applies.
  const ids = (interviewerIds ?? []).map(Number).filter(Boolean);
  if (ids.length && !isRecruitmentFlagEnabled("calendar")) {
    const end = new Date(
      scheduledDate.getTime() + Number(durationMinutes || 60) * 60000,
    );
    const leaveRows = await tx.leaveRequest.findMany({
      where: scopedWhere(tenantId, {
        employeeId: { in: ids },
        status: "APPROVED",
      }),
      select: { employeeId: true, startDate: true, endDate: true },
    });
    const blocked = blockedInterviewers(scheduledDate, end, leaveRows);
    if (blocked.length) {
      throw Object.assign(
        new Error("Interviewer(s) on approved leave for the proposed slot"),
        {
          status: 409,
          details: {
            code: "HR-RECRUITMENT-SCHEDULE-LEAVE-BLOCK",
            blockedInterviewerIds: blocked,
          },
        },
      );
    }
    if (conflictOverride) {
      // Recorded as the caller's attestation; the non-working-day
      // warning is advisory (§5.2a), so scheduling proceeds.
      await logAction({
        employeeId: who.id,
        type: "UPDATE",
        module: "Interview Scheduling",
        result: "SUCCESS",
        notes: `Non-working-day conflict overridden on new interview for application "${applicationId}": ${String(conflictOverride).slice(0, 500)}`,
        tenantId: tenantId ?? null,
      });
    }
  }

  const panelMembers = (interviewerIds ?? []).map((id) => ({
    employeeId: Number(id),
    panelRole: panelRoles[id] ?? null,
  }));
  const assessmentFields = await pinInterviewAssessment(
    tx,
    tenantId,
    applicationId,
    interviewType || type || "PANEL",
    panelMembers,
  );
  const interview = await tx.interview.create({
    data: scopedData(tenantId, {
      ...assessmentFields,
      applicationId: Number(applicationId),
      interviewType: interviewType || type || "PANEL",
      scheduledAt: scheduledDate,
      durationMinutes: durationMinutes || 60,
      location,
      siteRef: siteRef ?? null,
      notes,
      calendarSyncStatus: "PENDING",
      interviewers: interviewerIds?.length
        ? {
            create: interviewerIds.map((id) => ({
              employeeId: Number(id),
              panelRole: panelRoles[id] ?? null,
              ...(tenantId === undefined ? {} : { tenantId: tenantId ?? null }),
            })),
          }
        : undefined,
    }),
    include: {
      interviewers: {
        include: {
          employee: {
            select: {
              id: true,
              employee_name: true,
              first_name: true,
              last_name: true,
              job_title: true,
              photo_url: true,
            },
          },
        },
      },
    },
  });

  // Hoisted for the event below (the lookup lives inside the branch, the
  // candidate id is needed after it).
  let applicationCandidateId = null;
  if (applicationId != null) {
    const application = await tx.application.findFirst({
      where: scopedWhere(tenantId, { id: Number(applicationId) }),
      select: { id: true, stage: true, candidateId: true },
    });
    applicationCandidateId = application?.candidateId ?? null;
    if (!application) {
      throw Object.assign(
        new Error(`Application "${applicationId}" not found`),
        { status: 404 },
      );
    }
    if (
      application.stage !== "interview" &&
      !["offer", "hired", "rejected", "withdrawn"].includes(application.stage)
    ) {
      await transitionApplicationStageInTransaction(
        {
          id: application.id,
          tenantId,
          targetStage: "interview",
          reason: "Interview scheduled",
          source: "interview-schedule",
        },
        tx,
      );
    }
  }

  // Phase 11 — the invitation is announced with the interview it describes,
  // in the same transaction. ids-only, so a downstream notification consumer
  // fans out to the panel without HR ever publishing names or addresses.
  await enqueueHrDomainEvent(
    tx,
    interviewScheduledEvent(
      {
        id: interview.id,
        applicationId: Number(applicationId) || null,
        candidateId: applicationCandidateId,
        scheduledAt: scheduledDate.toISOString(),
        tenantId: interview.tenantId ?? null,
      },
      { actorId: null },
      { interviewerIds: (interviewerIds ?? []).map(Number) },
    ),
  );

  return interview;
}

// Phase 1.4 — `scope` narrows the read to the caller's record scope (an
// interviewer sees only panels they sit on, a manager only their requisitions')
// and masks interviewer notes for scopes that must not read them.
export const listInterviews = async ({
  applicationId,
  page = 1,
  limit = 20,
  tenantId,
  scope = resolveRecruitmentScope(getCtx().user),
}) => {
  const scopeWhere = scope ? interviewScopeWhere(scope) : {};
  const where = scopedWhere(tenantId, {
    ...(applicationId ? { applicationId: Number(applicationId) } : {}),
    ...scopeWhere,
  });
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.interview.findMany({
      where,
      skip,
      take: limit,
      orderBy: { scheduledAt: "asc" },
      include: {
        application: {
          include: {
            candidate: true,
            jobRequisition: { include: { position: true } },
          },
        },
        interviewers: {
          include: {
            employee: {
              select: {
                id: true,
                employee_name: true,
                first_name: true,
                last_name: true,
                job_title: true,
                photo_url: true,
              },
            },
          },
        },
        scorecards: true,
      },
    }),
    prisma.interview.count({ where }),
  ]);
  return { items: maskInterviewsForScope(items, scope), total, page, limit };
};

const interviewInclude = {
  application: {
    include: {
      candidate: true,
      jobRequisition: { include: { position: true } },
    },
  },
  interviewers: {
    include: {
      employee: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          job_title: true,
          photo_url: true,
        },
      },
    },
  },
  scorecards: true,
};

const normalizeInterviewUpdateData = (data = {}) => {
  // Phase 3.4 — `amendmentReason` is a control input, not a column: it must be
  // pulled out here so it can never land in updateData (which spreads into the
  // prisma update) and so the scorecard writer learns a change is authorised.
  const {
    feedback,
    decision,
    type,
    interviewType,
    reviewerId,
    amendmentReason,
    ...rest
  } = data;
  const allowed = new Set([
    "scheduledAt",
    "durationMinutes",
    "location",
    "notes",
  ]);
  if (Object.keys(rest).some((k) => !allowed.has(k)))
    throw Object.assign(
      new Error(
        "Use the interview workflow to change status, panel or assessment fields",
      ),
      { status: 422, code: "HR-6101" },
    );
  const updateData = { ...rest };

  if (type || interviewType) {
    updateData.interviewType = interviewType || type;
  }

  if (decision)
    throw Object.assign(
      new Error("Use the interview outcome workflow to record a decision"),
      { status: 409 },
    );

  return { updateData, feedback, reviewerId, amendmentReason };
};

export const updateInterview = async (id, data = {}, tenantId) => {
  const ctx = getCtx(),
    scope = resolveRecruitmentScope(ctx.user),
    interviewId = Number(id);
  if (!ctx.actorVerified || ctx.user.tenantId !== tenantId)
    throw Object.assign(new Error("Verified company context required"), {
      status: 401,
    });
  assertPermission(ctx.permissions, "PUT", "hr:recruitment", false);
  const { updateData, feedback, reviewerId, amendmentReason } =
    normalizeInterviewUpdateData(data);
  if (feedback && Object.keys(updateData).length)
    throw Object.assign(
      new Error("Submit feedback separately from interview edits"),
      { status: 422 },
    );
  if (feedback) {
    await upsertInterviewScorecard({
      interviewId,
      reviewerId,
      data: {
        scores: feedback.ratings ?? {},
        recommendation: feedback.recommendation ?? null,
        notes: feedback.comments || null,
      },
      tenantId,
      amendment: amendmentReason ? { reason: amendmentReason } : null,
    });
  } else {
    if (!["ORG", "MANAGED"].includes(scope.level))
      throw Object.assign(new Error("Recruiter or hiring manager required"), {
        status: 403,
      });
    if (Object.keys(updateData).some((k) => !["notes", "location"].includes(k)))
      throw Object.assign(
        new Error("Use the rescheduling workflow to change schedule or round"),
        { status: 409 },
      );
    await tenantTransaction(
      prisma,
      async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT id FROM interviews WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
          interviewId,
          tenantId,
        );
        const current = await tx.interview.findFirst({
          where: { tenantId, id: interviewId, ...interviewScopeWhere(scope) },
        });
        if (!current)
          throw Object.assign(new Error("Interview not found"), {
            status: 404,
          });
        if (current.status !== "SCHEDULED")
          throw Object.assign(
            new Error("Only scheduled interviews may be edited"),
            { status: 409 },
          );
        await tx.interview.update({
          where: { id: interviewId },
          data: updateData,
        });
      },
      { tenantId },
    );
  }
  const result = await prisma.interview.findFirst({
    where: { tenantId, id: interviewId, ...interviewScopeWhere(scope) },
    include: interviewInclude,
  });
  return maskInterviewForScope(result, scope);
};

export const submitScorecard = async ({
  interviewId,
  reviewerId,
  scores,
  overallScore,
  recommendation,
  notes,
  tenantId,
}) => {
  // HR-INTERVIEW-FEEDBACK-01 — was an unconditional create, so a reviewer
  // could never revise their own scorecard (P2002 on the second submit).
  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: Number(interviewId) }),
    select: { id: true },
  });
  if (!interview)
    throw Object.assign(new Error("Interview not found"), { status: 404 });

  return upsertInterviewScorecard({
    interviewId: Number(interviewId),
    reviewerId: Number(reviewerId),
    data: {
      scores: scores || {},
      overallScore: overallScore ? Number(overallScore) : null,
      recommendation,
      notes,
    },
    tenantId,
  });
};

export const getScorecards = async (interviewId, tenantId) => {
  const scope = resolveRecruitmentScope(getCtx().user);
  const interview = await prisma.interview.findFirst({
    where: { tenantId, id: Number(interviewId), ...interviewScopeWhere(scope) },
    include: {
      interviewers: true,
      scorecards: {
        include: {
          reviewer: {
            select: {
              id: true,
              employee_name: true,
              first_name: true,
              last_name: true,
            },
          },
        },
      },
    },
  });
  if (!interview)
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  return hidePeerFeedback(interview, scope).scorecards;
};
