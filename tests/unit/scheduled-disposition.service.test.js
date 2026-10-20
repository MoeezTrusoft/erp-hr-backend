// tests/unit/scheduled-disposition.service.test.js
//
// Recruitment Phase 2 — the delayed, reversible knockout disposition:
//
//   * the job checks its flag, scans due PENDING rows under the SYSTEM context
//     and runs each row under ITS tenant's context, claiming it with a guarded
//     status update so a concurrent run cannot execute it twice;
//   * execution goes through the recruiter's workflow transition (rejected,
//     the reason code, source system.knockout, no actor, the job's tx);
//   * an application that already moved on is CANCELLED (STAGE_CHANGED), with
//     the cancelled event, never rejected;
//   * a failure rolls back, counts the attempt and is retried later; the fifth
//     failure is FAILED; one bad row never stops the run;
//   * cancel: ORG only, a reason, PENDING only, an ids-only event; the stage-
//     change hook cancels every pending row of the application.
//
// Prisma doubles are LAZY like the real client (a query runs only when it is
// awaited) and record the request context at that moment, so a query that
// escapes its mcpCtx.run is caught.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");

const { mcpCtx } = await import("../../src/lib/requestContext.js");

const seen = []; // { op, ctx }
const lazy = (op, impl) =>
    jest.fn((args) => ({
        then(resolve, reject) {
            const store = mcpCtx.getStore();
            seen.push({ op, system: store?.system === true, tenantId: store?.user?.tenantId ?? null });
            return Promise.resolve().then(() => impl(args)).then(resolve, reject);
        },
    }));

let ROWS = [];
let APPS = new Map();
const find = (where = {}) =>
    ROWS.filter(
        (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.tenantId === undefined || r.tenantId === where.tenantId) &&
            (where.applicationId === undefined || r.applicationId === where.applicationId) &&
            (where.source === undefined || r.source === where.source) &&
            (where.status === undefined || r.status === where.status) &&
            (where.executeAt?.lte === undefined || r.executeAt <= where.executeAt.lte),
    );

const prisma = {
    scheduledDisposition: {
        findMany: lazy("sd.findMany", ({ where }) => find(where).map((r) => ({ ...r }))),
        findFirst: lazy("sd.findFirst", ({ where }) => (find(where)[0] ? { ...find(where)[0] } : null)),
        updateMany: lazy("sd.updateMany", ({ where, data }) => {
            const rows = find(where);
            rows.forEach((r) => Object.assign(r, data));
            return { count: rows.length };
        }),
        update: lazy("sd.update", ({ where, data }) => Object.assign(ROWS.find((r) => r.id === where.id), data)),
        count: lazy("sd.count", ({ where }) => find(where).length),
        upsert: lazy("sd.upsert", ({ create }) => ({ id: 1, ...create })),
    },
    application: {
        findFirst: lazy("app.findFirst", ({ where }) => {
            const app = APPS.get(where.id);
            return app && app.tenantId === where.tenantId ? { ...app } : null;
        }),
    },
    dispositionReasonCode: {
        findFirst: lazy("drc.findFirst", () => null),
        createMany: lazy("drc.createMany", ({ data }) => ({ count: data.length })),
    },
};
prisma.$transaction = jest.fn(async (fn) => fn(prisma));

