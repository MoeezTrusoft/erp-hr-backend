// src/services/onboarding-provisioning.service.js
//
// Recruitment Phase 4 (plan 6.7, "Provisioning tasks", flag
// onboardingAutomation) — the requests to IT that day one needs.
//
// Why a request row next to the task: the checklist task says WHAT must be
// ready; the request is IT's work item with its own life (acknowledged, in
// progress, fulfilled with a ticket or asset reference, or rejected with a
// reason) and a due date relative to the start date, so the day-one readiness
// check and IT's queue read one table instead of parsing checklist titles.
//
//   * createProvisioningRequestsInTx — the handoff raises one request per
//     qualifying task, inside its own transaction, idempotently (unique taskId).
//   * ensureProvisioningRequestForTaskInTx — a qualifying task added later.
//   * syncProvisioningFromTaskInTx — the task completed or reopened from the
//     existing onboarding screens keeps the request in step.
//   * cancelProvisioningForTaskInTx — the task deleted: an open request is
//     cancelled rather than left pointing at nothing.
//   * list / get / update — IT's queue (the hr_onboarding_provisioning_* tools).
//     FULFILLED completes the linked task in the same transaction.
//
// Every query carries the tenant; every write enqueues its ids-only outbox
// event in the write's transaction. Pure rules live in
// src/lib/onboarding-provisioning.util.js.
import prisma from "../lib/prisma.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { requireTenant, scopedEmployeeWhere, withTenant } from "../lib/tenancy.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    OPEN_PROVISIONING_STATUSES,
    PROVISIONING_STATUS,
    allowedProvisioningTransitions,
    canTransitionProvisioning,
    isProvisioningOverdue,
    provisioningDueDate,
    provisioningKindFor,
    provisioningTitleFor,
    qualifiesForProvisioning,
    syncTargetForTask,
} from "../lib/onboarding-provisioning.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { onboardingTaskUpdatedEvent } from "./hrEvents.js";

const fail = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** Flag off: every tool answers 503 (clients see HR-5031). */
export function assertOnboardingAutomationEnabled() {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) {
        throw fail("Onboarding automation is disabled", 503, "HR-ONBOARDING-AUTOMATION-DISABLED");
    }
}

const TASK_SELECT = Object.freeze({
    id: true,
    checklistId: true,
    title: true,
    category: true,
    assigneeType: true,
    assigneeId: true,
    dueDate: true,
    completed: true,
});

// ── Events (ids-only; the builder shape of hrEvents.js) ─────────────────────

const idStr = (value) => (value != null ? String(value) : null);
const isoStr = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const requestPayload = (request, routing = {}) => ({
    provisioningRequestId: String(request.id),
    checklistId: idStr(request.checklistId),
    taskId: idStr(request.taskId),
    employeeId: idStr(request.employeeId),
    kind: request.kind,
    status: request.status,
    dueDate: isoStr(request.dueDate),
    managerId: idStr(routing.managerId),
    assigneeId: idStr(routing.assigneeId),
});

const requestEvent = (eventName, request, ctx, payload) =>
    request?.tenantId
        ? {
            eventName,
            tenantId: request.tenantId,
            aggregateType: "OnboardingProvisioningRequest",
            aggregateId: request.id,
            actorId: ctx?.actorId,
            correlationId: ctx?.correlationId,
            payload,
        }
        : null;

export const provisioningRequestedEvent = (request, ctx = {}, routing = {}) =>
    requestEvent("hr.onboarding.provisioning_requested.v1", request, ctx, requestPayload(request, routing));

export const provisioningUpdatedEvent = (request, ctx = {}, extra = {}) =>
    requestEvent("hr.onboarding.provisioning_updated.v1", request, ctx, {
        ...requestPayload(request, extra),
        previousStatus: extra.previousStatus ?? null,
        // Column NAMES only, never the notes or the reference themselves.
        changedFields: Array.isArray(extra.changedFields) ? extra.changedFields.map(String) : [],
    });

