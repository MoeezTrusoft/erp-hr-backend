// src/services/applicationService.js
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
import { applicationScopeWhere } from "../lib/recruitmentAccess.js";
import { evaluateRequisitionEligibility, closedApplicationMessage } from "../lib/requisitionEligibility.js";
import { tenantTransaction } from "../lib/rlsTenant.js";

// Phase 1.4 (remainder) — application reads/writes are TENANT-scoped and, when a
// caller passes a scope, ROW-scoped. The MCP tools used to reach prisma directly
// with `findUnique({ where: { id } })` / `delete({ where: { id } })`, which has no
// tenant predicate at all: a valid `hr:recruitment` grant was enough to read ANY
// tenant's application (with candidate PII, interviews and the offer) or delete
// it. Both now go through here so REST and MCP share one gate.
const APPLICATION_INCLUDE = {
    candidate: true,
    jobRequisition: true,
    interviews: true,
    offer: true,
};

/**
 * Read one application, tenant-scoped and row-scoped.
 *
 * An out-of-scope or cross-tenant id returns null, which callers surface as
 * not-found — never as forbidden, since a 403 on a guessed id confirms the row
 * exists.
 */
export const getApplication = async ({ id, tenantId, scope = null }) => {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return prisma.application.findFirst({
        where: {
            id: numericId,
            tenantId: tenantId ?? null,
            ...(scope ? applicationScopeWhere(scope) : {}),
        },
        include: APPLICATION_INCLUDE,
    });
};

/**
 * Delete one application, tenant-scoped and row-scoped.
 * Returns the deleted id, or null when the row is not the caller's to delete.
 */
export const deleteApplication = async ({ id, tenantId, scope = null }) => {
    const existing = await prisma.application.findFirst({
        where: {
            id: Number(id),
            tenantId: tenantId ?? null,
            ...(scope ? applicationScopeWhere(scope) : {}),
        },
        select: { id: true },
    });
    if (!existing) return null;
    await prisma.application.delete({ where: { id: existing.id } });
    return existing.id;
};
/**
 * Create an application: candidate → jobRequisition
 *
 * Phase 4 / §2.9 — gated by the requisition's APPLICATION ELIGIBILITY: an
 * application is refused unless a channel is live, the requisition is in an
 * accepting state, and the closing date has not passed. The eligibility read
 * happens INSIDE the write transaction, so a withdrawal or auto-close that lands
 * between the check and the insert still wins — the gate re-runs against the
 * same snapshot the insert commits on, rather than against a stale pre-read.
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

    return tenantTransaction(prisma, async (tx) => {
        const requisition = await tx.jobRequisition.findFirst({
            where: { id: Number(jobRequisitionId), tenantId: tenantId ?? null },
            include: { postings: { where: { isActive: true } } },
        });
        if (!requisition) {
            throw Object.assign(new Error(`Job requisition "${jobRequisitionId}" not found`), {
                status: 404,
                code: "HR-RECRUITMENT-REQUISITION-NOT-FOUND",
            });
        }

        // §2.9 — the eligibility gate. Refused with the structured reason list so
        // the caller can show "applications closed 2026-09-01" instead of a bare
        // conflict, and with the §2.9a copy contract attached.
        const evaluation = evaluateRequisitionEligibility(requisition, {
            postings: requisition.postings,
        });
        if (!evaluation.eligible) {
            throw Object.assign(
                new Error(
                    `This requisition is not accepting applications: ${evaluation.reasons.join(", ")}`,
                ),
                {
                    status: 409,
                    code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
                    details: {
                        reasons: evaluation.reasons,
                        candidateMessage: closedApplicationMessage(requisition, evaluation),
                    },
                },
            );
        }

        const create = await tx.application.create({
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
        await tx.applicationStageHistory.create({
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
    });
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
    scope = null,
}) => {
    const skip = (page - 1) * limit;

    // `scope` is optional so internal callers keep the previous behaviour; when a
    // transport passes one (REST + MCP both do) the caller only sees the
    // applications their role reaches.
    const where = {
        tenantId: tenantId ?? null,
        ...(scope ? applicationScopeWhere(scope) : {}),
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