const flags = { knockout: true };
const events = [];
const transitionApplicationStage = jest.fn(async (args) => {
    const store = mcpCtx.getStore();
    seen.push({ op: "transition", tenantId: store?.user?.tenantId ?? null });
    if (state.transitionError) throw state.transitionError;
    return { success: true, changed: true, data: { id: args.id } };
});
const state = { transitionError: null };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
loggerMock.child = () => loggerMock;

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: loggerMock }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (client, fn) => {
        // A real transaction rolls its writes back when the callback throws.
        const snapshot = ROWS.map((r) => ({ ...r }));
        try {
            return await client.$transaction(fn);
        } catch (err) {
            ROWS = snapshot;
            throw err;
        }
    }),
    rlsTenantExtension: jest.fn((c) => c),
}));
jest.unstable_mockModule("../../src/lib/recruitmentFlags.js", () => ({
    isRecruitmentFlagEnabled: jest.fn((key) => flags[key] === true),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: jest.fn(async (_tx, args) => {
        if (args) events.push(args);
    }),
}));
jest.unstable_mockModule("../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage }));
jest.unstable_mockModule("../../src/services/recruitment-settings.service.js", () => ({
    RECRUITMENT_SETTINGS_DEFAULTS: { knockoutDelayHours: 24 },
}));

const svc = await import("../../src/services/scheduled-disposition.service.js");

const row = (overrides = {}) => ({
    id: 1,
    tenantId: TENANT_A,
    applicationId: 10,
    source: "KNOCKOUT",
    reasonCode: "MINIMUM_REQUIREMENTS_NOT_MET",
    status: "PENDING",
    executeAt: new Date("2026-10-20T09:00:00.000Z"),
    attempts: 0,
    ...overrides,
});
const ORG = { level: "ORG", unrestricted: true, canSeeInternalNotes: true, employeeId: 7 };
const MANAGED = { level: "MANAGED", unrestricted: false, canSeeInternalNotes: true, employeeId: 8 };

beforeEach(() => {
    jest.clearAllMocks();
    seen.length = 0;
    events.length = 0;
    flags.knockout = true;
    state.transitionError = null;
    ROWS = [row()];
    APPS = new Map([[10, { id: 10, tenantId: TENANT_A, stage: "applied" }]]);
});

describe("runScheduledDispositionJob", () => {
    it("is a no-op with the knockout flag off", async () => {
        flags.knockout = false;
        expect(await svc.runScheduledDispositionJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(prisma.scheduledDisposition.findMany).not.toHaveBeenCalled();
    });

    it("executes a due row through the recruiter's transition, under the row's tenant", async () => {
        const summary = await svc.runScheduledDispositionJob({ now: NOW });

        expect(summary).toMatchObject({ scanned: 1, executed: 1, cancelled: 0, failed: 0 });
        expect(transitionApplicationStage).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 10,
                tenantId: TENANT_A,
                targetStage: "rejected",
                reason: "MINIMUM_REQUIREMENTS_NOT_MET",
                actorId: null,
                source: "system.knockout",
                db: prisma,
            }),
        );
        expect(ROWS[0]).toMatchObject({ status: "EXECUTED", executedAt: NOW });
        // The scan ran under SYSTEM, every per-row query under the row's tenant.
        expect(seen.find((s) => s.op === "sd.findMany")).toMatchObject({ system: true });
        for (const s of seen.filter((x) => x.op !== "sd.findMany")) expect(s.tenantId).toBe(TENANT_A);
    });

    it("only picks rows that are due", async () => {
        ROWS = [row({ executeAt: new Date("2026-10-21T00:00:00.000Z") })];
        expect(await svc.runScheduledDispositionJob({ now: NOW })).toMatchObject({ scanned: 0, executed: 0 });
        expect(transitionApplicationStage).not.toHaveBeenCalled();
    });

    it.each(["interview", "on_hold", "rejected", "withdrawn", "hired"])(
        "cancels (STAGE_CHANGED) when the application is already in %s",
        async (stage) => {
            APPS.get(10).stage = stage;
            const summary = await svc.runScheduledDispositionJob({ now: NOW });
            expect(summary).toMatchObject({ cancelled: 1, executed: 0 });
            expect(transitionApplicationStage).not.toHaveBeenCalled();
            expect(ROWS[0]).toMatchObject({ status: "CANCELLED", cancelReason: "STAGE_CHANGED", executedAt: null });
            expect(events[0]).toMatchObject({
                eventName: "hr.recruitment.disposition_cancelled.v1",
                tenantId: TENANT_A,
                payload: { scheduledDispositionId: "1", applicationId: "10", cancelReasonCode: "STAGE_CHANGED", status: "CANCELLED" },
            });
        },
    );

    it("still executes from screening (an early stage)", async () => {
        APPS.get(10).stage = "screening";
        expect(await svc.runScheduledDispositionJob({ now: NOW })).toMatchObject({ executed: 1 });
    });

    it("a row another run already claimed is skipped, not executed twice", async () => {
        // The claim's guarded update matches nothing once another run flipped it.
        prisma.scheduledDisposition.updateMany.mockImplementationOnce(() => ({ then: (r) => r({ count: 0 }) }));
        const summary = await svc.runScheduledDispositionJob({ now: NOW });
        expect(summary).toMatchObject({ skipped: 1, executed: 0 });
        expect(transitionApplicationStage).not.toHaveBeenCalled();
    });

    it("a failure rolls back, counts the attempt and schedules a retry", async () => {
        state.transitionError = Object.assign(new Error("boom"), { code: "HR-RECRUITMENT-WORKFLOW" });
        const summary = await svc.runScheduledDispositionJob({ now: NOW });
        expect(summary).toMatchObject({ retried: 1, failed: 0, executed: 0 });
        expect(ROWS[0]).toMatchObject({ status: "PENDING", attempts: 1, lastError: "HR-RECRUITMENT-WORKFLOW: boom" });
        expect(ROWS[0].executeAt.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
    });

    it("the fifth failure marks the row FAILED", async () => {
        ROWS = [row({ attempts: 4 })];
        state.transitionError = new Error("still broken");
        const summary = await svc.runScheduledDispositionJob({ now: NOW });
        expect(summary).toMatchObject({ failed: 1, retried: 0 });
        expect(ROWS[0]).toMatchObject({ status: "FAILED", attempts: 5 });
    });

    it("one bad row never stops the others, and each runs in its own tenant", async () => {
        ROWS = [row(), row({ id: 2, tenantId: TENANT_B, applicationId: 20 })];
        APPS.set(20, { id: 20, tenantId: TENANT_B, stage: "applied" });
        transitionApplicationStage.mockRejectedValueOnce(new Error("first fails"));
        const summary = await svc.runScheduledDispositionJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 2, executed: 1, retried: 1 });
        expect(ROWS.find((r) => r.id === 2).status).toBe("EXECUTED");
        expect(transitionApplicationStage.mock.calls.map(([args]) => args.tenantId)).toEqual([TENANT_A, TENANT_B]);
        expect(seen.filter((s) => s.op === "transition").map((s) => s.tenantId)).toEqual([TENANT_B]);
    });
});

