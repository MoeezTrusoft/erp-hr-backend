import prisma from "../config/prisma.js";

export const logEvent = async ({ employeeId, type, effectiveDate, notes, performedById, metadata }) => {
    return prisma.employeeLifecycleEvent.create({
        data: {
            employeeId: Number(employeeId),
            type,
            effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
            notes,
            performedById: performedById ? Number(performedById) : null,
            metadata: metadata || {},
        },
    });
};

export const getEmployeeHistory = async (employeeId) => {
    return prisma.employeeLifecycleEvent.findMany({
        where: { employeeId: Number(employeeId) },
        orderBy: { effectiveDate: "desc" },
    });
};

export const listEvents = async ({ type, page = 1, limit = 20 }) => {
    const where = type ? { type } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.employeeLifecycleEvent.findMany({
            where, skip, take: limit, orderBy: { effectiveDate: "desc" },
            include: { employee: { select: { id: true, firstName: true, lastName: true } } },
        }),
        prisma.employeeLifecycleEvent.count({ where }),
    ]);
    return { items, total, page, limit };
};
