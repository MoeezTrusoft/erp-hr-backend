// tests/unit/services/onboarding-write-events.test.js
//
// F-37 (realtime) — onboarding WRITES run under the verified tenant, check the
// ids they reference belong to that tenant, and enqueue their outbox event in
// the SAME transaction as the write. Same seam as the recruitment suite: the
// transaction hands out a DISTINCT `tx`, and an event counts as same-tx only
// when it is enqueued on that `tx` while the transaction is open, after the
// write. The enqueue double mirrors the real fail-closed rule (no tenant ⇒
// nothing enqueued).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";

const makeClient = () => ({
    employee: { findFirst: jest.fn() },
    onboardingChecklist: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    onboardingTask: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    onboardingBuddy: { upsert: jest.fn() },
    onboardingSurvey: { upsert: jest.fn() },
});
const prisma = makeClient();
const tx = makeClient();
let txOpen = false;
const enqueued = [];

const tenantTransaction = jest.fn(async (_client, fn, opts) => {
    txOpen = true;
    try {
        return await fn(tx, opts);
    } finally {
        txOpen = false;
    }
});
const enqueueHrDomainEvent = jest.fn(async (client, args) => {
    if (!args?.tenantId) return null;
    enqueued.push({ client, args, txOpen, order: enqueueHrDomainEvent.mock.invocationCallOrder.at(-1) });
    return { id: enqueued.length };
});

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction,
    isTenantTransaction: () => txOpen,
    rlsTenantExtension: (client) => client,
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM: jest.fn(), deleteDamAsset: jest.fn() }));

const svc = await import("../../../src/services/onboarding.service.js");
const ctrl = await import("../../../src/controllers/onboarding.controller.js");

const ID_ONLY_KEYS = /(Id|status|completed|changedFields|surveyType)$/;
const expectIdsOnly = (payload) => {
    for (const [key, value] of Object.entries(payload)) {
        expect(key).toMatch(ID_ONLY_KEYS);
        if (Array.isArray(value)) value.forEach((v) => expect(typeof v).toBe("string"));
        else if (value !== null) expect(["string", "boolean"]).toContain(typeof value);
    }
};

const onlyEvent = (name, writeMock) => {
    expect(enqueued).toHaveLength(1);
    const [e] = enqueued;
    expect(e.args.eventName).toBe(name);
    expect(e.client).toBe(tx);
    expect(e.txOpen).toBe(true);
    expect(e.args.tenantId).toBe(TENANT);
    expect(e.args.actorId).toBe(12);
    expectIdsOnly(e.args.payload);
    expect(writeMock).toHaveBeenCalled();
    expect(writeMock.mock.invocationCallOrder[0]).toBeLessThan(e.order);
    // the transaction runs under the verified tenant
    expect(tenantTransaction.mock.calls[0][2]).toEqual({ tenantId: TENANT });
    return e;
};

const CTX = { actorId: 12 };

beforeEach(() => {
    jest.clearAllMocks();
    enqueued.length = 0;
    txOpen = false;
    tx.employee.findFirst.mockResolvedValue({ id: 7 });
    tx.onboardingChecklist.findFirst.mockResolvedValue({ id: 2, employeeId: 7, tenantId: TENANT });
});

