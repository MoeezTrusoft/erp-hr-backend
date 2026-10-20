import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData, withTenant, requireTenant, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
    onboardingChecklistCreatedEvent,
    onboardingChecklistUpdatedEvent,
    onboardingTaskAddedEvent,
    onboardingTaskUpdatedEvent,
    onboardingTaskDeletedEvent,
    onboardingBuddyAssignedEvent,
    onboardingSurveySubmittedEvent,
} from "./hrEvents.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    cancelProvisioningForTaskInTx,
    ensureProvisioningRequestForTaskInTx,
    syncProvisioningFromTaskInTx,
} from "./onboarding-provisioning.service.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into onboarding reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's onboarding checklists/tasks/documents.

// Recruitment Phase 6 — the profile embedded for the hire and the buddy. It no
// longer carries the home address (current_address, city): every hr:onboarding
// reader got it, and the screen showed it as the office. Checklist reads return
// the WORK location instead (workLocation, below); the hire's home address is
// added only for a caller who may read employee records (hr:employee VIEW),
// and the buddy's never.
const employeeSelect = {
    id: true,
    employee_name: true,
    first_name: true,
    last_name: true,
    job_title: true,
    joining_date: true,
    hire_date: true,
    photo_url: true,
};

const HOME_ADDRESS_SELECT = Object.freeze({ current_address: true, city: true });
// Read for workLocation only and removed from the embedded profile again.
const WORK_LOCATION_SELECT = Object.freeze({ work_mode: true, region: { select: { name: true } } });

const hireSelect = (includeHomeAddress) => ({
    ...employeeSelect,
    ...WORK_LOCATION_SELECT,
    ...(includeHomeAddress === true ? HOME_ADDRESS_SELECT : {}),
});

const cleanText = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Phase 6 — where the hire will work, for the checklist screens:
 *   1. the requisition's location of the offer whose handoff created this
 *      checklist (OfferHandoff.checklistId), else of the hire's latest handoff;
 *   2. else the employee's region (Employee.region.name);
 *   3. else null.
 * workMode is Employee.work_mode (Remote | Onsite | Hybrid). Attaches
 * `workLocation: { location, workMode, source: "REQUISITION" | "REGION" | null }`
 * to each checklist and strips the helper columns from the embedded employee.
 * Only checklists whose hire profile was loaded are resolved.
 */
async function withWorkLocation(checklists, tenantId) {
    if (!Array.isArray(checklists)) return checklists;
    const rows = checklists.filter((c) => c && c.employee);
    if (!rows.length) return checklists;
    const checklistIds = rows.map((c) => c.id);
    const employeeIds = [...new Set(rows.map((c) => c.employeeId ?? c.employee.id).filter((v) => v != null))];
    const handoffs = await prisma.offerHandoff.findMany({
        where: scopedWhere(tenantId, { OR: [{ checklistId: { in: checklistIds } }, { employeeId: { in: employeeIds } }] }),
        orderBy: [{ updated_at: "desc" }, { id: "desc" }],
        select: { checklistId: true, employeeId: true, offer: { select: { jobRequisition: { select: { location: true } } } } },
    });
    const locationOf = (h) => cleanText(h?.offer?.jobRequisition?.location);
    for (const checklist of rows) {
        const employee = checklist.employee;
        const own = handoffs.find((h) => h.checklistId === checklist.id && locationOf(h));
        const latest = handoffs.find((h) => h.employeeId === (checklist.employeeId ?? employee.id) && locationOf(h));
        const requisitionLocation = locationOf(own ?? latest);
        const region = cleanText(employee.region?.name);
        checklist.workLocation = {
            location: requisitionLocation ?? region ?? null,
            workMode: cleanText(employee.work_mode),
            source: requisitionLocation ? "REQUISITION" : region ? "REGION" : null,
        };
        delete employee.region;
        delete employee.work_mode;
    }
    return checklists;
}

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

// ── F-37 write-path helpers ─────────────────────────────────────────────────
// Every onboarding WRITE runs under the verified tenant (fail-closed), checks
// that the ids it references belong to that tenant, and enqueues its outbox
// event in the same transaction as the write.

const notFound = (message) => Object.assign(new Error(message), { status: 404 });

// Columns a caller may never move through a generic update.
const stripControlFields = (data = {}) => {
    const { tenantId: _tenantId, id: _id, ...rest } = data || {};
    return rest;
};

const assertEmployeeInTenant = async (db, employeeId, tenantId, label = "Employee") => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error(`${label} id is required`), { status: 400 });
    const row = await db.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id }), select: { id: true } });
    if (!row) throw notFound(`${label} not found`);
    return row;
};

const assertChecklistInTenant = async (db, checklistId, tenantId, select = { id: true, employeeId: true, tenantId: true }) => {
    const row = await db.onboardingChecklist.findFirst({ where: withTenant(tenantId, { id: Number(checklistId) }), select });
    if (!row) throw notFound("Checklist not found");
    return row;
};

