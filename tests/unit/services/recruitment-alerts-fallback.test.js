// Recruitment Phase 6 — an alert with no configured recipient and no
// recruiting lead goes to the HR role (notifyRole "HR"), said so on the event
// payload and on the alert's details; a resolved person keeps the old shape.
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

const { runRecruitmentAlertsJob, recruitmentAnalyticsAlertRaisedEvent, ALERT_FALLBACK_ROLE } = await import(
    "../../../src/services/recruitment-alerts.service.js"
);

const T1 = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const previous = process.env.HR_RECRUITMENT_ANALYTICS_ALERTS;

beforeEach(() => {
    fake = makeAlertsDb();
    enqueued.length = 0;
    process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = "true";
});
afterEach(() => {
    if (previous === undefined) delete process.env.HR_RECRUITMENT_ANALYTICS_ALERTS;
    else process.env.HR_RECRUITMENT_ANALYTICS_ALERTS = previous;
});

const breach = (extra = {}) => {
    fake.seed("tenantRecruitmentSettings", { tenantId: T1, alertThresholds: { failedHandoffs: 0 }, alertRecipientId: null, version: 1, ...extra });
    fake.seed("offerHandoff", { tenantId: T1, status: "FAILED", updated_at: daysAgo(2) });
};

describe("alert recipient fallback", () => {
    it("routes to the HR role when nobody is configured and no lead is found", async () => {
        expect(ALERT_FALLBACK_ROLE).toBe("HR");
        breach();
        await runRecruitmentAlertsJob({ now: NOW });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].payload).toMatchObject({ recipientId: null, notifyRole: "HR" });
        expect(fake.all("recruitmentAlert")[0].details).toMatchObject({ recipientId: null, notifyRole: "HR" });
    });

    it("keeps the HR-role routing on later runs of the same episode", async () => {
        breach();
        await runRecruitmentAlertsJob({ now: NOW });
        await runRecruitmentAlertsJob({ now: new Date(NOW.getTime() + 3600000) });
        expect(enqueued).toHaveLength(1);
        expect(fake.all("recruitmentAlert")[0].details).toMatchObject({ recipientId: null, notifyRole: "HR" });
    });

    it("leaves notifyRole off when a person receives it", async () => {
        const lead = fake.seed("employee", { tenant_id: T1, job_title: "Recruitment Lead", status: "active" });
        breach();
        await runRecruitmentAlertsJob({ now: NOW });
        expect(enqueued[0].payload.recipientId).toBe(String(lead.id));
        expect(enqueued[0].payload).not.toHaveProperty("notifyRole");
        expect(fake.all("recruitmentAlert")[0].details).not.toHaveProperty("notifyRole");
    });

    it("the builder says so for a missing recipient", () => {
        const alert = { id: 4, tenantId: T1, metric: "TIME_TO_FILL", periodStart: NOW, value: "41", threshold: "30" };
        expect(recruitmentAnalyticsAlertRaisedEvent(alert, {}, {}).payload).toMatchObject({ recipientId: null, notifyRole: "HR" });
        expect(recruitmentAnalyticsAlertRaisedEvent(alert, {}, { recipientId: 12 }).payload).not.toHaveProperty("notifyRole");
    });
});
