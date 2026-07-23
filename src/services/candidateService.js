// src/services/candidateService.js
import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes
import { upsertTags } from "./tagService.js";
import { logAction } from "../utils/logs.js";

/**
 * Create candidate with optional tags (skill names).
 */
export const createCandidate = async ({
    firstName,
    lastName,
    email,
    phone,
    source,
    notes,
    resumeMediaId,
    tagNames = [],
    tenantId,
    createdById,
}) => {

      // 🔍 1. Validate if email already exists (before transaction)
    const existing = await prisma.candidate.findUnique({
        where: { email }
    });

    if (existing) {
        // ❗ Log failed attempt
        await logAction({
            employeeId: createdById ?? null,
            type: "CREATE",
            module: "Candidate",
            result: "FAILED",
            notes: `Candidate creation failed. Email "${email}" already exists.`,
        });

        // ❗ Throw friendly error
        const error = new Error(`Candidate with email "${email}" already exists.`);
        error.status = 409; // Conflict
        throw error;
    }
    const tags = await upsertTags({
        names: tagNames,
        tenantId,
        createdById,
    });

    return tenantTransaction(prisma, async (tx) => {
        const candidate = await tx.candidate.create({
            data: {
                firstName,
                lastName,
                email,
                phone,
                source,
                notes,
                resumeMediaId: resumeMediaId != null ? Number(resumeMediaId) : null,
                tenantId: tenantId ?? null,
                createdById: Number(createdById) ?? null,
            },
        });

        if (tags.length) {
            await tx.candidateTag.createMany({
                data: tags.map((tag) => ({
                    candidateId: candidate.id,
                    tagId: tag.id,
                })),
                skipDuplicates: true,
            });
        }
   // ⭐ Add the logging here   
        await logAction({
            employeeId: createdById ?? null,
            type: "CREATE",
            module: "Candidate",
            result: "SUCCESS",
            notes: `Candidate "${candidate.id}" created successfully.`,
        });

        return tx.candidate.findUnique({
            where: { id: candidate.id },
            include: {
                tags: { include: { tag: true } },
            },
        });
    });
};

/**
 * Update candidate basic info + (optionally) tags by names.
 */
export const updateCandidate = async ({
    id,
    tenantId,
    data,
    tagNames,
    updatedById,
}) => {
    return tenantTransaction(prisma, async (tx) => {
        await tx.candidate.updateMany({
            where: { id, tenantId: tenantId ?? null },
            data: {
                ...data,
                  createdById: Number(updatedById),
                // if you later add updatedById column, set it here
            },
        });

        if (Array.isArray(tagNames)) {
            const tags = await upsertTags({
                names: tagNames,
                tenantId,
                createdById: Number(updatedById),
            });

            await tx.candidateTag.deleteMany({
                where: { candidateId: id },
            });

            if (tags.length) {
                await tx.candidateTag.createMany({
                    data: tags.map((tag) => ({
                        candidateId: id,
                        tagId: tag.id,
                    })),
                    skipDuplicates: true,
                });
            }
        }

          await logAction({
            employeeId: updatedById,
            type: "UPDATE",
            module: "Candidate",
            result: "SUCCESS",
            notes: `Candidate "${id}" updated successfully.`,
        });

        return tx.candidate.findFirst({
            where: { id, tenantId: tenantId ?? null },
            include: {
                tags: { include: { tag: true } },
                applications: {
                    include: {
                        jobRequisition: true,
                    },
                },
            },
        });
    });
};

/**
 * Get candidate by ID (with tags and applications)
 */
export const getCandidate = async ({ id, tenantId }) => {
    return prisma.candidate.findFirst({
        where: { id, tenantId: tenantId ?? null },
        include: {
            tags: { include: { tag: true } },
            applications: {
                include: {
                    jobRequisition: true,
                },
            },
        },
    });
};

/**
 * List candidates with search, tag filter, pagination
 */
export const listCandidates = async ({
    tenantId,
    search,
    tagIds = [],
    page = 1,
    limit = 20,
}) => {
    const skip = (page - 1) * limit;

    const where = {
        tenantId: tenantId ?? null,
        status: "active",
        ...(search
            ? {
                OR: [
                    { firstName: { contains: search, mode: "insensitive" } },
                    { lastName: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                ],
            }
            : {}),
        ...(tagIds.length
            ? {
                tags: {
                    some: {
                        tagId: { in: tagIds },
                    },
                },
            }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.candidate.findMany({
            where,
            include: {
                tags: { include: { tag: true } },
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prisma.candidate.count({ where }),
    ]);

    return { items, total, page, limit };
};

export const updateCandidateResumeMedia = async ({ id, mediaId }) => {
    const candidate = await prisma.candidate.update({
        where: { id: Number(id) },
        data: { resumeMediaId: Number(mediaId) },
    });
    return candidate;
};