describe("scheduleKnockoutDisposition", () => {
    it("adds only the knockout code to a tenant that already has a taxonomy", async () => {
        prisma.dispositionReasonCode.findFirst
            .mockImplementationOnce(() => ({ then: (r) => r({ id: 1 }) })) // seeded
            .mockImplementationOnce(() => ({ then: (r) => r(null) })); // but not this code
        await svc.scheduleKnockoutDisposition(prisma, { tenantId: TENANT_A, applicationId: 10, questionIds: [3], delayHours: 0, now: NOW });
        const data = prisma.dispositionReasonCode.createMany.mock.calls[0][0].data;
        expect(data.map((r) => r.code)).toEqual(["MINIMUM_REQUIREMENTS_NOT_MET"]);
        expect(prisma.scheduledDisposition.upsert.mock.calls[0][0].create.executeAt).toEqual(NOW);
    });

    it("writes no code when the tenant already has it, and falls back to the default delay", async () => {
        prisma.dispositionReasonCode.findFirst.mockImplementation(() => ({ then: (r) => r({ id: 1 }) }));
        await svc.scheduleKnockoutDisposition(prisma, { tenantId: TENANT_A, applicationId: 10, now: NOW });
        expect(prisma.dispositionReasonCode.createMany).not.toHaveBeenCalled();
        expect(prisma.scheduledDisposition.upsert.mock.calls[0][0].create.executeAt.toISOString()).toBe("2026-10-21T10:00:00.000Z");
        prisma.dispositionReasonCode.findFirst.mockImplementation(() => ({ then: (r) => r(null) }));
    });
});

