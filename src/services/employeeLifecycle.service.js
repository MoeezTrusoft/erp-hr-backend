import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// payload, or a trailing read param); folded into lifecycle-event reads and
// stamped on creates, fail-closed so tenant B never reads or writes tenant A's
// employee lifecycle history.

export const logEvent = async ({ employeeId, type, effectiveDate, notes, performedById, metadata, tenantId }) => {
    return prisma.employeeLifecycleEvent.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            eventType,
            effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
            description,
            performedById: performedById ? Number(performedById) : null,
            metadata: metadata || {},
        }),
    });
};

export const getEmployeeHistory = async (employeeId, tenantId) => {
    return prisma.employeeLifecycleEvent.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        orderBy: { effectiveDate: "desc" },
    });
};

export const listEvents = async ({ type, page = 1, limit = 20, tenantId } = {}) => {
    const where = scopedWhere(tenantId, type ? { type } : {});
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.employeeLifecycleEvent.findMany({
            where, skip, take: limit, orderBy: { effectiveDate: "desc" },
            include: { employee: { select: { id: true, first_name: true, last_name: true } } },
        }),
        prisma.employeeLifecycleEvent.count({ where }),
    ]);
    return { items, total, page, limit };
};
