import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into onboarding reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's onboarding checklists/tasks/documents.

const employeeSelect = {
    id: true,
    employee_name: true,
    first_name: true,
    last_name: true,
    job_title: true,
    joining_date: true,
    hire_date: true,
    photo_url: true,
    current_address: true,
    city: true,
};

const mapSurveyType = (value) => {
    const normalized = String(value || "DAY_30").toUpperCase().replace(/-/g, "_");
    if (normalized === "30_DAY" || normalized === "DAY_30") return "DAY_30";
    if (normalized === "60_DAY" || normalized === "DAY_60") return "DAY_60";
    if (normalized === "90_DAY" || normalized === "DAY_90") return "DAY_90";
    return normalized;
};

const normalizeTaskUpdate = (data = {}) => {
    const update = { ...data };

    if (update.status !== undefined) {
        const status = String(update.status).toUpperCase();
        update.completed = status === "COMPLETED";
        if (update.completed) update.completedAt = new Date();
        else if (status === "PENDING") update.completedAt = null;
        delete update.status;
    }

    if (update.isCompleted !== undefined) {
        update.completed = !!update.isCompleted;
        if (update.completed) update.completedAt = new Date();
        delete update.isCompleted;
    }

    if (update.notes !== undefined) {
        update.description = update.notes;
        delete update.notes;
    }

    if (update.assigneeId !== undefined) {
        update.assigneeId = update.assigneeId ? Number(update.assigneeId) : null;
    }

    return update;
};

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async ({ employeeId, title, startDate, targetCompletionDate, targetDate, notes, tenantId }) => {
    return prisma.onboardingChecklist.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            title: title || "Employee Onboarding",
            startDate: startDate ? new Date(startDate) : new Date(),
            targetDate: targetCompletionDate || targetDate ? new Date(targetCompletionDate || targetDate) : null,
            notes,
        }),
        include: { tasks: true, documents: true, buddy: { include: { buddy: { select: employeeSelect } } } },
    });
};

export const listChecklists = async ({ page = 1, limit = 20, tenantId } = {}) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
    const [items, total] = await Promise.all([
        prisma.onboardingChecklist.findMany({
            where,
            skip,
            take: limit,
            orderBy: { created_at: "desc" },
            include: {
                employee: { select: employeeSelect },
                tasks: { orderBy: { sortOrder: "asc" } },
                buddy: { include: { buddy: { select: employeeSelect } } },
            },
        }),
        prisma.onboardingChecklist.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const getChecklist = async (id, tenantId) => {
    return prisma.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: {
            employee: { select: employeeSelect },
            tasks: { orderBy: { sortOrder: "asc" } },
            documents: true,
            buddy: { include: { buddy: { select: employeeSelect } } },
            surveys: true,
        },
    });
};

export const getChecklistByEmployee = async (employeeId, tenantId) => {
    return prisma.onboardingChecklist.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        include: {
            employee: { select: employeeSelect },
            tasks: { orderBy: { sortOrder: "asc" } },
            documents: true,
            buddy: { include: { buddy: { select: employeeSelect } } },
        },
        orderBy: { created_at: "desc" },
    });
};

