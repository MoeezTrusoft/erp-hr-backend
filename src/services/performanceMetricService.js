// src/services/performanceMetricService.js
import prisma from "../config/prisma.js";

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
    return prisma.$transaction(async (tx) => {
        const review = await tx.performanceReview.findFirst({
            where: { id: reviewId, tenantId: tenantId ?? null },
        });

        if (!review) {
            throw new Error("Review not found for tenant");
        }

        await tx.performanceReviewItem.deleteMany({
            where: { reviewId },
        });

        if (!items || !items.length) return [];

        await tx.performanceReviewItem.createMany({
            data: items.map((it) => ({
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
    });
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
