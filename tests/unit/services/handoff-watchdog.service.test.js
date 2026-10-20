// Recruitment Phase 4 (stream M) — the handoff watchdog: a handoff stuck
// IN_PROGRESS past 30 minutes (a crash mid-handoff) becomes FAILED "stalled"
// with an attempt row, the existing handoff_failed event routed to the
// offer's recruiter, and a "failed" on the handoff counter the alert reads;
// fresh, finished and already-settled rows are left alone.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import client from "prom-client";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
// The handoff module drags payroll in; the watchdog only needs its statuses.
jest.unstable_mockModule("../../../src/services/recruitmentHandoff.service.js", () => ({
    HANDOFF_STATUS: Object.freeze({ IN_PROGRESS: "IN_PROGRESS", COMPLETED: "COMPLETED", FAILED: "FAILED" }),
}));

const { HANDOFF_METRIC, _resetRecruitmentOpsMetricsForTests } = await import("../../../src/lib/recruitmentOpsMetrics.js");
const { runHandoffWatchdogJob } = await import("../../../src/services/handoff-watchdog.service.js");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000);

async function failedCount() {
    const metric = client.register.getSingleMetric(HANDOFF_METRIC);
    if (!metric) return 0;
    const { values } = await metric.get();
    return values.find((v) => v.labels.outcome === "failed")?.value ?? 0;
}

function seed() {
    db.state.tables = {};
    db.state.ops.length = 0;
    recorder.events.length = 0;
    const t = db.state.tables;
    t.offer = [
        { id: 70, tenantId: A, createdById: 9 },
        { id: 71, tenantId: B, createdById: null },
        { id: 72, tenantId: A, createdById: 9 },
    ];
    t.offerHandoff = [
        { id: 1, tenantId: A, offerId: 70, status: "IN_PROGRESS", attemptCount: 1, lastError: null, updated_at: minutesAgo(45) },
        { id: 2, tenantId: A, offerId: 72, status: "IN_PROGRESS", attemptCount: 2, lastError: null, updated_at: minutesAgo(10) },
        { id: 3, tenantId: B, offerId: 71, status: "COMPLETED", attemptCount: 1, lastError: null, updated_at: minutesAgo(600) },
        { id: 4, tenantId: B, offerId: 71, status: "IN_PROGRESS", attemptCount: 3, lastError: null, updated_at: minutesAgo(120) },
    ];
    t.offerHandoffAttempt = [];
}

const handoff = (id) => db.state.tables.offerHandoff.find((h) => h.id === id);

beforeEach(() => {
    delete process.env.HR_RECRUITMENT_OFFER_HANDOFF;
    _resetRecruitmentOpsMetricsForTests();
    seed();
});

describe("runHandoffWatchdogJob", () => {
    it("is off with the handoff flag", async () => {
        process.env.HR_RECRUITMENT_OFFER_HANDOFF = "false";
        expect(await runHandoffWatchdogJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.state.ops).toHaveLength(0);
    });

    it("fails handoffs stalled over 30 minutes, like the handoff's own failure path", async () => {
        const summary = await runHandoffWatchdogJob({ now: NOW });
        expect(summary).toEqual({ scanned: 2, failed: 2, raceLost: 0, errors: 0 });

        expect(handoff(1)).toMatchObject({ status: "FAILED", lastError: "stalled" });
        expect(handoff(4)).toMatchObject({ status: "FAILED", lastError: "stalled" });
        expect(handoff(2).status).toBe("IN_PROGRESS");
        expect(handoff(3).status).toBe("COMPLETED");

        expect(db.state.tables.offerHandoffAttempt.map((a) => [a.handoffId, a.tenantId, a.step, a.status, a.error])).toEqual([
            [4, B, "provision", "FAILED", "stalled"],
            [1, A, "provision", "FAILED", "stalled"],
        ]);
        const events = recorder.events.filter((e) => e.eventName === "hr.recruitment.handoff_failed.v1");
        expect(events.map((e) => [e.tenantId, e.payload])).toEqual([
            [B, { handoffId: "4", offerId: "71", step: "provision", attemptCount: 3, operatorId: null }],
            [A, { handoffId: "1", offerId: "70", step: "provision", attemptCount: 1, operatorId: "9" }],
        ]);
        // The alert's series moved once per settled row.
        expect(await failedCount()).toBe(2);
    });

    it("settles each row under its own tenant, in one transaction", async () => {
        await runHandoffWatchdogJob({ now: NOW });
        const [scan, ...rest] = db.state.ops;
        expect(scan).toMatchObject({ model: "offerHandoff", op: "findMany", tenant: "SYSTEM" });
        const forOne = rest.filter((o) => o.tenant === A);
        expect(forOne.map((o) => `${o.model}.${o.op}`)).toEqual([
            "offerHandoff.updateMany", "offerHandoff.findFirst", "offerHandoffAttempt.create", "offer.findFirst",
        ]);
        expect(new Set(forOne.map((o) => o.tx)).size).toBe(1);
    });

    it("is idempotent and loses a race quietly", async () => {
        await runHandoffWatchdogJob({ now: NOW });
        expect(await runHandoffWatchdogJob({ now: NOW })).toEqual({ scanned: 0, failed: 0, raceLost: 0, errors: 0 });

        // A retry moved the row on between the scan and the claim.
        seed();
        _resetRecruitmentOpsMetricsForTests();
        const original = db.offerHandoff;
        db.offerHandoff = { ...original, updateMany: () => Promise.resolve({ count: 0 }) };
        try {
            expect(await runHandoffWatchdogJob({ now: NOW })).toMatchObject({ scanned: 2, failed: 0, raceLost: 2 });
        } finally {
            db.offerHandoff = original;
        }
        expect(recorder.events).toHaveLength(0);
        expect(await failedCount()).toBe(0);
    });

    it("one failing row does not stop the rest", async () => {
        const original = db.offerHandoffAttempt;
        db.offerHandoffAttempt = {
            ...original,
            create: (args) => (args.data.handoffId === 4 ? Promise.reject(new Error("db down")) : original.create(args)),
        };
        try {
            expect(await runHandoffWatchdogJob({ now: NOW })).toMatchObject({ failed: 1, errors: 1 });
        } finally {
            db.offerHandoffAttempt = original;
        }
        // The failed row's transaction rolled back: it stays IN_PROGRESS for the next pass.
        expect(handoff(4).status).toBe("IN_PROGRESS");
        expect(handoff(1).status).toBe("FAILED");
        expect(await failedCount()).toBe(1);
    });
});
