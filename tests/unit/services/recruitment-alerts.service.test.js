// tests/unit/services/recruitment-alerts.service.test.js
//
// Recruitment Phase 5 — analytics threshold alerts:
//   * the job is flag-gated, scans tenants under the system context and does
//     each tenant's work under that tenant (queries record the context at
//     await time), with per-tenant error isolation;
//   * a breach opens ONE alert and announces it ONCE; later breaching runs
//     only update it; back under resolves it; an acknowledged alert stays
//     acknowledged while breached; a second episode the same day reopens;
//   * a metric with no data neither raises nor resolves;
//   * thresholds are validated and version-checked like the settings, and the
//     recipient must be an active employee of the tenant;
//   * the recipient falls back to the recruiting lead, else null.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { makeAlertsDb } from "./helpers/recruitment-alerts.fake.js";

let fake = makeAlertsDb();
const prismaProxy = new Proxy({}, { get: (_t, key) => fake.db[key] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));

const enqueued = [];
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: jest.fn(async (tx, event) => {
        if (!event) return null;
        enqueued.push(event);
        return tx.outboxEvent.create({ data: { tenantId: event.tenantId, eventName: event.eventName, payload: event.payload } });
    }),
}));

const {
    runRecruitmentAlertsJob,
    setAlertThresholds,
    getAlertThresholds,
    acknowledgeRecruitmentAlert,
    listRecruitmentAlerts,
    recruitmentAnalyticsAlertRaisedEvent,
    ANALYTICS_ALERT_RAISED_EVENT,
} = await import("../../../src/services/recruitment-alerts.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00Z");
const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * 86400000);
const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, fn);

const ENV_KEYS = ["HR_RECRUITMENT_ANALYTICS_ALERTS", "HR_RECRUITMENT_STAGE_SLA_DAYS"];
const savedEnv = {};

