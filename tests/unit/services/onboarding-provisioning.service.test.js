// Recruitment Phase 4 — IT provisioning requests: raised by the handoff from
// the checklist's IT and workspace tasks, kept in step with their task, and
// worked by IT through the status machine with compare-and-set versions.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { makeProvisioningDb, eventRecorder } from "./helpers/onboarding-provisioning.fake.js";

let db = makeProvisioningDb();
let recorder = eventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({
    default: new Proxy({}, { get: (_t, prop) => db[prop] }),
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: (...args) => recorder.enqueueHrDomainEvent(...args),
    default: (...args) => recorder.enqueueHrDomainEvent(...args),
}));

const svc = await import("../../../src/services/onboarding-provisioning.service.js");
const { materializeOnboardingTaskRows, DEFAULT_ONBOARDING_TASKS } = await import("../../../src/lib/onboarding-defaults.util.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const START = new Date("2026-11-02T00:00:00.000Z");
const NOW = new Date("2026-10-20T09:00:00.000Z");
const as = (tenantId, fn, employeeId = 77) => mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());
const inTx = (tenantId, fn) => as(tenantId, async () => await db.$transaction(async (tx) => await fn(tx)));

const ORIGINAL_FLAG = process.env.HR_ONBOARDING_AUTOMATION;
afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_ONBOARDING_AUTOMATION;
    else process.env.HR_ONBOARDING_AUTOMATION = ORIGINAL_FLAG;
});

// A hire with the baseline checklist, as the handoff leaves it.
function seedHire({ tenantId = TENANT, employeeId = 500, checklistId = 900, managerId = 41 } = {}) {
    db.rows("employee").push({ id: employeeId, tenant_id: tenantId, employee_name: "Sara Khan", first_name: "Sara", last_name: "Khan", managerId });
    db.rows("onboardingChecklist").push({ id: checklistId, tenantId, employeeId, startDate: START });
    const tasks = materializeOnboardingTaskRows({ tasks: DEFAULT_ONBOARDING_TASKS, checklistId, tenantId, startDate: START });
    tasks.forEach((task, index) => db.rows("onboardingTask").push({
        id: checklistId * 10 + index, completed: false, completedAt: null, assigneeId: task.assigneeType === "IT" ? 61 : null, ...task,
    }));
    return { employeeId, checklistId };
}

const raise = (opts = {}) => inTx(TENANT, (tx) => svc.createProvisioningRequestsInTx(tx, {
    tenantId: TENANT, checklistId: 900, employeeId: 500, startDate: START, now: NOW, ...opts,
}));
const requests = () => db.rows("onboardingProvisioningRequest");
const byTitle = (title) => requests().find((r) => r.title === title);

beforeEach(() => {
    db = makeProvisioningDb();
    recorder = eventRecorder();
    process.env.HR_ONBOARDING_AUTOMATION = "true";
});

