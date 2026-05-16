import prisma from "../config/prisma.js";

export const createPath = async ({ title, description, targetRole, categoryId, createdById }) => {
    return prisma.learningPath.create({
        data: {
            title,
            description,
            targetRole,
            categoryId: categoryId ? Number(categoryId) : null,
            createdById: createdById ? Number(createdById) : null,
        },
    });
};

export const listPaths = async ({ page = 1, limit = 20 }) => {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.learningPath.findMany({ skip, take: limit, orderBy: { created_at: "desc" }, include: { courses: { include: { course: true } } } }),
        prisma.learningPath.count(),
    ]);
    return { items, total, page, limit };
};

export const getPath = async (id) => {
    return prisma.learningPath.findUnique({
        where: { id: Number(id) },
        include: { courses: { include: { course: true } }, enrollments: { include: { employee: { select: { id: true, firstName: true, lastName: true } } } } },
    });
};

export const updatePath = async (id, data) => {
    return prisma.learningPath.update({ where: { id: Number(id) }, data });
};

export const addCourseToPath = async ({ pathId, courseId, sortOrder, isRequired }) => {
    return prisma.learningPathCourse.create({
        data: {
            pathId: Number(pathId),
            courseId: Number(courseId),
            sortOrder: sortOrder || 0,
            isRequired: isRequired ?? true,
        },
    });
};

export const enrollEmployee = async ({ pathId, employeeId }) => {
    return prisma.learningPathEnrollment.upsert({
        where: { pathId_employeeId: { pathId: Number(pathId), employeeId: Number(employeeId) } },
        update: {},
        create: { pathId: Number(pathId), employeeId: Number(employeeId) },
    });
};