beforeEach(() => {
    fake = makeAlertsDb();
    enqueued.length = 0;
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = "true";
    delete process.env.HR_RECRUITMENT_STAGE_SLA_DAYS;
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

const settings = (tenantId, thresholds, extra = {}) =>
    fake.seed("tenantRecruitmentSettings", { tenantId, alertThresholds: thresholds, alertRecipientId: null, version: 3, ...extra });
const failedHandoff = (tenantId, at = daysAgo(2)) => fake.seed("offerHandoff", { tenantId, status: "FAILED", updated_at: at });
const alerts = () => fake.all("recruitmentAlert");

describe("runRecruitmentAlertsJob", () => {
    it("is flag-gated", async () => {
        process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = "false";
        settings(T1, { failedHandoffs: 0 });
        expect(await runRecruitmentAlertsJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(fake.state.ops).toHaveLength(0);
    });

    it("opens one alert per breach, announces it once, and works under the tenant", async () => {
        settings(T1, { failedHandoffs: 1 }, { alertRecipientId: 77 });
        failedHandoff(T1);
        failedHandoff(T1);
        // Outside the 30-day window: not counted.
        failedHandoff(T1, daysAgo(45));

        const first = await runRecruitmentAlertsJob({ now: NOW });
        expect(first).toMatchObject({ tenants: 1, evaluated: 1, opened: 1, events: 1, errors: 0 });
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toMatchObject({ tenantId: T1, metric: "FAILED_HANDOFFS", status: "OPEN", value: 2, threshold: 1 });
        expect(alerts()[0].details).toMatchObject({ failed: 2, recipientId: 77 });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({
            eventName: ANALYTICS_ALERT_RAISED_EVENT,
            tenantId: T1,
            aggregateType: "RecruitmentAlert",
            payload: { metric: "FAILED_HANDOFFS", value: 2, threshold: 1, recipientId: "77" },
        });

        // The scan ran as SYSTEM; every per-tenant query ran as that tenant.
        const settingsScan = fake.state.ops.find((o) => o.model === "tenantRecruitmentSettings");
        expect(settingsScan.tenant).toBe("SYSTEM");
        const tenantOps = fake.state.ops.filter((o) => o.model !== "tenantRecruitmentSettings");
        expect(tenantOps.length).toBeGreaterThan(0);
        expect(tenantOps.every((o) => o.tenant === T1)).toBe(true);
        // The alert write and its event share one transaction.
        const write = fake.state.ops.find((o) => o.model === "recruitmentAlert" && o.op === "create");
        const event = fake.state.ops.find((o) => o.model === "outboxEvent");
        expect(write.tx).not.toBeNull();
        expect(event.tx).toBe(write.tx);

        // A second run while still breached updates the alert, no new event.
        failedHandoff(T1);
        const later = new Date(NOW.getTime() + 3600000);
        const second = await runRecruitmentAlertsJob({ now: later });
        expect(second).toMatchObject({ opened: 0, updated: 1, events: 0 });
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toMatchObject({ status: "OPEN", value: 3 });
        expect(alerts()[0].lastSeenAt.getTime()).toBe(later.getTime());
        expect(enqueued).toHaveLength(1);
    });

    it("resolves when back under, and an acknowledged alert stays acknowledged while breached", async () => {
        settings(T1, { failedHandoffs: 0 });
        const h = failedHandoff(T1);
        await runRecruitmentAlertsJob({ now: NOW });
        const id = alerts()[0].id;

        await asTenant(T1, () => acknowledgeRecruitmentAlert({ tenantId: T1, alertId: id, actorId: 5, now: NOW }));
        expect(alerts()[0]).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedById: 5 });

        await runRecruitmentAlertsJob({ now: new Date(NOW.getTime() + 3600000) });
        expect(alerts()[0].status).toBe("ACKNOWLEDGED");

        h.status = "COMPLETED";
        const res = await runRecruitmentAlertsJob({ now: new Date(NOW.getTime() + 7200000) });
        expect(res.resolved).toBe(1);
        expect(alerts()[0]).toMatchObject({ status: "RESOLVED" });
        expect(alerts()[0].details.resolvedValue).toBe(0);

        await expect(
            asTenant(T1, () => acknowledgeRecruitmentAlert({ tenantId: T1, alertId: id })),
        ).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-ALERT-RESOLVED" });

        // A second episode the same day reopens the same row and announces again.
        failedHandoff(T1);
        const again = await runRecruitmentAlertsJob({ now: new Date(NOW.getTime() + 3 * 3600000) });
        expect(again.opened).toBe(1);
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toMatchObject({ status: "OPEN", resolvedAt: null, acknowledgedById: null });
        expect(enqueued).toHaveLength(2);
    });

    it("a metric with no data neither raises nor resolves (SLA unconfigured, no fills, no final offers)", async () => {
        settings(T1, { slaBreaches: 0, timeToFillDays: 10, offerDeclineRatePct: 10 });
        const res = await runRecruitmentAlertsJob({ now: NOW });
        expect(res).toMatchObject({ evaluated: 3, notMeasurable: 3, opened: 0, unchanged: 3 });
        expect(alerts()).toHaveLength(0);
    });

    it("measures time to fill, offer decline rate and SLA breaches canonically", async () => {
        process.env.HR_RECRUITMENT_STAGE_SLA_DAYS = JSON.stringify({ screening: 5 });
        settings(T1, { timeToFillDays: 20, offerDeclineRatePct: 40, slaBreaches: 0 });
        fake.seed("jobRequisition", {
            tenantId: T1,
            openings: 1,
            transitions: [{ fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", createdAt: daysAgo(40) }],
            offers: [{ status: "ACCEPTED", respondedAt: daysAgo(10) }],
        });
        fake.seed("offer", { tenantId: T1, status: "DECLINED", respondedAt: daysAgo(3) });
        fake.seed("offer", { tenantId: T1, status: "ACCEPTED", respondedAt: daysAgo(10) });
        fake.seed("application", { tenantId: T1, stage: "screening", appliedAt: daysAgo(9), stageHistory: [] });
        fake.seed("application", { tenantId: T1, stage: "screening", appliedAt: daysAgo(1), stageHistory: [] });

        const res = await runRecruitmentAlertsJob({ now: NOW });
        expect(res).toMatchObject({ evaluated: 3, opened: 3, events: 3 });
        const byMetric = Object.fromEntries(alerts().map((a) => [a.metric, a]));
        expect(byMetric.TIME_TO_FILL.value).toBe(30);
        expect(byMetric.OFFER_DECLINE_RATE.value).toBe(50);
        expect(byMetric.SLA_BREACHES.value).toBe(1);
        expect(byMetric.SLA_BREACHES.details.openApplications).toBe(2);
    });

    it("isolates a failing tenant and keeps going", async () => {
        settings(T1, { failedHandoffs: 0 });
        settings(T2, { failedHandoffs: 0 });
        failedHandoff(T2);
        const original = fake.db.offerHandoff.findMany;
        fake.db.offerHandoff.findMany = (args) => {
            if (mcpCtx.getStore()?.user?.tenantId === T1) throw new Error("boom");
            return original(args);
        };
        const res = await runRecruitmentAlertsJob({ now: NOW });
        expect(res.errors).toBe(1);
        expect(res.opened).toBe(1);
        expect(alerts().map((a) => a.tenantId)).toEqual([T2]);
    });

    it("routes to the recruiting lead when no recipient is set, else to nobody", async () => {
        settings(T1, { failedHandoffs: 0 });
        failedHandoff(T1);
        fake.seed("employee", { tenant_id: T1, job_title: "Recruiter", status: "active" });
        fake.seed("employee", { tenant_id: T1, job_title: "Head of Talent Acquisition", status: "inactive" });
        const lead = fake.seed("employee", { tenant_id: T1, job_title: "Recruitment Lead", status: "active" });
        fake.seed("employee", { tenant_id: T2, job_title: "Recruiting Manager", status: "active" });
        await runRecruitmentAlertsJob({ now: NOW });
        expect(enqueued[0].payload.recipientId).toBe(String(lead.id));

        settings(T2, { failedHandoffs: 0 });
        fake.all("employee").splice(0);
        failedHandoff(T2);
        await runRecruitmentAlertsJob({ now: NOW });
        const t2Event = enqueued.find((e) => e.tenantId === T2);
        expect(t2Event.payload.recipientId).toBeNull();
    });

    it("skips tenants whose thresholds watch nothing", async () => {
        settings(T1, null);
        settings(T2, { unknownKey: 3 });
        const res = await runRecruitmentAlertsJob({ now: NOW });
        expect(res.tenants).toBe(0);
    });
});

describe("thresholds", () => {
    it("reads empty thresholds for a tenant that never saved", async () => {
        const res = await asTenant(T1, () => getAlertThresholds({ tenantId: T1 }));
        expect(res).toMatchObject({ thresholds: {}, alertRecipientId: null, version: 0, periodDays: 30 });
    });

    it("validates, merges and version-checks", async () => {
        settings(T1, { failedHandoffs: 2 }, { version: 4 });
        fake.seed("employee", { id: 9, tenant_id: T1, status: "active" });
        fake.seed("employee", { id: 10, tenant_id: T2, status: "active" });

        await expect(
            asTenant(T1, () => setAlertThresholds({ tenantId: T1, expectedVersion: 3, thresholds: { slaBreaches: 1 } })),
        ).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT" });
        await expect(
            asTenant(T1, () => setAlertThresholds({ tenantId: T1, expectedVersion: 4, thresholds: { offerDeclineRatePct: 140 } })),
        ).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-ALERTS-INVALID" });
        await expect(
            asTenant(T1, () => setAlertThresholds({ tenantId: T1, expectedVersion: 4, thresholds: { bogus: 1 } })),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            asTenant(T1, () => setAlertThresholds({ tenantId: T1, expectedVersion: 4, alertRecipientId: 10 })),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-ALERTS-RECIPIENT-INVALID" });

        const saved = await asTenant(T1, () =>
            setAlertThresholds({ tenantId: T1, actorId: 7, expectedVersion: 4, thresholds: { slaBreaches: 3, failedHandoffs: null }, alertRecipientId: 9 }),
        );
        expect(saved).toMatchObject({ thresholds: { slaBreaches: 3 }, alertRecipientId: 9, version: 5 });
        expect(fake.all("tenantRecruitmentSettings")[0]).toMatchObject({ updatedById: 7, alertThresholds: { slaBreaches: 3 } });
    });

    it("creates the settings row at version 1 when the tenant had none", async () => {
        const saved = await asTenant(T1, () => setAlertThresholds({ tenantId: T1, expectedVersion: 0, thresholds: { timeToFillDays: 45 } }));
        expect(saved).toMatchObject({ thresholds: { timeToFillDays: 45 }, version: 1 });
    });
});

describe("list and acknowledge", () => {
    it("lists by status and metric, tenant-scoped", async () => {
        fake.seed("recruitmentAlert", { tenantId: T1, metric: "FAILED_HANDOFFS", status: "OPEN", periodStart: daysAgo(30), value: "2.0000", threshold: "1.0000", lastSeenAt: NOW });
        fake.seed("recruitmentAlert", { tenantId: T1, metric: "TIME_TO_FILL", status: "RESOLVED", periodStart: daysAgo(31), value: "40", threshold: "30", lastSeenAt: daysAgo(1) });
        fake.seed("recruitmentAlert", { tenantId: T2, metric: "FAILED_HANDOFFS", status: "OPEN", periodStart: daysAgo(30), value: "9", threshold: "1", lastSeenAt: NOW });
        const open = await asTenant(T1, () => listRecruitmentAlerts({ tenantId: T1, status: "open" }));
        expect(open.alerts).toHaveLength(1);
        expect(open.alerts[0]).toMatchObject({ metric: "FAILED_HANDOFFS", value: 2, threshold: 1 });
        const all = await asTenant(T1, () => listRecruitmentAlerts({ tenantId: T1 }));
        expect(all.count).toBe(2);
        await expect(asTenant(T1, () => listRecruitmentAlerts({ tenantId: T1, metric: "NOPE" }))).rejects.toMatchObject({ status: 400 });
    });

    it("acknowledge is idempotent and never crosses tenants", async () => {
        const row = fake.seed("recruitmentAlert", { tenantId: T1, metric: "FAILED_HANDOFFS", status: "OPEN", periodStart: daysAgo(30), value: 2, threshold: 1 });
        const first = await asTenant(T1, () => acknowledgeRecruitmentAlert({ tenantId: T1, alertId: row.id, actorId: 3, now: NOW }));
        const second = await asTenant(T1, () => acknowledgeRecruitmentAlert({ tenantId: T1, alertId: row.id, actorId: 4, now: NOW }));
        expect(first.status).toBe("ACKNOWLEDGED");
        expect(second.acknowledgedById).toBe(3);
        await expect(
            asTenant(T2, () => acknowledgeRecruitmentAlert({ tenantId: T2, alertId: row.id })),
        ).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-ALERT-NOT-FOUND" });
    });
});

describe("event builder", () => {
    it("carries ids and figures only", () => {
        const ev = recruitmentAnalyticsAlertRaisedEvent(
            { id: 4, tenantId: T1, metric: "TIME_TO_FILL", periodStart: new Date("2026-09-20T00:00:00Z"), value: "41.5000", threshold: "30" },
            {},
            { recipientId: 12 },
        );
        expect(ev.payload).toEqual({
            alertId: "4", metric: "TIME_TO_FILL", periodStart: "2026-09-20T00:00:00.000Z", value: 41.5, threshold: 30, recipientId: "12",
        });
        expect(recruitmentAnalyticsAlertRaisedEvent({ id: 1 })).toBeNull();
    });
});
