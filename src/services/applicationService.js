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
export const updateApplicationStage = async ({ id, tenantId, stage, updatedById }) => {
    // The Kanban board groups by the lowercase PIPELINE_STAGES enum and SKIPS
    // unknown-cased stages, so normalize here — callers may send "SCREENING".
    const normalizedStage = String(stage).toLowerCase();
    const update = await prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { stage: normalizedStage },
    });

    if (!update.count) {
        throw new Error(`Application "${id}" not found`);
    }

    await logAction({
        employeeId: Number(updatedById) || null,
        type: "UPDATE",
        module: "Application",
        result: "SUCCESS",
        notes: `Application "${id}" stage updated to "${normalizedStage}".`,
    });
    return { success: true, id, stage: normalizedStage, count: update.count };
};

/**
 * Update status (open/closed/hired/rejected)
 */
export const updateApplicationStatus = async ({ id, tenantId, status, updatedById }) => {
    const updateStatus = await prisma.application.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { status },
    });

    if (!updateStatus.count) {
        throw new Error(`Application "${id}" not found`);
    }

    await logAction({
        employeeId: Number(updatedById) || null,
        type: "UPDATE",
        module: "Application",
        result: "SUCCESS",
        notes: `Application "${id}" status updated to "${status}".`,
    });
    return { success: true, id, status, count: updateStatus.count };
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

    // Resolve each application's requisition department (BusinessUnit) name so the
    // Create Offer form can auto-fill Department from the chosen candidate. There
    // is no JobRequisition→BusinessUnit relation, so batch-resolve by id.
    const departmentIds = [
        ...new Set(items.map((item) => item.jobRequisition?.departmentId).filter((id) => id != null)),
    ];
    if (departmentIds.length) {
        const units = await prisma.businessUnit.findMany({
            where: { id: { in: departmentIds } },
            select: { id: true, name: true },
        });
        const nameById = new Map(units.map((unit) => [unit.id, unit.name]));
        for (const item of items) {
            if (item.jobRequisition?.departmentId != null) {
                item.jobRequisition.departmentName = nameById.get(item.jobRequisition.departmentId) ?? null;
            }
        }
    }

    return { items, total, page, limit };
};