export const provisioningFulfilledEvent = (request, ctx = {}, extra = {}) =>
    requestEvent("hr.onboarding.provisioning_fulfilled.v1", request, ctx, {
        ...requestPayload(request, extra),
        previousStatus: extra.previousStatus ?? null,
        fulfilledById: idStr(request.fulfilledById),
        fulfilledAt: isoStr(request.fulfilledAt),
        source: extra.source ?? "REQUEST",
    });

// ── Routing ids ──────────────────────────────────────────────────────────────

async function managerIdOf(tx, tenantId, employeeId) {
    const employee = await tx.employee.findFirst({
        where: scopedEmployeeWhere(tenantId, { id: Number(employeeId) }),
        select: { managerId: true },
    });
    return employee?.managerId ?? null;
}

async function assigneeIdOfTask(tx, tenantId, taskId) {
    if (taskId == null) return null;
    const task = await tx.onboardingTask.findFirst({ where: withTenant(tenantId, { id: taskId }), select: { assigneeId: true } });
    return task?.assigneeId ?? null;
}

// ── Raising requests (handoff and later tasks) ──────────────────────────────

const requestRowFor = ({ tenantId, checklistId, employeeId, startDate, task, now }) => ({
    tenantId,
    checklistId: Number(checklistId),
    taskId: task.id,
    employeeId: Number(employeeId),
    kind: provisioningKindFor(task),
    title: provisioningTitleFor(task),
    status: PROVISIONING_STATUS.REQUESTED,
    dueDate: provisioningDueDate({ taskDueDate: task.dueDate, startDate }),
    requestedAt: now,
});

// Insert the missing requests (skipDuplicates makes a concurrent second run a
// no-op instead of a unique violation that would abort the caller's
// transaction) and announce only the rows this call created.
async function raiseRequests(tx, { tenantId, checklistId, employeeId, startDate, tasks, now, ctx }) {
    const qualifying = tasks.filter(qualifiesForProvisioning);
    if (!qualifying.length) return { created: 0, existing: 0, requestIds: [] };
    const existingRows = await tx.onboardingProvisioningRequest.findMany({
        where: withTenant(tenantId, { taskId: { in: qualifying.map((task) => task.id) } }),
        select: { id: true, taskId: true },
    });
    const known = new Set(existingRows.map((row) => row.taskId));
    const missing = qualifying.filter((task) => !known.has(task.id));
    let createdRows = [];
    if (missing.length) {
        createdRows = await tx.onboardingProvisioningRequest.createManyAndReturn({
            data: missing.map((task) => requestRowFor({ tenantId, checklistId, employeeId, startDate, task, now })),
            skipDuplicates: true,
        });
    }
    if (createdRows.length) {
        const managerId = await managerIdOf(tx, tenantId, employeeId);
        const assigneeByTask = new Map(missing.map((task) => [task.id, task.assigneeId ?? null]));
        for (const row of createdRows) {
            await enqueueHrDomainEvent(tx, provisioningRequestedEvent(row, ctx, { managerId, assigneeId: assigneeByTask.get(row.taskId) }));
        }
    }
    return {
        created: createdRows.length,
        existing: qualifying.length - createdRows.length,
        requestIds: [...existingRows.map((row) => row.id), ...createdRows.map((row) => row.id)],
    };
}

/**
 * One request per qualifying task of the checklist, inside the caller's
 * transaction (the offer handoff). Idempotent: a second call creates nothing.
 * Flag off: raises nothing.
 * @returns {Promise<{ created: number, existing: number, skipped?: string }>}
 */
