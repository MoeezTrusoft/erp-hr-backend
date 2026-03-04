import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createOffboarding = async ({ employeeId, exitDate, exitReason, notes, createdById }) => {
    return prisma.offboardingChecklist.create({
        data: {
            employeeId: Number(employeeId),
            exitDate: exitDate ? new Date(exitDate) : null,
            exitReason,
            notes,
            assignedById: createdById ? Number(createdById) : null,
        },
        include: { tasks: true },
    });
};

export const getOffboarding = async (id) => {
    return prisma.offboardingChecklist.findUnique({
        where: { id: Number(id) },
        include: { employee: true, tasks: true },
    });
};

export const getOffboardingByEmployee = async (employeeId) => {
    return prisma.offboardingChecklist.findFirst({
        where: { employeeId: Number(employeeId) },
        include: { tasks: true },
    });
};

export const updateOffboarding = async (id, data) => {
    return prisma.offboardingChecklist.update({ where: { id: Number(id) }, data });
};

export const addTask = async ({ checklistId, title, description, assigneeType, dueDate, assignedToId }) => {
    return prisma.offboardingTask.create({
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
    return prisma.offboardingTask.update({ where: { id: Number(taskId) }, data: update });
};

export const uploadExitInterview = async (id, file) => {
    const uploaded = await uploadFileToDAM(file, "video");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.offboardingChecklist.update({
        where: { id: Number(id) },
        data: { exitInterviewMediaId: uploaded[0].id },
    });
};
