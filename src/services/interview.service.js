import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { interviewScopeWhere, maskInterviewsForScope } from "../lib/recruitmentAccess.js";
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
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";

// C.2 — verified tenant (T-P2.1) threaded in as a `tenantId` field on the args
// object / trailing param; folded into reads and stamped on creates, fail-closed
// so tenant B can never read/mutate tenant A's interviews/scorecards.

export const scheduleInterview = async ({ applicationId, type, interviewType, scheduledAt, durationMinutes, location, interviewerIds, notes, tenantId, conflictOverride }) => {
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
    return tenantTransaction(prisma, async (tx) => {
        // Phase 7 / §5.2a — the availability gate runs BEFORE any write.
        // APPROVED leave on any panelist is a HARD block (refused, not
        // overridable); a non-working-day conflict is only a warning tier, so
        // the scheduling UI may pass it with an authorized override + reason —
        // audited below. Same rule the reschedule-confirm path applies.
        const ids = (interviewerIds ?? []).map(Number).filter(Boolean);
        if (ids.length) {
            const end = new Date(scheduledDate.getTime() + Number(durationMinutes || 60) * 60000);
            const leaveRows = await tx.leaveRequest.findMany({
                where: scopedWhere(tenantId, { employeeId: { in: ids }, status: "APPROVED" }),
                select: { employeeId: true, startDate: true, endDate: true },
            });
            const blocked = blockedInterviewers(scheduledDate, end, leaveRows);
            if (blocked.length) {
                throw Object.assign(new Error("Interviewer(s) on approved leave for the proposed slot"), {
                    status: 409,
                    details: { code: "HR-RECRUITMENT-SCHEDULE-LEAVE-BLOCK", blockedInterviewerIds: blocked },
                });
            }
            if (conflictOverride) {
                // Recorded as the caller's attestation; the non-working-day
                // warning is advisory (§5.2a), so scheduling proceeds.
                await logAction({
                    employeeId: null,
                    type: "UPDATE",
                    module: "Interview Scheduling",
                    result: "SUCCESS",
                    notes: `Non-working-day conflict overridden on new interview for application "${applicationId}": ${String(conflictOverride).slice(0, 500)}`,
                    tenantId: tenantId ?? null,
                });
            }
        }

        const interview = await tx.interview.create({
            data: scopedData(tenantId, {
                applicationId: Number(applicationId),
                interviewType: interviewType || type || "PANEL",
                scheduledAt: scheduledDate,
                durationMinutes: durationMinutes || 60,
                location,
                notes,
                calendarSyncStatus: "PENDING",
                interviewers: interviewerIds?.length
                    ? { create: interviewerIds.map(id => ({ employeeId: Number(id), ...(tenantId === undefined ? {} : { tenantId: tenantId ?? null }) })) }
                    : undefined,
            }),
            include: {
                interviewers: {
                    include: {
                        employee: {
                            select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true, photo_url: true },
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
                throw Object.assign(new Error(`Application "${applicationId}" not found`), { status: 404 });
            }
            // D-11 — an interview invitation is candidate-facing contact, so it
            // passes the same do-not-contact and consent gate as an offer send.
            // A refusal rolls back the interview created above.
            if (application.candidateId != null) {
                await assertCommunicationsAllowed(
                    { tenantId, candidateId: application.candidateId, purpose: "PROCESSING" },
                    { db: tx },
                );
            }
            if (application.stage !== "interview" && !["offer", "hired", "rejected", "withdrawn"].includes(application.stage)) {
                await transitionApplicationStageInTransaction({
                    id: application.id,
                    tenantId,
                    targetStage: "interview",
                    reason: "Interview scheduled",
                    source: "interview-schedule",
                }, tx);
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
    });
};

// Phase 1.4 — `scope` narrows the read to the caller's record scope (an
// interviewer sees only panels they sit on, a manager only their requisitions')
// and masks interviewer notes for scopes that must not read them.
export const listInterviews = async ({ applicationId, page = 1, limit = 20, tenantId, scope = null }) => {
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
                        candidate: { omit: { parsedResume: true } },
                        jobRequisition: { include: { position: true } },
                    },
                },
                interviewers: {
                    include: {
                        employee: {
                            select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true, photo_url: true },
                        },
                    },
                },
                scorecards: true,
            },
        }),
        prisma.interview.count({ where }),
    ]);
    return { items: maskInterviewsForScope(items.map((item) => ownScorecardsOnly(item, scope)), scope), total, page, limit };
};