export async function createProvisioningRequestsInTx(tx, { tenantId, checklistId, employeeId, startDate, now = new Date(), actorId } = {}) {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) return { created: 0, existing: 0, skipped: "FLAG_OFF" };
    requireTenant(tenantId);
    let start = startDate;
    let owner = employeeId;
    if (start == null || owner == null) {
        const checklist = await tx.onboardingChecklist.findFirst({
            where: withTenant(tenantId, { id: Number(checklistId) }),
            select: { employeeId: true, startDate: true },
        });
        if (!checklist) throw fail("Onboarding checklist not found", 404, "HR-ONBOARDING-CHECKLIST-NOT-FOUND");
        start = start ?? checklist.startDate;
        owner = owner ?? checklist.employeeId;
    }
    const tasks = await tx.onboardingTask.findMany({
        where: withTenant(tenantId, { checklistId: Number(checklistId) }),
        select: TASK_SELECT,
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    const { created, existing } = await raiseRequests(tx, {
        tenantId, checklistId, employeeId: owner, startDate: start, tasks, now, ctx: eventContext({ actorId }),
    });
    return { created, existing };
}

/**
 * A task added after the handoff: raise its request if it qualifies.
 * `task` is the created row (id, checklistId, title, category, assigneeType,
 * assigneeId, dueDate, completed).
 * @returns {Promise<{ created: boolean, requestId: number|null, skipped?: string }>}
 */
export async function ensureProvisioningRequestForTaskInTx(tx, { tenantId, task, now = new Date(), actorId } = {}) {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) return { created: false, requestId: null, skipped: "FLAG_OFF" };
    if (!qualifiesForProvisioning(task)) return { created: false, requestId: null, skipped: "NOT_PROVISIONING" };
    requireTenant(tenantId);
    const checklist = await tx.onboardingChecklist.findFirst({
        where: withTenant(tenantId, { id: Number(task.checklistId) }),
        select: { id: true, employeeId: true, startDate: true },
    });
    if (!checklist) throw fail("Onboarding checklist not found", 404, "HR-ONBOARDING-CHECKLIST-NOT-FOUND");
    const result = await raiseRequests(tx, {
        tenantId,
        checklistId: checklist.id,
        employeeId: checklist.employeeId,
        startDate: checklist.startDate,
        tasks: [task],
        now,
        ctx: eventContext({ actorId }),
    });
    return { created: result.created === 1, requestId: result.requestIds[0] ?? null };
}

/**
 * Keep the request in step with its task when the task is completed or
 * reopened outside the request tool. Not flag-gated: a request raised while
 * the flag was on must not drift from its task after it is turned off.
 *   * completed → an open request becomes FULFILLED (fulfilledById stays null:
 *     that is the marker of a sync fulfilment);
 *   * reopened → only a sync-fulfilled request goes back to IN_PROGRESS; one
 *     IT fulfilled through the request tool keeps IT's record.
 * @returns {Promise<{ changed: boolean, requestId: number|null, status: string|null }>}
 */
export async function syncProvisioningFromTaskInTx(tx, { tenantId, taskId, completed, actorId, now = new Date() } = {}) {
    requireTenant(tenantId);
    const request = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { taskId: Number(taskId) }) });
    if (!request) return { changed: false, requestId: null, status: null };
    const target = syncTargetForTask(request, Boolean(completed));
    if (!target) return { changed: false, requestId: request.id, status: request.status };

    const data = target === PROVISIONING_STATUS.FULFILLED
        ? { status: target, fulfilledAt: now, fulfilledById: null, acknowledgedAt: request.acknowledgedAt ?? now }
        : { status: target, fulfilledAt: null, fulfilledById: null };
    // Compare-and-set on the version read above, so a concurrent IT update wins
    // cleanly instead of being overwritten by the task screen.
    const { count } = await tx.onboardingProvisioningRequest.updateMany({
        where: withTenant(tenantId, { id: request.id, version: request.version }),
        data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) return { changed: false, requestId: request.id, status: request.status };
    const updated = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: request.id }) });
    const ctx = eventContext({ actorId });
    const routing = { managerId: await managerIdOf(tx, tenantId, updated.employeeId), assigneeId: await assigneeIdOfTask(tx, tenantId, updated.taskId) };
    await enqueueHrDomainEvent(
        tx,
        target === PROVISIONING_STATUS.FULFILLED
            ? provisioningFulfilledEvent(updated, ctx, { ...routing, previousStatus: request.status, source: "TASK" })
            : provisioningUpdatedEvent(updated, ctx, { ...routing, previousStatus: request.status, changedFields: ["status", "fulfilledAt", "fulfilledById"] }),
    );
    return { changed: true, requestId: updated.id, status: updated.status };
}

/**
 * The task was deleted: cancel its open request (a closed one keeps its
 * record). Call before or after the delete, in the same transaction.
 * @returns {Promise<{ cancelled: boolean, requestId: number|null }>}
 */