describe("createProvisioningRequestsInTx (the handoff)", () => {
    it("raises one request per IT or workspace task that is a request to IT", async () => {
        seedHire();
        const summary = await raise();
        expect(summary).toEqual({ created: 3, existing: 0 });
        expect(requests().map((r) => [r.title, r.kind, r.status]).sort()).toEqual([
            ["Allocate laptop and peripherals", "DEVICE", "REQUESTED"],
            ["Prepare work email and system accounts", "EMAIL", "REQUESTED"],
            ["Prepare workspace and access badge", "WORKSPACE", "REQUESTED"],
        ]);
        // The new hire's own "Confirm day-one system access" is not a request.
        expect(byTitle("Confirm day-one system access")).toBeUndefined();
        // Due dates come from the tasks (start minus 2 and 1 days, and day one).
        expect(byTitle("Prepare work email and system accounts").dueDate.toISOString()).toBe("2026-10-31T00:00:00.000Z");
        expect(byTitle("Allocate laptop and peripherals").dueDate.toISOString()).toBe("2026-11-01T00:00:00.000Z");
        expect(requests().every((r) => r.tenantId === TENANT && r.employeeId === 500 && r.checklistId === 900)).toBe(true);
    });

    it("announces each new request with ids and routing only", async () => {
        seedHire();
        await raise({ actorId: 9 });
        const events = recorder.named("provisioning_requested");
        expect(events).toHaveLength(3);
        const email = events.find((e) => e.payload.kind === "EMAIL");
        expect(email).toMatchObject({
            tenantId: TENANT,
            aggregateType: "OnboardingProvisioningRequest",
            actorId: 9,
            payload: {
                checklistId: "900", employeeId: "500", kind: "EMAIL", status: "REQUESTED",
                dueDate: "2026-10-31T00:00:00.000Z", managerId: "41", assigneeId: "61",
            },
        });
        expect(JSON.stringify(events)).not.toMatch(/Sara|Khan|email and system/);
    });

    it("is idempotent: a second run creates nothing and announces nothing", async () => {
        seedHire();
        await raise();
        recorder.events.length = 0;
        expect(await raise()).toEqual({ created: 0, existing: 3 });
        expect(requests()).toHaveLength(3);
        expect(recorder.events).toHaveLength(0);
    });

    it("uses the day before the start date when the task has no due date", async () => {
        seedHire();
        db.rows("onboardingTask").find((t) => t.title === "Allocate laptop and peripherals").dueDate = null;
        await raise();
        expect(byTitle("Allocate laptop and peripherals").dueDate.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    });

    it("reads the start date and employee from the checklist when not given", async () => {
        seedHire();
        db.rows("onboardingTask").forEach((t) => { t.dueDate = null; });
        await inTx(TENANT, (tx) => svc.createProvisioningRequestsInTx(tx, { tenantId: TENANT, checklistId: 900, now: NOW }));
        expect(requests()).toHaveLength(3);
        expect(requests().every((r) => r.employeeId === 500 && r.dueDate.toISOString() === "2026-11-01T00:00:00.000Z")).toBe(true);
    });

    it("skips completed tasks and never sees another tenant's tasks", async () => {
        seedHire();
        seedHire({ tenantId: OTHER, employeeId: 501, checklistId: 901 });
        db.rows("onboardingTask").find((t) => t.checklistId === 900 && t.title.startsWith("Allocate")).completed = true;
        expect(await raise()).toEqual({ created: 2, existing: 0 });
        expect(requests().every((r) => r.tenantId === TENANT)).toBe(true);
    });

    it("runs every query under the caller's tenant inside the caller's transaction", async () => {
        seedHire();
        await raise();
        const ops = db.state.ops;
        expect(ops.length).toBeGreaterThan(0);
        expect(ops.every((op) => op.tenant === TENANT && op.tx != null)).toBe(true);
        expect(recorder.events.every((e) => e.txId != null)).toBe(true);
    });

    it("raises nothing with the flag off", async () => {
        seedHire();
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(await raise()).toEqual({ created: 0, existing: 0, skipped: "FLAG_OFF" });
        expect(requests()).toHaveLength(0);
    });
});

describe("ensureProvisioningRequestForTaskInTx (a task added later)", () => {
    const ensure = (task) => inTx(TENANT, (tx) => svc.ensureProvisioningRequestForTaskInTx(tx, { tenantId: TENANT, task, now: NOW }));

    it("raises a request for a qualifying task, once", async () => {
        seedHire();
        const task = { id: 7001, checklistId: 900, tenantId: TENANT, title: "Grant VPN access", category: "IT_ACCESS_SETUP", assigneeType: "IT", assigneeId: 61, dueDate: null, completed: false };
        db.rows("onboardingTask").push(task);
        const first = await ensure(task);
        expect(first).toMatchObject({ created: true });
        expect(requests().find((r) => r.id === first.requestId)).toMatchObject({ kind: "ACCESS", taskId: 7001 });
        expect(requests()[0].dueDate.toISOString()).toBe("2026-11-01T00:00:00.000Z");
        expect(await ensure(task)).toEqual({ created: false, requestId: first.requestId });
        expect(recorder.named("provisioning_requested")).toHaveLength(1);
    });

    it("ignores a task that is not a request to IT", async () => {
        seedHire();
        expect(await ensure({ id: 7002, checklistId: 900, title: "Lunch with the team", category: "TEAM_INTRODUCTION", assigneeType: "MANAGER" }))
            .toEqual({ created: false, requestId: null, skipped: "NOT_PROVISIONING" });
    });
});

describe("syncProvisioningFromTaskInTx (the task screens)", () => {
    const sync = (taskId, completed) => inTx(TENANT, (tx) => svc.syncProvisioningFromTaskInTx(tx, { tenantId: TENANT, taskId, completed, actorId: 12, now: NOW }));
    const emailTask = () => db.rows("onboardingTask").find((t) => t.title === "Prepare work email and system accounts");

    it("completing the task fulfils the request; reopening puts it back in progress", async () => {
        seedHire();
        await raise();
        const done = await sync(emailTask().id, true);
        expect(done).toMatchObject({ changed: true, status: "FULFILLED" });
        const request = byTitle("Prepare work email and system accounts");
        expect(request).toMatchObject({ status: "FULFILLED", fulfilledById: null, version: 1 });
        expect(request.fulfilledAt).toEqual(NOW);
        expect(recorder.named("provisioning_fulfilled")[0].payload).toMatchObject({ source: "TASK", previousStatus: "REQUESTED", fulfilledById: null });

        const reopened = await sync(emailTask().id, false);
        expect(reopened).toMatchObject({ changed: true, status: "IN_PROGRESS" });
        expect(byTitle("Prepare work email and system accounts")).toMatchObject({ status: "IN_PROGRESS", fulfilledAt: null, version: 2 });
        expect(recorder.named("provisioning_updated")[0].payload).toMatchObject({ previousStatus: "FULFILLED", status: "IN_PROGRESS" });
    });

    it("reopening the task leaves a request IT fulfilled through the request tool alone", async () => {
        seedHire();
        await raise();
        Object.assign(byTitle("Prepare work email and system accounts"), { status: "FULFILLED", fulfilledById: 61, fulfilledAt: NOW });
        expect(await sync(emailTask().id, false)).toMatchObject({ changed: false, status: "FULFILLED" });
    });

    it("leaves a closed request alone on completion and is a no-op for tasks without one", async () => {
        seedHire();
        await raise();
        Object.assign(byTitle("Prepare work email and system accounts"), { status: "REJECTED" });
        expect(await sync(emailTask().id, true)).toMatchObject({ changed: false, status: "REJECTED" });
        expect(await sync(123456, true)).toEqual({ changed: false, requestId: null, status: null });
    });
});

describe("cancelProvisioningForTaskInTx (the task deleted)", () => {
    it("cancels the open request and frees the task id", async () => {
        seedHire();
        await raise();
        const task = db.rows("onboardingTask").find((t) => t.title.startsWith("Allocate"));
        const res = await inTx(TENANT, (tx) => svc.cancelProvisioningForTaskInTx(tx, { tenantId: TENANT, taskId: task.id }));
        expect(res.cancelled).toBe(true);
        expect(requests().find((r) => r.id === res.requestId)).toMatchObject({ status: "CANCELLED", taskId: null, version: 1 });
    });
});

describe("updateProvisioningRequest (IT's work)", () => {
    const update = (args) => as(TENANT, () => svc.updateProvisioningRequest({ tenantId: TENANT, actorId: 61, now: NOW, ...args }));
    const setup = async () => {
        seedHire();
        await raise();
        recorder.events.length = 0;
        return byTitle("Allocate laptop and peripherals");
    };

    it("acknowledges, then fulfils and completes the linked task in the same transaction", async () => {
        const request = await setup();
        const acked = await update({ requestId: request.id, expectedVersion: 0, status: "IN_PROGRESS", externalRef: "IT-4411" });
        expect(acked).toMatchObject({ status: "IN_PROGRESS", version: 1, externalRef: "IT-4411", acknowledgedAt: NOW, allowedTransitions: ["FULFILLED", "REJECTED", "CANCELLED"] });
        expect(recorder.named("provisioning_updated")[0].payload).toMatchObject({ previousStatus: "REQUESTED", changedFields: ["status", "acknowledgedAt", "externalRef"] });

        const done = await update({ requestId: request.id, expectedVersion: 1, status: "FULFILLED", notes: "Asset LT-220" });
        expect(done).toMatchObject({ status: "FULFILLED", version: 2, fulfilledById: 61, fulfilledAt: NOW, taskCompleted: true, employeeName: "Sara Khan" });
        const task = db.rows("onboardingTask").find((t) => t.id === request.taskId);
        expect(task).toMatchObject({ completed: true, completedAt: NOW });
        const fulfilled = recorder.named("provisioning_fulfilled");
        const taskEvent = recorder.events.find((e) => e.eventName === "hr.onboarding.task_updated.v1");
        expect(fulfilled[0].payload).toMatchObject({ source: "REQUEST", fulfilledById: "61", managerId: "41", assigneeId: "61" });
        expect(taskEvent.payload).toMatchObject({ taskId: String(task.id), completed: true });
        expect(taskEvent.txId).toBe(fulfilled[0].txId);
    });

    it("answers 409 with the current version when the version is stale", async () => {
        const request = await setup();
        await update({ requestId: request.id, expectedVersion: 0, status: "IN_PROGRESS" });
        await expect(update({ requestId: request.id, expectedVersion: 0, status: "FULFILLED" }))
            .rejects.toMatchObject({ status: 409, code: "HR-ONBOARDING-PROVISIONING-VERSION-CONFLICT", currentVersion: 1 });
        expect(byTitle("Allocate laptop and peripherals").status).toBe("IN_PROGRESS");
    });

    it("a writer that lands between the read and the write still gets 409", async () => {
        const request = await setup();
        const table = db.onboardingProvisioningRequest;
        const real = table.updateMany;
        table.updateMany = (args) => {
            table.updateMany = real;
            byTitle("Allocate laptop and peripherals").version = 5;
            return real(args);
        };
        await expect(update({ requestId: request.id, expectedVersion: 0, status: "IN_PROGRESS" }))
            .rejects.toMatchObject({ status: 409, currentVersion: 5 });
        expect(byTitle("Allocate laptop and peripherals").status).toBe("REQUESTED");
    });

    it("lets IT fulfil a REQUESTED one in one call, stamping the acknowledgement", async () => {
        const request = await setup();
        const out = await update({ requestId: request.id, expectedVersion: 0, status: "FULFILLED" });
        expect(out).toMatchObject({ status: "FULFILLED" });
        expect(out.acknowledgedAt).toBeTruthy();
        expect(out.fulfilledAt).toBeTruthy();
        expect(db.rows("onboardingTask").find((t) => t.id === request.taskId).completed).toBe(true);
    });

    it("refuses a jump the status machine does not allow", async () => {
        const request = await setup();
        await update({ requestId: request.id, expectedVersion: 0, status: "FULFILLED" });
        recorder.events.length = 0;
        await expect(update({ requestId: request.id, expectedVersion: 1, status: "IN_PROGRESS" }))
            .rejects.toMatchObject({ status: 409, code: "HR-ONBOARDING-PROVISIONING-TRANSITION" });
        expect(recorder.events).toHaveLength(0);
    });

    it("needs notes to reject", async () => {
        const request = await setup();
        await update({ requestId: request.id, expectedVersion: 0, status: "IN_PROGRESS" });
        await expect(update({ requestId: request.id, expectedVersion: 1, status: "REJECTED", notes: "  " }))
            .rejects.toMatchObject({ status: 400, code: "HR-ONBOARDING-PROVISIONING-NOTES-REQUIRED" });
        const rejected = await update({ requestId: request.id, expectedVersion: 1, status: "REJECTED", notes: "No stock until December" });
        expect(rejected).toMatchObject({ status: "REJECTED", notes: "No stock until December", allowedTransitions: [] });
    });

    it("lets HR cancel an open request but not an IT-only caller", async () => {
        const request = await setup();
        await expect(update({ requestId: request.id, expectedVersion: 0, status: "CANCELLED", allowCancel: false }))
            .rejects.toMatchObject({ status: 403, code: "HR-ONBOARDING-PROVISIONING-FORBIDDEN" });
        expect(await update({ requestId: request.id, expectedVersion: 0, status: "CANCELLED" })).toMatchObject({ status: "CANCELLED" });
    });

    it("an update with nothing new changes nothing", async () => {
        const request = await setup();
        const res = await update({ requestId: request.id, expectedVersion: 0, status: "REQUESTED" });
        expect(res).toMatchObject({ unchanged: true, version: 0 });
        expect(recorder.events).toHaveLength(0);
    });

    it("never reaches another tenant's request", async () => {
        const request = await setup();
        await expect(as(OTHER, () => svc.updateProvisioningRequest({ tenantId: OTHER, requestId: request.id, expectedVersion: 0, status: "IN_PROGRESS" })))
            .rejects.toMatchObject({ status: 404, code: "HR-ONBOARDING-PROVISIONING-NOT-FOUND" });
    });

    it("requires an expected version", async () => {
        const request = await setup();
        await expect(update({ requestId: request.id, status: "IN_PROGRESS" })).rejects.toMatchObject({ status: 400 });
    });
});

describe("list and get", () => {
    const list = (args = {}) => as(TENANT, () => svc.listProvisioningRequests({ tenantId: TENANT, now: NOW, ...args }));

    it("lists soonest due first with the hire's name and the task title", async () => {
        seedHire();
        await raise();
        const page = await list();
        expect(page.total).toBe(3);
        expect(page.items.map((r) => r.kind)).toEqual(["EMAIL", "DEVICE", "WORKSPACE"]);
        expect(page.items[0]).toMatchObject({ employeeName: "Sara Khan", taskTitle: "Prepare work email and system accounts", overdue: false, version: 0 });
    });

    it("filters by kind, status, employee, overdue and due before, and pages", async () => {
        seedHire();
        await raise();
        byTitle("Prepare work email and system accounts").dueDate = new Date("2026-10-19T00:00:00.000Z");
        expect((await list({ kind: "DEVICE" })).items.map((r) => r.kind)).toEqual(["DEVICE"]);
        expect((await list({ overdue: true })).items.map((r) => r.kind)).toEqual(["EMAIL"]);
        expect((await list({ overdue: false })).total).toBe(2);
        expect((await list({ dueBefore: "2026-11-01T12:00:00Z" })).total).toBe(2);
        expect((await list({ status: "FULFILLED" })).total).toBe(0);
        expect((await list({ employeeId: 999 })).total).toBe(0);
        const paged = await list({ page: 2, limit: 2 });
        expect(paged).toMatchObject({ total: 3, page: 2, limit: 2 });
        expect(paged.items).toHaveLength(1);
        await expect(list({ dueBefore: "not a date" })).rejects.toMatchObject({ status: 400 });
    });

    it("an overdue request that is closed is not overdue", async () => {
        seedHire();
        await raise();
        Object.assign(byTitle("Prepare work email and system accounts"), { dueDate: new Date("2026-10-01T00:00:00Z"), status: "FULFILLED" });
        expect((await list({ overdue: true })).total).toBe(0);
    });

    it("gets one request and 404s across tenants", async () => {
        seedHire();
        await raise();
        const id = byTitle("Allocate laptop and peripherals").id;
        expect(await as(TENANT, () => svc.getProvisioningRequest({ tenantId: TENANT, requestId: id, now: NOW })))
            .toMatchObject({ id, kind: "DEVICE", taskTitle: "Allocate laptop and peripherals", allowedTransitions: ["IN_PROGRESS", "FULFILLED", "REJECTED", "CANCELLED"] });
        await expect(as(OTHER, () => svc.getProvisioningRequest({ tenantId: OTHER, requestId: id })))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe("the flag", () => {
    it("assertOnboardingAutomationEnabled answers 503 with a -DISABLED code when off", () => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(() => svc.assertOnboardingAutomationEnabled()).toThrow(expect.objectContaining({ status: 503, code: "HR-ONBOARDING-AUTOMATION-DISABLED" }));
        process.env.HR_ONBOARDING_AUTOMATION = "true";
        expect(() => svc.assertOnboardingAutomationEnabled()).not.toThrow();
    });
});