describe("cancelScheduledDisposition", () => {
    it("cancels a PENDING row with the recruiter's reason and emits an ids-only event", async () => {
        const result = await svc.cancelScheduledDisposition({ id: 1, tenantId: TENANT_A, actorId: 7, reason: " Permit pending ", scope: ORG });
        expect(result).toMatchObject({ status: "CANCELLED", cancelledById: 7, cancelReason: "Permit pending" });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            eventName: "hr.recruitment.disposition_cancelled.v1",
            aggregateType: "ScheduledDisposition",
            payload: { cancelReasonCode: "MANUAL", cancelledById: "7" },
        });
        expect(JSON.stringify(events[0].payload)).not.toContain("Permit");
    });

    it("finds the row by applicationId too", async () => {
        await svc.cancelScheduledDisposition({ applicationId: 10, tenantId: TENANT_A, reason: "x", scope: ORG });
        expect(ROWS[0].status).toBe("CANCELLED");
    });

    it("is ORG-only", async () => {
        await expect(svc.cancelScheduledDisposition({ id: 1, tenantId: TENANT_A, reason: "x", scope: MANAGED }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-DISPOSITION-FORBIDDEN" });
        expect(ROWS[0].status).toBe("PENDING");
    });

    it("requires a reason", async () => {
        await expect(svc.cancelScheduledDisposition({ id: 1, tenantId: TENANT_A, reason: "  ", scope: ORG }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-DISPOSITION-REASON-REQUIRED" });
    });

    it("refuses a row that is no longer PENDING, and another tenant's row is not found", async () => {
        ROWS[0].status = "EXECUTED";
        await expect(svc.cancelScheduledDisposition({ id: 1, tenantId: TENANT_A, reason: "x", scope: ORG }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DISPOSITION-NOT-PENDING" });
        await expect(svc.cancelScheduledDisposition({ id: 1, tenantId: TENANT_B, reason: "x", scope: ORG }))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe("cancelPendingDispositionsForApplication (the stage-change hook)", () => {
    it("cancels the application's pending rows with STAGE_CHANGED", async () => {
        ROWS.push(row({ id: 2, applicationId: 11 }));
        const count = await svc.cancelPendingDispositionsForApplication(prisma, { tenantId: TENANT_A, applicationId: 10, actorId: 7 });
        expect(count).toBe(1);
        expect(ROWS[0]).toMatchObject({ status: "CANCELLED", cancelReason: "STAGE_CHANGED", cancelledById: 7 });
        expect(ROWS[1].status).toBe("PENDING");
        expect(events[0].payload.cancelReasonCode).toBe("STAGE_CHANGED");
    });
});

describe("listScheduledDispositions", () => {
    it("cuts the rows to the caller's application scope and hides internals from narrower scopes", async () => {
        prisma.scheduledDisposition.findMany.mockImplementationOnce(() => ({
            then: (r) => r([{ ...row(), lastError: "x", cancelReason: "note", application: { candidateId: 4, jobRequisitionId: 5, stage: "applied" } }]),
        }));
        const ASSIGNED = { level: "ASSIGNED", unrestricted: false, canSeeInternalNotes: false, employeeId: 9 };
        const res = await svc.listScheduledDispositions({ tenantId: TENANT_A, scope: ASSIGNED, requisitionId: 5, status: "pending" });

        const { where } = prisma.scheduledDisposition.findMany.mock.calls[0][0];
        expect(where).toMatchObject({ tenantId: TENANT_A, status: "PENDING" });
        expect(where.application.is).toMatchObject({ jobRequisitionId: 5, interviews: expect.any(Object) });
        expect(res.items[0]).toMatchObject({ requisitionId: 5, candidateId: 4, stage: "applied", lastError: null, cancelReason: null });
    });
});