// Independent scoring: a panelist reads only their own scorecard until the
// consolidation step, so an earlier reviewer's score cannot anchor theirs.
// Recruiters (ORG) and hiring managers (MANAGED) see the whole panel.
function ownScorecardsOnly(interview, scope) {
    if (!scope || scope.unrestricted || scope.level !== "ASSIGNED") return interview;
    const mine = String(scope.employeeId ?? "");
    return {
        ...interview,
        scorecards: (interview.scorecards || []).filter((card) => String(card.reviewerId) === mine),
    };
}

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
                select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true, photo_url: true },
            },
        },
    },
    scorecards: true,
};

const normalizeInterviewUpdateData = (data = {}) => {
    // Phase 3.4 — `amendmentReason` is a control input, not a column: it must be
    // pulled out here so it can never land in updateData (which spreads into the
    // prisma update) and so the scorecard writer learns a change is authorised.
    const { feedback, decision, type, interviewType, reviewerId, amendmentReason, ...rest } = data;
    const updateData = { ...rest };

    if (type || interviewType) {
        updateData.interviewType = interviewType || type;
    }

    if (decision) {
        updateData.notes = updateData.notes
            ? `${updateData.notes}\nDecision: ${decision}`
            : `Decision: ${decision}`;
    }

    return { updateData, feedback, reviewerId, amendmentReason };
};

const averageRating = (ratings = {}) => {
    const values = Object.values(ratings).filter((value) => Number.isFinite(Number(value)));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
};

export const updateInterview = async (id, data = {}, tenantId) => {
    const interviewId = Number(id);
    const { updateData, feedback, reviewerId, amendmentReason } = normalizeInterviewUpdateData(data);

    // Tenant-scoped pre-read so a cross-tenant id cannot be mutated (fail-closed).
    const existingInterview = await prisma.interview.findFirst({ where: scopedWhere(tenantId, { id: interviewId }) });
    if (!existingInterview) throw new Error("Interview not found");

    await prisma.interview.update({
        where: { id: interviewId },
        data: updateData,
    });

    if (feedback) {
        const { ratings = {}, decision, recommendation, comments } = feedback;
        // HR-INTERVIEW-FEEDBACK-01 — a scorecard is attributable evidence, so it
        // must name a real reviewer. This used to fall back to employee id 1,
        // silently filing feedback under whoever that is whenever the caller's
        // token carried no employeeId. Fail loudly instead, like scoreInterview.
        const resolvedReviewerId = Number(reviewerId);
        if (!Number.isInteger(resolvedReviewerId) || resolvedReviewerId <= 0) {
            throw Object.assign(
                new Error("A reviewer (employee) id is required to submit interview feedback"),
                { status: 400 },
            );
        }
        const scorePayload = {
            scores: ratings,
            overallScore: averageRating(ratings),
            recommendation: recommendation || decision || null,
            notes: comments || null,
            submittedAt: new Date(),
        };

        // HR-INTERVIEW-FEEDBACK-01 — feedback must be re-submittable: one shared
        // create-or-update keyed on the real unique index, so an existing (or
        // legacy tenant-less) scorecard is updated instead of colliding on
        // insert with "Unique constraint failed".
        await upsertInterviewScorecard({
            interviewId,
            reviewerId: resolvedReviewerId,
            data: scorePayload,
            tenantId,
            // Phase 3.4 — an already-submitted scorecard only changes through
            // this explicit, attributed amendment path.
            amendment: amendmentReason
                ? { reason: amendmentReason, by: resolvedReviewerId }
                : null,
        });
    }

    return prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id: interviewId }),
        include: interviewInclude,
    });
};

export const submitScorecard = async ({ interviewId, reviewerId, scores, overallScore, recommendation, notes, tenantId }) => {
    // HR-INTERVIEW-FEEDBACK-01 — was an unconditional create, so a reviewer
    // could never revise their own scorecard (P2002 on the second submit).
    const interview = await prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id: Number(interviewId) }),
        select: { id: true },
    });
    if (!interview) throw Object.assign(new Error("Interview not found"), { status: 404 });

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
    return prisma.interviewScorecard.findMany({
        where: scopedWhere(tenantId, { interviewId: Number(interviewId) }),
        include: { reviewer: { select: { id: true, employee_name: true, first_name: true, last_name: true } } },
    });
};
