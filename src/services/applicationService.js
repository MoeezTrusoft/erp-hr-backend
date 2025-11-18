// src/services/applicationService.js
import prisma from "../config/prisma.js";

/**
 * Create an application: candidate → jobRequisition
 */
export const createApplication = async ({
    candidateId,
    jobRequisitionId,
    stage = "applied",
    status = "open",
    tenantId,
    createdById,
}) => {
    return prisma.application.create({
        data: {
            candidateId,
            jobRequisitionId,
            stage,
            status,
            tenantId: tenantId ?? null,
            createdById: createdById ?? null,
        },
        include: {
            candidate: true,
            jobRequisition: true,
        },
    });
};

/**
 * Update stage of an application
 */
export const updateApplicationStage = async ({ id, tenantId, stage }) => {
    return prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { stage },
    });
};

/**
 * Update status (open/closed/hired/rejected)
 */
export const updateApplicationStatus = async ({ id, tenantId, status }) => {
    return prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { status },
    });
};

/**
 * List applications with filters
 */
export const listApplications = async ({
    tenantId,
    jobRequisitionId,
    candidateId,
    stage,
    status,
    page = 1,
    limit = 20,
}) => {
    const skip = (page - 1) * limit;

    const where = {
        tenantId: tenantId ?? null,
        ...(jobRequisitionId ? { jobRequisitionId } : {}),
        ...(candidateId ? { candidateId } : {}),
        ...(stage ? { stage } : {}),
        ...(status ? { status } : {}),
    };

    const [items, total] = await Promise.all([
        prisma.application.findMany({
            where,
            include: {
                candidate: true,
                jobRequisition: true,
            },
            orderBy: { appliedAt: "desc" },
            skip,
            take: limit,
        }),
        prisma.application.count({ where }),
    ]);

    return { items, total, page, limit };
};