const writeTx = (tenantId, fn) => tenantTransaction(prisma, fn, { tenantId });

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async ({ employeeId, title, templateId, template, startDate, targetCompletionDate, targetDate, notes, tenantId }, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    return writeTx(tenantId, async (tx) => {
        await assertEmployeeInTenant(tx, employeeId, tenantId);
        const created = await tx.onboardingChecklist.create({
            data: scopedData(tenantId, {
                employeeId: Number(employeeId),
                title: title || "Employee Onboarding",
                template: templateId || template || null,
                startDate: startDate ? new Date(startDate) : new Date(),
                targetDate: targetCompletionDate || targetDate ? new Date(targetCompletionDate || targetDate) : null,
                notes,
            }),
            include: { tasks: true, documents: true, buddy: { include: { buddy: { select: employeeSelect } } } },
        });
        await enqueueHrDomainEvent(tx, onboardingChecklistCreatedEvent(created, evtCtx));
        return created;
    });
};

// Phase 6: `includeHomeAddress` (the caller holds hr:employee VIEW; decided by
// the controller / MCP layer, never by the client) adds the hire's
// current_address and city; every read carries workLocation.
export const listChecklists = async ({ page = 1, limit = 20, tenantId, includeHomeAddress = false } = {}) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
    const [items, total] = await Promise.all([
        prisma.onboardingChecklist.findMany({
            where,
            skip,
            take: limit,
            orderBy: { created_at: "desc" },
            include: {
                employee: { select: hireSelect(includeHomeAddress) },
                tasks: { orderBy: { sortOrder: "asc" } },
                buddy: { include: { buddy: { select: employeeSelect } } },
            },
        }),
        prisma.onboardingChecklist.count({ where }),
    ]);
    return { items: await withWorkLocation(items, tenantId), total, page, limit };
};

export const getChecklist = async (id, tenantId, { includeHomeAddress = false } = {}) => {
    const checklist = await prisma.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: {
            employee: { select: hireSelect(includeHomeAddress) },
            tasks: { orderBy: { sortOrder: "asc" } },
            documents: true,
            buddy: { include: { buddy: { select: employeeSelect } } },
            surveys: true,
        },
    });
    if (!checklist) return checklist;
    const [shaped] = await withWorkLocation([checklist], tenantId);
    return shaped;
};

export const getChecklistByEmployee = async (employeeId, tenantId, { includeHomeAddress = false } = {}) => {
    const checklists = await prisma.onboardingChecklist.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        include: {
            employee: { select: hireSelect(includeHomeAddress) },
            tasks: { orderBy: { sortOrder: "asc" } },
            documents: true,
            buddy: { include: { buddy: { select: employeeSelect } } },
        },
        orderBy: { created_at: "desc" },
    });
    return withWorkLocation(checklists, tenantId);
};

