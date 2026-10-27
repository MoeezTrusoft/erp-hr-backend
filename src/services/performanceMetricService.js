// src/services/performanceMetricService.js
import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes
import { performanceId, performanceMetricCreate, performanceMetricList, performanceReviewItems } from '../validators/performance.schema.js';
import { requireTenant } from '../lib/tenancy.js';

/**
 * Create metric
 */
export const createMetric = async ({ name, description, category, tenantId, createdById }) => {
    const input = performanceMetricCreate.parse({ name, description, category });
    return prisma.performanceMetric.create({
        data: {
            ...input,
            tenantId: tenantId ?? null,
            createdById: createdById ?? null,
        },
    });
};

/**
 * List metrics (with search, active-only)
 */
export const listMetrics = async ({ tenantId, search, page = 1, limit = 50 }) => {
    ({ search, page, limit } = performanceMetricList.parse({ search, page, limit }));
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
    performanceId.parse(id);
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
    requireTenant(tenantId);
    performanceId.parse(reviewId);
    ({ items } = performanceReviewItems.parse({ items }));
    return tenantTransaction(prisma, async (tx) => {
        // Finalization and calibration lock/update this same parent row. Hold
        // the lock through replacement so a finalized review cannot be edited
        // after an earlier status read, and concurrent replacements cannot mix.
        await tx.$queryRaw`SELECT id FROM "PerformanceReview" WHERE id=${reviewId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const review = await tx.performanceReview.findFirst({
            where: { id: reviewId, tenantId: tenantId ?? null },
        });

        if (!review) {
            throw Object.assign(new Error("Review not found for tenant"), { status: 404 });
        }
        if(review.status==='FINALIZED')throw Object.assign(new Error('Finalized review items are immutable'),{status:409});
        const ids=items.map(i=>i.metricId);
        if(await tx.performanceMetric.count({where:{tenantId,id:{in:ids},isActive:true}})!==ids.length)throw Object.assign(new Error('Metric not found in this company'),{status:404});

        await tx.performanceReviewItem.deleteMany({
            where: { reviewId, tenantId },
        });

        if (!items.length) return [];

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
            where: { reviewId, tenantId },
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
    performanceId.parse(reviewId);
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