export async function cancelProvisioningForTaskInTx(tx, { tenantId, taskId, actorId } = {}) {
    requireTenant(tenantId);
    const request = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { taskId: Number(taskId) }) });
    if (!request || !OPEN_PROVISIONING_STATUSES.includes(request.status)) return { cancelled: false, requestId: request?.id ?? null };
    const { count } = await tx.onboardingProvisioningRequest.updateMany({
        where: withTenant(tenantId, { id: request.id, status: { in: OPEN_PROVISIONING_STATUSES } }),
        // The task row is going away; the request keeps its history but no
        // longer claims the (unique) task id.
        data: { status: PROVISIONING_STATUS.CANCELLED, taskId: null, version: { increment: 1 } },
    });
    if (count === 0) return { cancelled: false, requestId: request.id };
    const updated = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: request.id }) });
    await enqueueHrDomainEvent(tx, provisioningUpdatedEvent(updated, eventContext({ actorId }), {
        managerId: await managerIdOf(tx, tenantId, updated.employeeId),
        previousStatus: request.status,
        changedFields: ["status", "taskId"],
    }));
    return { cancelled: true, requestId: updated.id };
}

// ── IT's queue ───────────────────────────────────────────────────────────────

const employeeName = (employee) =>
    employee?.employee_name
    || [employee?.first_name, employee?.last_name].filter(Boolean).join(" ").trim()
    || null;

const shapeRequest = (row, { employeeById, taskById, now }) => ({
    id: row.id,
    checklistId: row.checklistId,
    taskId: row.taskId ?? null,
    taskTitle: row.taskId != null ? taskById.get(row.taskId)?.title ?? null : null,
    taskCompleted: row.taskId != null ? taskById.get(row.taskId)?.completed ?? null : null,
    employeeId: row.employeeId,
    employeeName: employeeName(employeeById.get(row.employeeId)),
    kind: row.kind,
    title: row.title,
    status: row.status,
    dueDate: row.dueDate ?? null,
    overdue: isProvisioningOverdue(row, now),
    requestedAt: row.requestedAt ?? null,
    acknowledgedAt: row.acknowledgedAt ?? null,
    fulfilledAt: row.fulfilledAt ?? null,
    fulfilledById: row.fulfilledById ?? null,
    externalRef: row.externalRef ?? null,
    notes: row.notes ?? null,
    version: row.version,
    allowedTransitions: allowedProvisioningTransitions(row.status),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
});

// One batched read each for the display names and the task titles.
async function shapeRows(db, tenantId, rows, now) {
    const employeeIds = [...new Set(rows.map((row) => row.employeeId))];
    const taskIds = [...new Set(rows.map((row) => row.taskId).filter((id) => id != null))];
    const [employees, tasks] = await Promise.all([
        employeeIds.length
            ? db.employee.findMany({
                where: scopedEmployeeWhere(tenantId, { id: { in: employeeIds } }),
                select: { id: true, employee_name: true, first_name: true, last_name: true },
            })
            : [],
        taskIds.length
            ? db.onboardingTask.findMany({ where: withTenant(tenantId, { id: { in: taskIds } }), select: { id: true, title: true, completed: true } })
            : [],
    ]);
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return rows.map((row) => shapeRequest(row, { employeeById, taskById, now }));
}

const asDate = (value, label) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw fail(`${label} is not a valid date`, 400, "HR-ONBOARDING-PROVISIONING-INVALID");
    return date;
};

/** The list where-clause; exported for the tests. */
export function buildProvisioningListWhere({ tenantId, status, kind, employeeId, checklistId, overdue, dueBefore, now = new Date() }) {
    const and = [];
    if (status) and.push({ status: Array.isArray(status) ? { in: status } : status });
    if (kind) and.push({ kind });
    if (employeeId != null) and.push({ employeeId: Number(employeeId) });
    if (checklistId != null) and.push({ checklistId: Number(checklistId) });
    if (dueBefore != null) and.push({ dueDate: { lt: asDate(dueBefore, "dueBefore") } });
    if (overdue === true) and.push({ status: { in: OPEN_PROVISIONING_STATUSES }, dueDate: { lt: now } });
    if (overdue === false) {
        and.push({ OR: [{ status: { notIn: OPEN_PROVISIONING_STATUSES } }, { dueDate: null }, { dueDate: { gte: now } }] });
    }
    return withTenant(tenantId, and.length ? { AND: and } : {});
}

