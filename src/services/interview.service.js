import prisma from "../config/prisma.js";

export const scheduleInterview = async ({ applicationId, type, scheduledAt, durationMinutes, location, interviewerIds, notes }) => {
    return prisma.interview.create({
        data: {
            applicationId: Number(applicationId),
            type: type || "PANEL",
            scheduledAt: new Date(scheduledAt),
            durationMinutes: durationMinutes || 60,
            location,
            notes,
            interviewers: interviewerIds?.length
                ? { create: interviewerIds.map(id => ({ employeeId: Number(id) })) }
                : undefined,
        },
        include: { interviewers: { include: { employee: { select: { id: true, firstName: true, lastName: true } } } } },
    });
};

export const listInterviews = async ({ applicationId, page = 1, limit = 20 }) => {
    const where = applicationId ? { applicationId: Number(applicationId) } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.interview.findMany({ where, skip, take: limit, orderBy: { scheduledAt: "asc" }, include: { interviewers: true, scorecards: true } }),
        prisma.interview.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const updateInterview = async (id, data) => {
    return prisma.interview.update({ where: { id: Number(id) }, data });
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
        include: { reviewer: { select: { id: true, firstName: true, lastName: true } } },
    });
};
