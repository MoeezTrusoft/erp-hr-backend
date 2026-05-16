import prisma from "../config/prisma.js";

export const listPools = async ({ page = 1, limit = 20 }) => {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.talentPool.findMany({ skip, take: limit, orderBy: { created_at: "desc" }, include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
        prisma.talentPool.count(),
    ]);
    return { items, total, page, limit };
};

export const addToPool = async ({ candidateId, poolName, notes, addedById }) => {
    return prisma.talentPool.create({
        data: {
            candidateId: Number(candidateId),
            poolName,
            notes,
            addedById: addedById ? Number(addedById) : null,
        },
    });
};

export const removeFromPool = async (id) => {
    return prisma.talentPool.delete({ where: { id: Number(id) } });
};

export const getCandidatesInPool = async (poolName) => {
    return prisma.talentPool.findMany({
        where: { poolName },
        include: { candidate: { include: { tags: { include: { tag: true } } } } },
    });
};
