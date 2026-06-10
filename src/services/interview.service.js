import prisma from "../config/prisma.js";

export const scheduleInterview = async ({ applicationId, type, interviewType, scheduledAt, durationMinutes, location, interviewerIds, notes }) => {
    return prisma.interview.create({
        data: {
            applicationId: Number(applicationId),
            interviewType: interviewType || type || "PANEL",
            scheduledAt: new Date(scheduledAt),
            durationMinutes: durationMinutes || 60,
            location,
            notes,
            interviewers: interviewerIds?.length
                ? { create: interviewerIds.map(id => ({ employeeId: Number(id) })) }
                : undefined,
        },
        include: {
            interviewers: {
                include: {
                    employee: {
                        select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true },
                    },
                },
            },
        },
    });
};

export const listInterviews = async ({ applicationId, page = 1, limit = 20 }) => {
    const where = applicationId ? { applicationId: Number(applicationId) } : {};
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
                            select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true },
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
                select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true },
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

export const updateInterview = async (id, data = {}) => {
    const interviewId = Number(id);
    const { updateData, feedback, reviewerId } = normalizeInterviewUpdateData(data);

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
                data: {
                    interviewId,
                    reviewerId: resolvedReviewerId,
                    ...scorePayload,
                },
            });
        }
    }

    return prisma.interview.findUnique({
        where: { id: interviewId },
        include: interviewInclude,
    });
};

export const submitScorecard = async ({ interviewId, reviewerId, scores, overallScore, recommendation, notes }) => {
    return prisma.interviewScorecard.create({
        data: {
            interviewId: Number(interviewId),
            reviewerId: Number(reviewerId),
            scores: scores || {},
            overallScore: overallScore ? Number(overallScore) : null,
            recommendation,
            notes,
        },
    });
};

export const getScorecards = async (interviewId) => {
    return prisma.interviewScorecard.findMany({
        where: { interviewId: Number(interviewId) },
        include: { reviewer: { select: { id: true, employee_name: true, first_name: true, last_name: true } } },
    });
};
