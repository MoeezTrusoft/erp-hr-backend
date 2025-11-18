// src/services/tagService.js
import prisma from "../config/prisma.js";

/**
 * Create a single tag (skill)
 */
export const createTag = async ({ name, type = "skill", tenantId, createdById }) => {
    return prisma.tag.create({
        data: {
            name: name.trim(),
            type,
            tenantId: tenantId ?? null,
            createdById: createdById ?? null,
        },
    });
};

/**
 * Bulk upsert tags from array of names.
 * Returns an array of Tag records.
 */
export const upsertTags = async ({ names, tenantId, createdById }) => {
    const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

    if (!uniqueNames.length) return [];

    // fetch existing
    const existing = await prisma.tag.findMany({
        where: {
            tenantId: tenantId ?? null,
            name: { in: uniqueNames },
        },
    });

    const existingMap = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
    const result = [];

    for (const name of uniqueNames) {
        const key = name.toLowerCase();
        if (existingMap.has(key)) {
            result.push(existingMap.get(key));
        } else {
            const created = await prisma.tag.create({
                data: {
                    name,
                    type: "skill",
                    tenantId: tenantId ?? null,
                    createdById: createdById ?? null,
                },
            });
            result.push(created);
        }
    }

    return result;
};

/**
 * List tags with optional search + pagination
 */
export const listTags = async ({ tenantId, search, page = 1, limit = 20 }) => {
    const skip = (page - 1) * limit;

    const where = {
        tenantId: tenantId ?? null,
        isActive: true,
        ...(search
            ? {
                name: {
                    contains: search,
                    mode: "insensitive",
                },
            }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.tag.findMany({
            where,
            orderBy: { name: "asc" },
            skip,
            take: limit,
        }),
        prisma.tag.count({ where }),
    ]);

    return { items, total, page, limit };
};

/**
 * Soft delete tag
 */
export const deactivateTag = async ({ id, tenantId }) => {
    return prisma.tag.updateMany({
        where: { id, tenantId: tenantId ?? null },
        data: { isActive: false },
    });
};
