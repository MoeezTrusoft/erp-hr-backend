import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into offboarding reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's exit checklists/tasks/interviews.

export const createOffboarding = async ({ employeeId, exitDate, exitReason, notes, createdById, tenantId }) => {
    return prisma.offboardingChecklist.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            exitDate: exitDate ? new Date(exitDate) : null,
            exitReason,
            notes,
            assignedById: createdById ? Number(createdById) : null,
        }),
        include: { tasks: true },
    });
};

export const getOffboarding = async (id, tenantId) => {
    return prisma.offboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { employee: true, tasks: true },
    });
};

export const getOffboardingByEmployee = async (employeeId, tenantId) => {
    return prisma.offboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        include: { tasks: true },
    });
};

export const updateOffboarding = async (id, data, tenantId) => {
    const existing = await prisma.offboardingChecklist.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Offboarding checklist not found");
    return prisma.offboardingChecklist.update({ where: { id: Number(id) }, data });
};

export const addTask = async ({ checklistId, title, description, assigneeType, dueDate, assignedToId, tenantId }) => {
    return prisma.offboardingTask.create({
        data: scopedData(tenantId, {
            checklistId: Number(checklistId),
            title,
            description,
            assigneeType: assigneeType || "HR",
            dueDate: dueDate ? new Date(dueDate) : null,
            assignedToId: assignedToId ? Number(assignedToId) : null,
        }),
    });
};

export const updateTask = async (taskId, data, tenantId) => {
    const existing = await prisma.offboardingTask.findFirst({ where: scopedWhere(tenantId, { id: Number(taskId) }) });
    if (!existing) throw new Error("Task not found");
    const update = { ...data };
    if (data.isCompleted) update.completedAt = new Date();
    return prisma.offboardingTask.update({ where: { id: Number(taskId) }, data: update });
};

export const uploadExitInterview = async (id, file, tenantId) => {
    const existing = await prisma.offboardingChecklist.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Offboarding checklist not found");
    const uploaded = await uploadFileToDAM(file, "video");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.offboardingChecklist.update({
        where: { id: Number(id) },
        data: { exitInterviewMediaId: uploaded[0].id },
    });
};