/**
 * IT's queue, soonest due first, paged.
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function listProvisioningRequests({ tenantId, page = 1, limit = 50, now = new Date(), includeHires = false, ...filters } = {}) {
    requireTenant(tenantId);
    const where = buildProvisioningListWhere({ tenantId, now, ...filters });
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const [rows, total, hires] = await Promise.all([
        prisma.onboardingProvisioningRequest.findMany({
            where,
            orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
            skip: (current - 1) * take,
            take,
        }),
        prisma.onboardingProvisioningRequest.count({ where }),
        includeHires === true ? listProvisioningHires(prisma, tenantId) : null,
    ]);
    return {
        items: await shapeRows(prisma, tenantId, rows, now),
        total,
        page: current,
        limit: take,
        ...(hires ? { hires } : {}),
    };
}

// The most hires the facet lists; an IT queue with more open hires than this
// filters by id (employeeId) instead.
export const PROVISIONING_HIRE_FACET_MAX = 500;

/**
 * Phase 6 — the hire facet for IT's queue: the distinct hires that have an
 * OPEN request (REQUESTED or IN_PROGRESS), in the caller's tenant, as
 * { employeeId, name } only (nothing else from the checklist or the employee
 * record), sorted by name. It ignores the page's own filters so the hire
 * picker stays the same while IT filters. Exported for the tests.
 * @returns {Promise<Array<{ employeeId: number, name: string|null }>>}
 */
export async function listProvisioningHires(db, tenantId) {
    requireTenant(tenantId);
    const open = await db.onboardingProvisioningRequest.findMany({
        where: withTenant(tenantId, { status: { in: OPEN_PROVISIONING_STATUSES } }),
        distinct: ["employeeId"],
        select: { employeeId: true },
        orderBy: { employeeId: "asc" },
        take: PROVISIONING_HIRE_FACET_MAX,
    });
    const employeeIds = [...new Set(open.map((row) => row.employeeId).filter((id) => id != null))];
    if (!employeeIds.length) return [];
    const employees = await db.employee.findMany({
        where: scopedEmployeeWhere(tenantId, { id: { in: employeeIds } }),
        select: { id: true, employee_name: true, first_name: true, last_name: true },
    });
    const nameOf = new Map(employees.map((employee) => [employee.id, employeeName(employee)]));
    return employeeIds
        .map((employeeId) => ({ employeeId, name: nameOf.get(employeeId) ?? null }))
        // By name, unnamed last, then by id.
        .sort((a, b) =>
            Number(a.name == null) - Number(b.name == null)
            || (a.name ?? "").localeCompare(b.name ?? "")
            || a.employeeId - b.employeeId);
}

export async function getProvisioningRequest({ tenantId, requestId, now = new Date() } = {}) {
    requireTenant(tenantId);
    const row = await prisma.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: Number(requestId) }) });
    if (!row) throw fail("Provisioning request not found", 404, "HR-ONBOARDING-PROVISIONING-NOT-FOUND");
    const [shaped] = await shapeRows(prisma, tenantId, [row], now);
    return shaped;
}

const cleanText = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
};

/**
 * Move a request through its status machine and/or record IT's reference and
 * notes. Compare-and-set on `expectedVersion` (409 when stale). FULFILLED
 * stamps fulfilledAt / fulfilledById and completes the linked task in the
 * same transaction.
 *
 * @param {object} args
 * @param {boolean} [args.allowCancel=true]  false for an IT-only caller: the
 *   decision that a request is no longer needed is HR's.
 */
