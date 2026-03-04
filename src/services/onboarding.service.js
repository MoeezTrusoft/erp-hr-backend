import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async ({ employeeId, title, startDate, targetCompletionDate, notes, createdById }) => {
    return prisma.onboardingChecklist.create({
        data: {
            employeeId: Number(employeeId),
            title,
            startDate: startDate ? new Date(startDate) : new Date(),
            targetCompletionDate: targetCompletionDate ? new Date(targetCompletionDate) : null,
            notes,
            assignedById: createdById ? Number(createdById) : null,
        },
        include: { tasks: true, documents: true, buddy: true },
    });
};

export const listChecklists = async ({ page = 1, limit = 20 }) => {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.onboardingChecklist.findMany({
            skip,
            take: limit,
            orderBy: { created_at: "desc" },
            include: { employee: { select: { id: true, firstName: true, lastName: true } }, tasks: true },
        }),
        prisma.onboardingChecklist.count(),
    ]);
    return { items, total, page, limit };
};

export const getChecklist = async (id) => {
    return prisma.onboardingChecklist.findUnique({
        where: { id: Number(id) },
        include: {
            employee: true,
            tasks: true,
            documents: true,
            buddy: { include: { buddy: { select: { id: true, firstName: true, lastName: true } } } },
            surveys: true,
        },
    });
};

export const getChecklistByEmployee = async (employeeId) => {
    return prisma.onboardingChecklist.findMany({
        where: { employeeId: Number(employeeId) },
        include: { tasks: true, documents: true },
        orderBy: { created_at: "desc" },
    });
};

export const updateChecklist = async (id, data) => {
    return prisma.onboardingChecklist.update({
        where: { id: Number(id) },
        data,
    });
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async ({ checklistId, title, description, assigneeType, dueDate, assignedToId }) => {
    return prisma.onboardingTask.create({
        data: {
            checklistId: Number(checklistId),
            title,
            description,
            assigneeType: assigneeType || "HR",
            dueDate: dueDate ? new Date(dueDate) : null,
            assignedToId: assignedToId ? Number(assignedToId) : null,
        },
    });
};

export const updateTask = async (taskId, data) => {
    const update = { ...data };
    if (data.isCompleted) update.completedAt = new Date();
    return prisma.onboardingTask.update({
        where: { id: Number(taskId) },
        data: update,
    });
};

export const deleteTask = async (taskId) => {
    return prisma.onboardingTask.delete({ where: { id: Number(taskId) } });
};

// ── Documents ────────────────────────────────────────────────────────────────

export const uploadDocument = async ({ checklistId, title, file }) => {
    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    const mediaId = uploaded[0].id;

    return prisma.onboardingDocument.create({
        data: {
            checklistId: Number(checklistId),
            title,
            mediaId,
        },
    });
};

export const listDocuments = async (checklistId) => {
    return prisma.onboardingDocument.findMany({
        where: { checklistId: Number(checklistId) },
        orderBy: { created_at: "desc" },
    });
};

export const signDocument = async (docId) => {
    return prisma.onboardingDocument.update({
        where: { id: Number(docId) },
        data: { isSigned: true, signedAt: new Date() },
    });
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async ({ checklistId, buddyId }) => {
    return prisma.onboardingBuddy.upsert({
        where: { checklistId: Number(checklistId) },
        update: { buddyId: Number(buddyId) },
        create: { checklistId: Number(checklistId), buddyId: Number(buddyId) },
        include: { buddy: { select: { id: true, firstName: true, lastName: true } } },
    });
};

export const getBuddy = async (checklistId) => {
    return prisma.onboardingBuddy.findUnique({
        where: { checklistId: Number(checklistId) },
        include: { buddy: { select: { id: true, firstName: true, lastName: true } } },
    });
};

// ── Surveys ──────────────────────────────────────────────────────────────────

export const submitSurvey = async ({ employeeId, type, responses, submittedById }) => {
    return prisma.onboardingSurvey.create({
        data: {
            employeeId: Number(employeeId),
            type,
            responses,
            submittedById: submittedById ? Number(submittedById) : null,
            submittedAt: new Date(),
        },
    });
};

export const getSurveys = async (employeeId) => {
    return prisma.onboardingSurvey.findMany({
        where: { employeeId: Number(employeeId) },
        orderBy: { created_at: "desc" },
    });
};