export const updateChecklist = async (id, data, tenantId, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    const changes = stripControlFields(data);
    return writeTx(tenantId, async (tx) => {
        const existing = await tx.onboardingChecklist.findFirst({ where: withTenant(tenantId, { id: Number(id) }) });
        if (!existing) throw new Error("Checklist not found");
        if (changes.employeeId !== undefined) await assertEmployeeInTenant(tx, changes.employeeId, tenantId);
        const updated = await tx.onboardingChecklist.update({
            where: { id: Number(id) },
            data: changes,
            include: { tasks: true, buddy: { include: { buddy: { select: employeeSelect } } } },
        });
        await enqueueHrDomainEvent(
            tx,
            onboardingChecklistUpdatedEvent({ ...updated, tenantId: existing.tenantId }, evtCtx, { changedFields: Object.keys(changes) }),
        );
        return updated;
    });
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async ({ checklistId, title, description, assigneeType, dueDate, assignedToId, assigneeId, tenantId }, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    return writeTx(tenantId, async (tx) => {
        await assertChecklistInTenant(tx, checklistId, tenantId);
        const created = await tx.onboardingTask.create({
            data: scopedData(tenantId, {
                checklistId: Number(checklistId),
                title,
                description,
                assigneeType: assigneeType || "HR",
                dueDate: dueDate ? new Date(dueDate) : null,
                assigneeId: assignedToId || assigneeId ? Number(assignedToId || assigneeId) : null,
            }),
        });
        await enqueueHrDomainEvent(tx, onboardingTaskAddedEvent(created, evtCtx));
        // Phase 4 — an IT or workspace task raises its provisioning request.
        await ensureProvisioningRequestForTaskInTx(tx, { tenantId, task: created, actorId: evtCtx.actorId });
        return created;
    });
};

export const updateTask = async (taskId, data, tenantId, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    const update = normalizeTaskUpdate(stripControlFields(data));
    return writeTx(tenantId, async (tx) => {
        const existing = await tx.onboardingTask.findFirst({ where: withTenant(tenantId, { id: Number(taskId) }) });
        if (!existing) throw new Error("Task not found");
        // A task may only move to another checklist of the same tenant.
        if (update.checklistId !== undefined) await assertChecklistInTenant(tx, update.checklistId, tenantId);
        const updated = await tx.onboardingTask.update({
            where: { id: Number(taskId) },
            data: update,
        });
        await enqueueHrDomainEvent(tx, onboardingTaskUpdatedEvent({ ...updated, tenantId: existing.tenantId }, evtCtx));
        // Phase 4 — completing or reopening the task keeps its request in step.
        if (update.completed !== undefined && update.completed !== existing.completed) {
            await syncProvisioningFromTaskInTx(tx, { tenantId, taskId: updated.id, completed: updated.completed, actorId: evtCtx.actorId });
        }
        return updated;
    });
};

export const deleteTask = async (taskId, tenantId, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    return writeTx(tenantId, async (tx) => {
        const existing = await tx.onboardingTask.findFirst({ where: withTenant(tenantId, { id: Number(taskId) }) });
        if (!existing) throw new Error("Task not found");
        // Phase 4 — the task's open provisioning request is cancelled with it.
        await cancelProvisioningForTaskInTx(tx, { tenantId, taskId: existing.id, actorId: evtCtx.actorId });
        const removed = await tx.onboardingTask.delete({ where: { id: Number(taskId) } });
        await enqueueHrDomainEvent(tx, onboardingTaskDeletedEvent({ ...existing, ...(removed ?? {}), tenantId: existing.tenantId }, evtCtx));
        return removed;
    });
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

export const signDocument = async (docId, { signedBy, tenantId } = {}) => {
    const existing = await prisma.onboardingDocument.findFirst({ where: scopedWhere(tenantId, { id: Number(docId) }) });
    if (!existing) throw new Error("Document not found");
    const signerId = signedBy !== undefined && signedBy !== null && String(signedBy) !== "" ? Number(signedBy) : null;
    return prisma.onboardingDocument.update({
        where: { id: Number(docId) },
        data: {
            signedAt: new Date(),
            ...(signerId != null && !Number.isNaN(signerId) ? { signedByEmpId: signerId } : {}),
        },
    });
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async ({ checklistId, buddyId, tenantId }, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    return writeTx(tenantId, async (tx) => {
        // Scope the parent checklist AND the buddy so neither can be attached
        // cross-tenant (the response embeds the buddy's employee profile).
        const checklist = await assertChecklistInTenant(tx, checklistId, tenantId);
        await assertEmployeeInTenant(tx, buddyId, tenantId, "Buddy");
        const buddy = await tx.onboardingBuddy.upsert({
            where: { checklistId: Number(checklistId) },
            update: { buddyId: Number(buddyId) },
            create: scopedData(tenantId, { checklistId: Number(checklistId), buddyId: Number(buddyId) }),
            include: { buddy: { select: employeeSelect } },
        });
        await enqueueHrDomainEvent(
            tx,
            onboardingBuddyAssignedEvent({ ...buddy, buddyId: buddy?.buddyId ?? Number(buddyId), tenantId: checklist.tenantId }, evtCtx),
        );
        return buddy;
    });
};

export const getBuddy = async (checklistId, tenantId) => {
    return prisma.onboardingBuddy.findFirst({
        where: scopedWhere(tenantId, { checklistId: Number(checklistId) }),
        include: { buddy: { select: employeeSelect } },
    });
};

// ── Surveys ──────────────────────────────────────────────────────────────────

export const submitSurvey = async ({ employeeId, checklistId, type, surveyType, responses, tenantId }, ctx = {}) => {
    requireTenant(tenantId);
    const evtCtx = eventContext(ctx);
    const resolvedType = mapSurveyType(surveyType || type);
    return writeTx(tenantId, async (tx) => {
        await assertEmployeeInTenant(tx, employeeId, tenantId);
        let checklist;
        if (checklistId) {
            // A caller-supplied checklist must be the tenant's.
            checklist = await assertChecklistInTenant(tx, checklistId, tenantId);
        } else {
            checklist = await tx.onboardingChecklist.findFirst({
                where: withTenant(tenantId, { employeeId: Number(employeeId) }),
                orderBy: { created_at: "desc" },
                select: { id: true, employeeId: true, tenantId: true },
            });
            if (!checklist) throw new Error("Onboarding checklist not found for employee");
        }
        const resolvedChecklistId = checklist.id;

        const survey = await tx.onboardingSurvey.upsert({
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
        // ids + survey type only — the employee's responses never reach the fabric.
        await enqueueHrDomainEvent(
            tx,
            onboardingSurveySubmittedEvent({ ...survey, tenantId: survey?.tenantId ?? checklist.tenantId ?? null }, evtCtx),
        );
        return survey;
    });
};

export const getSurveys = async (employeeId, tenantId) => {
    return prisma.onboardingSurvey.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        orderBy: { created_at: "desc" },
    });
};
