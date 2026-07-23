import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // GUC-in-tx so the atomic interview+stage write passes FORCE-RLS

// C.2 — verified tenant (T-P2.1) threaded in as a `tenantId` field on the args
// object / trailing param; folded into reads and stamped on creates, fail-closed
// so tenant B can never read/mutate tenant A's interviews/scorecards.

export const scheduleInterview = async ({ applicationId, type, interviewType, scheduledAt, durationMinutes, location, interviewerIds, notes, tenantId }) => {
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
        const interview = await tx.interview.create({
            data: scopedData(tenantId, {
                applicationId: Number(applicationId),
                interviewType: interviewType || type || "PANEL",
                scheduledAt: scheduledDate,
                durationMinutes: durationMinutes || 60,
                location,
                notes,
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

        if (applicationId != null) {
            await tx.application.updateMany({
                where: scopedWhere(tenantId, {
                    id: Number(applicationId),
                    stage: { notIn: ["interview", "offer", "hired", "rejected"] },
                }),
                data: { stage: "interview" },
            });
        }

        return interview;
    });
};

export const listInterviews = async ({ applicationId, page = 1, limit = 20, tenantId }) => {
    const where = scopedWhere(tenantId, applicationId ? { applicationId: Number(applicationId) } : {});
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
                            select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true, photo_url: true },
                        },
                    },
                },
                scorecards: true,
            },
        }),
        prisma.interview.count({ where }),
    ]);
    return { items, total, page, limit };
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
                select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true, photo_url: true },
            },
        },
    },
    scorecards: true,
};

const normalizeInterviewUpdateData = (data = {}) => {
    const { feedback, decision, type, interviewType, reviewerId, ...rest } = data;
    const updateData = { ...rest };

    if (type || interviewType) {
        updateData.interviewType = interviewType || type;
    }

    if (decision) {
        updateData.notes = updateData.notes
            ? `${updateData.notes}\nDecision: ${decision}`
            : `Decision: ${decision}`;
    }

    return { updateData, feedback, reviewerId };
};

const averageRating = (ratings = {}) => {
    const values = Object.values(ratings).filter((value) => Number.isFinite(Number(value)));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
};

export const updateInterview = async (id, data = {}, tenantId) => {
    const interviewId = Number(id);
    const { updateData, feedback, reviewerId } = normalizeInterviewUpdateData(data);

    // Tenant-scoped pre-read so a cross-tenant id cannot be mutated (fail-closed).
    const existingInterview = await prisma.interview.findFirst({ where: scopedWhere(tenantId, { id: interviewId }) });
    if (!existingInterview) throw new Error("Interview not found");

    await prisma.interview.update({
        where: { id: interviewId },
        data: updateData,
    });

    if (feedback) {
        const { ratings = {}, decision, recommendation, comments } = feedback;
        const resolvedReviewerId = Number(reviewerId || 1);
        const scorePayload = {
            scores: ratings,
            overallScore: averageRating(ratings),
            recommendation: recommendation || decision || null,
            notes: comments || null,
            submittedAt: new Date(),
        };

        const existing = await prisma.interviewScorecard.findUnique({
            where: {
                interviewId_reviewerId: {
                    interviewId,
                    reviewerId: resolvedReviewerId,
                },
            },
        });

        if (existing) {
            await prisma.interviewScorecard.update({
                where: { id: existing.id },
                data: scorePayload,
            });
        } else {
            await prisma.interviewScorecard.create({
                data: scopedData(tenantId, {
                    interviewId,
                    reviewerId: resolvedReviewerId,
                    ...scorePayload,
                }),
            });
        }
    }

    return prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id: interviewId }),
        include: interviewInclude,
    });
};

export const submitScorecard = async ({ interviewId, reviewerId, scores, overallScore, recommendation, notes, tenantId }) => {
    return prisma.interviewScorecard.create({
        data: scopedData(tenantId, {
            interviewId: Number(interviewId),
            reviewerId: Number(reviewerId),
            scores: scores || {},
            overallScore: overallScore ? Number(overallScore) : null,
            recommendation,
            notes,
        }),
    });
};

export const getScorecards = async (interviewId, tenantId) => {
    return prisma.interviewScorecard.findMany({
        where: scopedWhere(tenantId, { interviewId: Number(interviewId) }),
        include: { reviewer: { select: { id: true, employee_name: true, first_name: true, last_name: true } } },
    });
};
