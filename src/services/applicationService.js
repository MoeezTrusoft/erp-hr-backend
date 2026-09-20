// src/services/applicationService.js
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
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
    if (String(stage).toLowerCase() !== "applied") {
        throw Object.assign(new Error("New applications must start in the applied stage"), { status: 409, code: "HR-RECRUITMENT-INITIAL-STAGE" });
    }
    if (tenantId === undefined || tenantId === null || tenantId === "") {
        throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
    }

    const create = await prisma.application.create({
        data: {
            // candidateId / jobRequisitionId are NOT-NULL Int FKs — coerce (arrive as
            // numeric strings from the MCP boundary) to align with sibling services.
            candidateId: Number(candidateId),
            jobRequisitionId: Number(jobRequisitionId),
            stage,
            status,
            tenantId: tenantId ?? null,
            // Guard against NaN: Number(undefined) ?? null === NaN. Only write a
            // finite creator id, else null (createdById is nullable).
            createdById: Number.isFinite(Number(createdById)) ? Number(createdById) : null,
        },
        include: {
            candidate: true,
            jobRequisition: true,
        },
    });
    await prisma.applicationStageHistory.create({
        data: {
            applicationId: create.id,
            tenantId,
            fromStage: "applied",
            toStage: "applied",
            reason: "initial application",
            actorId: Number.isFinite(Number(createdById)) ? Number(createdById) : null,
            source: "application",
        },
    });
    await logAction({
        employeeId: createdById ?? null,
        type: "CREATE",
        module: "Application",
        result: "SUCCESS",
            notes: `Application "${create.id}" created successfully for candidate "${candidateId}" on job "${jobRequisitionId}".`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });


    return create;
};

/**
 * Update stage of an application
 */
export const updateApplicationStage = async ({ id, tenantId, stage, reason, updatedById }) => {
    return transitionApplicationStage({
        id,
        tenantId,
        targetStage: stage,
        reason,
        actorId: updatedById,
        source: "rest",
    });
};


/**
 * Update status (open/closed/hired/rejected)
 */
export const updateApplicationStatus = async ({ id, tenantId, status, reason, updatedById }) => {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (!["open", "closed", "hired", "rejected"].includes(normalizedStatus)) {
        throw Object.assign(new Error(`Unsupported application status: ${normalizedStatus}`), {
            status: 409,
            code: "HR-RECRUITMENT-STATUS-INVALID",
        });
    }
    if (["hired", "rejected"].includes(normalizedStatus)) {
        return prisma.$transaction(async (tx) => {
            const transition = await transitionApplicationStage({
                id,
                tenantId,
                targetStage: normalizedStatus,
                reason,
                actorId: updatedById,
                source: "rest-status",
                db: tx,
            });
            const updated = await tx.application.updateMany({
                where: { id: Number(id), tenantId },
                data: { status: normalizedStatus },
            });
            return { ...transition, status: normalizedStatus, count: updated.count };
        });
    }
    const updateStatus = await prisma.application.updateMany({
        where: { id: Number(id), tenantId },
        data: { status: normalizedStatus },
    });
    if (!updateStatus.count) throw Object.assign(new Error(`Application "${id}" not found`), { status: 404 });
    await logAction({
        employeeId: Number(updatedById) || null,
        type: "UPDATE",
        module: "Application",
        result: "SUCCESS",
        notes: `Application "${id}" status updated to "${normalizedStatus}".`,
        tenantId,
    });
    return { success: true, id, status: normalizedStatus, count: updateStatus.count };
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