describe("onboarding write paths", () => {
    it("hr_onboarding_checklist_create → verifies the employee in-tenant, then checklist_created.v1", async () => {
        tx.onboardingChecklist.create.mockResolvedValue({ id: 2, employeeId: 7, status: "NOT_STARTED", tenantId: TENANT });
        await svc.createChecklist({ employeeId: 7, tenantId: TENANT }, CTX);
        expect(tx.employee.findFirst.mock.calls[0][0].where).toEqual({ id: 7, tenant_id: TENANT });
        expect(tx.onboardingChecklist.create.mock.calls[0][0].data.tenantId).toBe(TENANT);
        const e = onlyEvent("hr.onboarding.checklist_created.v1", tx.onboardingChecklist.create);
        expect(e.args.payload).toEqual({ checklistId: "2", employeeId: "7", status: "NOT_STARTED" });
    });

    it("refuses a checklist for another tenant's employee — nothing written or enqueued", async () => {
        tx.employee.findFirst.mockResolvedValue(null);
        await expect(svc.createChecklist({ employeeId: 99, tenantId: TENANT }, CTX)).rejects.toMatchObject({ status: 404 });
        expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });

    it("hr_onboarding_checklist_update → tenant-scoped pre-read, update, checklist_updated.v1 (a body tenantId is ignored)", async () => {
        tx.onboardingChecklist.update.mockResolvedValue({ id: 2, employeeId: 7, status: "IN_PROGRESS", tenantId: TENANT });
        await svc.updateChecklist(2, { status: "IN_PROGRESS", tenantId: "forged" }, TENANT, CTX);
        expect(tx.onboardingChecklist.findFirst.mock.calls[0][0].where).toEqual({ id: 2, tenantId: TENANT });
        expect(tx.onboardingChecklist.update.mock.calls[0][0].data).toEqual({ status: "IN_PROGRESS" });
        const e = onlyEvent("hr.onboarding.checklist_updated.v1", tx.onboardingChecklist.update);
        expect(e.args.payload).toEqual({ checklistId: "2", employeeId: "7", status: "IN_PROGRESS", changedFields: ["status"] });
    });

    it("hr_onboarding_task_add → verifies the checklist in-tenant, then task_added.v1", async () => {
        tx.onboardingTask.create.mockResolvedValue({ id: 30, checklistId: 2, assigneeId: 7, completed: false, tenantId: TENANT });
        await svc.addTask({ checklistId: 2, title: "Sign NDA", assigneeId: 7, tenantId: TENANT }, CTX);
        expect(tx.onboardingChecklist.findFirst.mock.calls[0][0].where).toEqual({ id: 2, tenantId: TENANT });
        const e = onlyEvent("hr.onboarding.task_added.v1", tx.onboardingTask.create);
        expect(e.args.payload).toEqual({ taskId: "30", checklistId: "2", assigneeId: "7", completed: false, status: "PENDING" });
    });

    it("refuses a task on another tenant's checklist", async () => {
        tx.onboardingChecklist.findFirst.mockResolvedValue(null);
        await expect(svc.addTask({ checklistId: 99, title: "x", tenantId: TENANT }, CTX)).rejects.toMatchObject({ status: 404 });
        expect(tx.onboardingTask.create).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });

    it("hr_onboarding_task_update → task_updated.v1 carrying completed/status", async () => {
        tx.onboardingTask.findFirst.mockResolvedValue({ id: 30, checklistId: 2, completed: false, tenantId: TENANT });
        tx.onboardingTask.update.mockImplementation(async ({ data }) => ({ id: 30, checklistId: 2, assigneeId: null, tenantId: TENANT, ...data }));
        await svc.updateTask(30, { status: "COMPLETED" }, TENANT, CTX);
        expect(tx.onboardingTask.findFirst.mock.calls[0][0].where).toEqual({ id: 30, tenantId: TENANT });
        const e = onlyEvent("hr.onboarding.task_updated.v1", tx.onboardingTask.update);
        expect(e.args.payload).toMatchObject({ taskId: "30", completed: true, status: "COMPLETED" });
    });

    it("hr_onboarding_task_delete → task_deleted.v1", async () => {
        tx.onboardingTask.findFirst.mockResolvedValue({ id: 30, checklistId: 2, tenantId: TENANT });
        tx.onboardingTask.delete.mockResolvedValue({ id: 30, checklistId: 2, tenantId: TENANT });
        await svc.deleteTask(30, TENANT, CTX);
        expect(prisma.onboardingTask.delete).not.toHaveBeenCalled();
        const e = onlyEvent("hr.onboarding.task_deleted.v1", tx.onboardingTask.delete);
        expect(e.args.payload).toEqual({ taskId: "30", checklistId: "2" });
    });

    it("hr_onboarding_buddy_assign → checklist AND buddy verified in-tenant, then buddy_assigned.v1", async () => {
        tx.onboardingBuddy.upsert.mockResolvedValue({ id: 4, checklistId: 2, buddyId: 8, tenantId: TENANT, buddy: { id: 8, employee_name: "Pat" } });
        await svc.assignBuddy({ checklistId: 2, buddyId: 8, tenantId: TENANT }, CTX);
        expect(tx.employee.findFirst.mock.calls[0][0].where).toEqual({ id: 8, tenant_id: TENANT });
        const e = onlyEvent("hr.onboarding.buddy_assigned.v1", tx.onboardingBuddy.upsert);
        expect(e.args.payload).toEqual({ buddyAssignmentId: "4", checklistId: "2", buddyId: "8" });
        expect(JSON.stringify(e.args)).not.toContain("Pat");
    });

    it("hr_onboarding_survey_submit → survey_submitted.v1 WITHOUT the responses", async () => {
        tx.onboardingSurvey.upsert.mockResolvedValue({ id: 6, checklistId: 2, employeeId: 7, type: "DAY_30", responses: { q1: "secret answer" }, tenantId: TENANT });
        await svc.submitSurvey({ employeeId: 7, checklistId: 2, surveyType: "30_DAY", responses: { q1: "secret answer" }, tenantId: TENANT }, CTX);
        expect(tx.onboardingChecklist.findFirst.mock.calls[0][0].where).toEqual({ id: 2, tenantId: TENANT });
        const e = onlyEvent("hr.onboarding.survey_submitted.v1", tx.onboardingSurvey.upsert);
        expect(e.args.payload).toEqual({ surveyId: "6", checklistId: "2", employeeId: "7", surveyType: "DAY_30" });
        expect(JSON.stringify(e.args)).not.toContain("secret answer");
    });

    it("write services fail closed without a tenant", async () => {
        await expect(svc.createChecklist({ employeeId: 7 }, CTX)).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
        await expect(svc.deleteTask(30, undefined, CTX)).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
        expect(tenantTransaction).not.toHaveBeenCalled();
    });

    it("a tenantless row enqueues nothing", async () => {
        tx.onboardingTask.findFirst.mockResolvedValue({ id: 30, checklistId: 2, tenantId: null });
        tx.onboardingTask.delete.mockResolvedValue({ id: 30, checklistId: 2, tenantId: null });
        await svc.deleteTask(30, TENANT, CTX);
        expect(tx.onboardingTask.delete).toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });
});

