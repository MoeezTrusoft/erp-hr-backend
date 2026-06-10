// src/services/applicationService.js
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
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
    const create = await prisma.application.create({
        data: {
            candidateId,
            jobRequisitionId,
            stage,
            status,
            tenantId: tenantId ?? null,
            createdById: Number(createdById) ?? null,
        },
        include: {
            candidate: true,
            jobRequisition: true,
        },
    });
    await logAction({
        employeeId: createdById ?? null,
        type: "CREATE",
        module: "Application",
        result: "SUCCESS",
            notes: `Application "${create.id}" created successfully for candidate "${candidateId}" on job "${jobRequisitionId}".`,
    });


    return create;
};

/**
 * Update stage of an application
 */
export const updateApplicationStage = async ({ id, tenantId, stage,updatedById }) => {
    const update = prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { stage },
    });

 await logAction({
            employeeId: Number(updatedById) ?? null,
            type: "UPDATE",
            module: "Application",
            result: "SUCCESS",
            notes: `Application "${id}" stage updated to "${stage}".`,
        });
    return update
};

/**
 * Update status (open/closed/hired/rejected)
 */
export const updateApplicationStatus = async ({ id, tenantId, status, updatedById }) => {
    const updateStatus = await prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { status },
    });

 await logAction({
            employeeId: Number(updatedById) ?? null,
            type: "UPDATE",
            module: "Application",
            result: "SUCCESS",
            notes: `Application "${id}" status updated to "${status}".`,
        });
    return updateStatus;
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