export const updateChecklist = async (id, data, tenantId) => {
    const existing = await prisma.onboardingChecklist.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Checklist not found");
    return prisma.onboardingChecklist.update({
        where: { id: Number(id) },
        data,
        include: { tasks: true, buddy: { include: { buddy: { select: employeeSelect } } } },
    });
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async ({ checklistId, title, description, assigneeType, dueDate, assignedToId, assigneeId, tenantId }) => {
    return prisma.onboardingTask.create({
        data: scopedData(tenantId, {
            checklistId: Number(checklistId),
            title,
            description,
            assigneeType: assigneeType || "HR",
            dueDate: dueDate ? new Date(dueDate) : null,
            assigneeId: assignedToId || assigneeId ? Number(assignedToId || assigneeId) : null,
        }),
    });
};

export const updateTask = async (taskId, data, tenantId) => {
    const existing = await prisma.onboardingTask.findFirst({ where: scopedWhere(tenantId, { id: Number(taskId) }) });
    if (!existing) throw new Error("Task not found");
    const update = normalizeTaskUpdate(data);
    return prisma.onboardingTask.update({
        where: { id: Number(taskId) },
        data: update,
    });
};

export const deleteTask = async (taskId, tenantId) => {
    const existing = await prisma.onboardingTask.findFirst({ where: scopedWhere(tenantId, { id: Number(taskId) }) });
    if (!existing) throw new Error("Task not found");
    return prisma.onboardingTask.delete({ where: { id: Number(taskId) } });
};

// ── Documents ────────────────────────────────────────────────────────────────

export const uploadDocument = async ({ checklistId, employeeId, title, file, tenantId }) => {
    const checklist = await prisma.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { id: Number(checklistId) }),
        select: { employeeId: true },
    });
    if (!checklist) throw new Error("Checklist not found");

    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    const mediaId = uploaded[0].id;

    return prisma.onboardingDocument.create({
        data: scopedData(tenantId, {
            checklistId: Number(checklistId),
            employeeId: Number(employeeId || checklist.employeeId),
            title,
            mediaId,
        }),
    });
};

export const listDocuments = async (checklistId, tenantId) => {
    return prisma.onboardingDocument.findMany({
        where: scopedWhere(tenantId, { checklistId: Number(checklistId) }),
        orderBy: { created_at: "desc" },
    });
};

export const signDocument = async (docId, tenantId) => {
    const existing = await prisma.onboardingDocument.findFirst({ where: scopedWhere(tenantId, { id: Number(docId) }) });
    if (!existing) throw new Error("Document not found");
    return prisma.onboardingDocument.update({
        where: { id: Number(docId) },
        data: { signedAt: new Date() },
    });
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async ({ checklistId, buddyId, tenantId }) => {
    // Scope the parent checklist so a buddy can't be attached cross-tenant.
    const checklist = await prisma.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { id: Number(checklistId) }),
        select: { id: true },
    });
    if (!checklist) throw new Error("Checklist not found");
    return prisma.onboardingBuddy.upsert({
        where: { checklistId: Number(checklistId) },
        update: { buddyId: Number(buddyId) },
        create: scopedData(tenantId, { checklistId: Number(checklistId), buddyId: Number(buddyId) }),
        include: { buddy: { select: employeeSelect } },
    });
};

export const getBuddy = async (checklistId, tenantId) => {
    return prisma.onboardingBuddy.findFirst({
        where: scopedWhere(tenantId, { checklistId: Number(checklistId) }),
        include: { buddy: { select: employeeSelect } },
    });
};

// ── Surveys ──────────────────────────────────────────────────────────────────

export const submitSurvey = async ({ employeeId, checklistId, type, surveyType, responses, tenantId }) => {
    const resolvedType = mapSurveyType(surveyType || type);
    let resolvedChecklistId = checklistId ? Number(checklistId) : null;

    if (!resolvedChecklistId) {
        const checklist = await prisma.onboardingChecklist.findFirst({
            where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
            orderBy: { created_at: "desc" },
            select: { id: true },
        });
        if (!checklist) throw new Error("Onboarding checklist not found for employee");
        resolvedChecklistId = checklist.id;
    }

    return prisma.onboardingSurvey.upsert({
        where: {
            checklistId_type: {
                checklistId: resolvedChecklistId,
                type: resolvedType,
            },
        },
        update: {
            responses,
            submittedAt: new Date(),
        },
        create: scopedData(tenantId, {
            checklistId: resolvedChecklistId,
            employeeId: Number(employeeId),
            type: resolvedType,
            responses,
            submittedAt: new Date(),
        }),
    });
};

export const getSurveys = async (employeeId, tenantId) => {
    return prisma.onboardingSurvey.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        orderBy: { created_at: "desc" },
    });
};