describe("onboarding controller threads the VERIFIED tenant", () => {
    const res = () => {
        const r = { statusCode: 200, body: null };
        r.status = (c) => { r.statusCode = c; return r; };
        r.json = (b) => { r.body = b; return r; };
        r.end = () => r;
        return r;
    };

    it("passes req.user.tenantId (never a body/header value) and the acting employee", async () => {
        tx.onboardingTask.findFirst.mockResolvedValue({ id: 30, checklistId: 2, tenantId: TENANT });
        tx.onboardingTask.delete.mockResolvedValue({ id: 30, checklistId: 2, tenantId: TENANT });
        const r = res();
        await ctrl.deleteTask({ params: { taskId: "30" }, headers: { "x-tenant-id": "forged" }, user: { tenantId: TENANT, employeeId: 12 } }, r);
        expect(r.statusCode).toBe(204);
        expect(tx.onboardingTask.findFirst.mock.calls[0][0].where.tenantId).toBe(TENANT);
        expect(enqueued[0].args.actorId).toBe(12);
    });

    it("a body tenantId cannot override the verified one", async () => {
        tx.onboardingChecklist.create.mockResolvedValue({ id: 2, employeeId: 7, tenantId: TENANT });
        const r = res();
        await ctrl.createChecklist({ body: { employeeId: 7, tenantId: "forged" }, headers: {}, user: { tenantId: TENANT, employeeId: 12 } }, r);
        expect(r.statusCode).toBe(201);
        expect(tx.onboardingChecklist.create.mock.calls[0][0].data.tenantId).toBe(TENANT);
    });

    it("refuses a write with no verified tenant (400) before touching the database", async () => {
        const r = res();
        await ctrl.addTask({ params: { id: "2" }, body: { title: "x" }, headers: {}, user: {} }, r);
        expect(r.statusCode).toBe(400);
        expect(tenantTransaction).not.toHaveBeenCalled();
    });
});
