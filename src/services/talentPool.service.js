import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// talent-pool reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's talent pools.

export const listPools = async ({ page = 1, limit = 20, tenantId } = {}) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
    const [items, total] = await Promise.all([
        prisma.talentPool.findMany({ where, skip, take: limit, orderBy: { addedAt: "desc" }, include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
        prisma.talentPool.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const addToPool = async ({ candidateId, poolName, notes, addedById, tenantId }) => {
    return prisma.talentPool.create({
        data: scopedData(tenantId, {
            candidateId: Number(candidateId),
            poolName,
            notes,
            addedById: addedById ? Number(addedById) : null,
        }),
    });
};

export const removeFromPool = async (id, tenantId) => {
    const existing = await prisma.talentPool.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Talent pool entry not found");
    return prisma.talentPool.delete({ where: { id: Number(id) } });
};

export const getCandidatesInPool = async (poolName, tenantId) => {
    return prisma.talentPool.findMany({
        where: scopedWhere(tenantId, { poolName }),
        include: { candidate: { include: { tags: { include: { tag: true } } } } },
    });
};
