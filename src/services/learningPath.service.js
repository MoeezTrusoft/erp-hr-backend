import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// learning-path reads/writes fail-closed so tenant B never reads/mutates tenant
// A's learning paths, path-courses, or path-enrollments.

export const createPath = async ({ title, description, targetRole, categoryId, createdById, tenantId }) => {
    return prisma.learningPath.create({
        data: scopedData(tenantId, {
            title,
            description,
            targetRole,
            categoryId: categoryId ? Number(categoryId) : null,
            createdById: createdById ? Number(createdById) : null,
        }),
    });
};

export const listPaths = async ({ page = 1, limit = 20, tenantId } = {}) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
    const [items, total] = await Promise.all([
        prisma.learningPath.findMany({ where, skip, take: limit, orderBy: { created_at: "desc" }, include: { courses: { include: { course: true } } } }),
        prisma.learningPath.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const getPath = async (id, tenantId) => {
    return prisma.learningPath.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { courses: { include: { course: true } }, enrollments: { include: { employee: { select: { id: true, firstName: true, lastName: true } } } } },
    });
};

export const updatePath = async (id, data, tenantId) => {
    const existing = await prisma.learningPath.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Learning path not found");
    return prisma.learningPath.update({ where: { id: Number(id) }, data });
};

export const addCourseToPath = async ({ pathId, courseId, sortOrder, isRequired, tenantId }) => {
    // Guard the parent path by tenant so courses can't be attached cross-tenant.
    const path = await prisma.learningPath.findFirst({ where: scopedWhere(tenantId, { id: Number(pathId) }) });
    if (!path) throw new Error("Learning path not found");
    return prisma.learningPathCourse.create({
        data: scopedData(tenantId, {
            pathId: Number(pathId),
            courseId: Number(courseId),
            sortOrder: sortOrder || 0,
            isRequired: isRequired ?? true,
        }),
    });
};

export const enrollEmployee = async ({ pathId, employeeId, tenantId }) => {
    const path = await prisma.learningPath.findFirst({ where: scopedWhere(tenantId, { id: Number(pathId) }) });
    if (!path) throw new Error("Learning path not found");
    return prisma.learningPathEnrollment.upsert({
        where: { pathId_employeeId: { pathId: Number(pathId), employeeId: Number(employeeId) } },
        update: {},
        create: scopedData(tenantId, { pathId: Number(pathId), employeeId: Number(employeeId) }),
    });
};