export async function updateProvisioningRequest({
    tenantId, requestId, expectedVersion, status, externalRef, notes, actorId = null, allowCancel = true, now = new Date(),
} = {}) {
    requireTenant(tenantId);
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected) || expected < 0) {
        throw fail("expectedVersion is required", 400, "HR-ONBOARDING-PROVISIONING-INVALID");
    }
    const ctx = eventContext({ actorId });
    return tenantTransaction(prisma, async (tx) => {
        const existing = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: Number(requestId) }) });
        if (!existing) throw fail("Provisioning request not found", 404, "HR-ONBOARDING-PROVISIONING-NOT-FOUND");
        const stale = () => fail(
            "The provisioning request was changed by someone else; reload it and try again",
            409,
            "HR-ONBOARDING-PROVISIONING-VERSION-CONFLICT",
            { currentVersion: existing.version },
        );
        if (existing.version !== expected) throw stale();

        const data = {};
        const nextNotes = cleanText(notes);
        const nextRef = cleanText(externalRef);
        if (status !== undefined && status !== existing.status) {
            if (!canTransitionProvisioning(existing.status, status)) {
                throw fail(
                    `A ${existing.status} request cannot move to ${status}`,
                    409,
                    "HR-ONBOARDING-PROVISIONING-TRANSITION",
                    { details: { from: existing.status, to: status, allowed: allowedProvisioningTransitions(existing.status) } },
                );
            }
            if (status === PROVISIONING_STATUS.CANCELLED && !allowCancel) {
                throw fail("Only HR may cancel a provisioning request", 403, "HR-ONBOARDING-PROVISIONING-FORBIDDEN");
            }
            if (status === PROVISIONING_STATUS.REJECTED && !nextNotes) {
                throw fail("A rejection needs notes saying why", 400, "HR-ONBOARDING-PROVISIONING-NOTES-REQUIRED");
            }
            data.status = status;
            if (status !== PROVISIONING_STATUS.CANCELLED) data.acknowledgedAt = existing.acknowledgedAt ?? now;
            if (status === PROVISIONING_STATUS.FULFILLED) {
                data.fulfilledAt = now;
                data.fulfilledById = actorId ?? null;
            }
        }
        if (nextNotes !== undefined && nextNotes !== (existing.notes ?? null)) data.notes = nextNotes;
        if (nextRef !== undefined && nextRef !== (existing.externalRef ?? null)) data.externalRef = nextRef;

        const changedFields = Object.keys(data);
        if (!changedFields.length) {
            const [shaped] = await shapeRows(tx, tenantId, [existing], now);
            return { ...shaped, unchanged: true };
        }

        const { count } = await tx.onboardingProvisioningRequest.updateMany({
            where: withTenant(tenantId, { id: existing.id, version: expected }),
            data: { ...data, version: { increment: 1 } },
        });
        if (count === 0) {
            const fresh = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: existing.id }), select: { version: true } });
            throw Object.assign(stale(), { currentVersion: fresh?.version ?? existing.version });
        }
        const updated = await tx.onboardingProvisioningRequest.findFirst({ where: withTenant(tenantId, { id: existing.id }) });

        let assigneeId = null;
        if (updated.taskId != null) {
            const task = await tx.onboardingTask.findFirst({ where: withTenant(tenantId, { id: updated.taskId }) });
            assigneeId = task?.assigneeId ?? null;
            // Fulfilment is the task's completion: one transaction, so the
            // checklist never shows the device delivered and the task open.
            if (data.status === PROVISIONING_STATUS.FULFILLED && task && !task.completed) {
                const completedTask = await tx.onboardingTask.update({
                    where: { id: task.id },
                    data: { completed: true, completedAt: now },
                });
                await enqueueHrDomainEvent(tx, onboardingTaskUpdatedEvent({ ...completedTask, tenantId: completedTask.tenantId ?? tenantId }, ctx));
            }
        }
        const routing = { managerId: await managerIdOf(tx, tenantId, updated.employeeId), assigneeId };
        await enqueueHrDomainEvent(
            tx,
            data.status === PROVISIONING_STATUS.FULFILLED
                ? provisioningFulfilledEvent(updated, ctx, { ...routing, previousStatus: existing.status, source: "REQUEST" })
                : provisioningUpdatedEvent(updated, ctx, { ...routing, previousStatus: existing.status, changedFields }),
        );
        const [shaped] = await shapeRows(tx, tenantId, [updated], now);
        return shaped;
    }, { tenantId });
}
