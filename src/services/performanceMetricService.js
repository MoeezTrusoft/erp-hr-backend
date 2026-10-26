// src/services/performanceMetricService.js
import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes

/**
 * Create metric
 */
export const createMetric = async ({ name, description, category, tenantId, createdById }) => {
    return prisma.performanceMetric.create({
        data: {
            name,
            description,
            category,
            tenantId: tenantId ?? null,
            createdById: createdById ?? null,
        },
    });
};

/**
 * List metrics (with search, active-only)
 */
export const listMetrics = async ({ tenantId, search, page = 1, limit = 50 }) => {
    const skip = (page - 1) * limit;

    const where = {
        tenantId: tenantId ?? null,
        isActive: true,
        ...(search
            ? {
                OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { category: { contains: search, mode: "insensitive" } },
                ],
            }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.performanceMetric.findMany({
            where,
            orderBy: { name: "asc" },
            skip,
            take: limit,
        }),
        prisma.performanceMetric.count({ where }),
    ]);

    return { items, total, page, limit };
};

/**
 * Soft delete metric
 */
export const deactivateMetric = async ({ id, tenantId }) => {
    return prisma.performanceMetric.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { isActive: false },
    });
};

/**
 * Bulk upsert review items for a single review.
 * payload: [{ metricId, rating, comment }, ...]
 */
export const upsertReviewItems = async ({ reviewId, tenantId, items }) => {
    return tenantTransaction(prisma, async (tx) => {
        const review = await tx.performanceReview.findFirst({
            where: { id: reviewId, tenantId: tenantId ?? null },
        });

        if (!review) {
            throw new Error("Review not found for tenant");
        }
        if(review.status==='FINALIZED')throw Object.assign(new Error('Finalized review items are immutable'),{status:409});
        const ids=(items||[]).map(i=>i.metricId);
        if(new Set(ids).size!==ids.length)throw Object.assign(new Error('Duplicate metric'),{status:422});
        if(await tx.performanceMetric.count({where:{tenantId,id:{in:ids},isActive:true}})!==ids.length)throw Object.assign(new Error('Metric not found in this company'),{status:404});
        if((items||[]).some(i=>i.rating!=null&&(!Number.isFinite(i.rating)||i.rating<1||i.rating>5)))throw Object.assign(new Error('Rating must be from 1 to 5'),{status:422});

        await tx.performanceReviewItem.deleteMany({
            where: { reviewId },
        });

        if (!items || !items.length) return [];

        await tx.performanceReviewItem.createMany({
            data: items.map((it) => ({
                tenantId,
                reviewId,
                metricId: it.metricId,
                rating: it.rating ?? null,
                comment: it.comment ?? null,
            })),
        });

        return tx.performanceReviewItem.findMany({
            where: { reviewId },
            include: {
                metric: true,
            },
        });
    },{tenantId});
};

/**
 * Get review items for a review
 */
export const getReviewItems = async ({ reviewId, tenantId }) => {
    return prisma.performanceReviewItem.findMany({
        where: {
            reviewId,
            review: { tenantId: tenantId ?? null },
        },
        include: {
            metric: true,
        },
    });
};
