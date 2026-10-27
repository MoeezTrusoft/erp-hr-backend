// tests/unit/services/recruitment-alerts-names.test.js
//
// Recruitment Phase 7 (D10) — alert reads name people: recipientName next to
// the recipient employee id, acknowledgedByName next to acknowledgedById, and
// alertRecipientName on the thresholds read. The HR-role fallback recipient
// stays a role label (notifyRole "HR", no name). Names come from one query per
// read, under the caller's tenant: another tenant's employee reads as null.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import { makeAlertsDb } from "./helpers/recruitment-alerts.fake.js";

let fake = makeAlertsDb();
const prismaProxy = new Proxy({}, { get: (_t, key) => fake.db[key] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => null) }));

const { listRecruitmentAlerts, acknowledgeRecruitmentAlert, getAlertThresholds, setAlertThresholds } = await import(
    "../../../src/services/recruitment-alerts.service.js"
);
const { mcpCtx } = await import("../../../src/mcp/context.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const asT1 = (fn) => mcpCtx.run({ user: { tenantId: T1 } }, fn);

const employeeLookups = () => fake.state.ops.filter((o) => o.model === "employee" && o.op === "findMany");

beforeEach(() => {
    fake = makeAlertsDb();
    fake.seed("employee", { id: 7, tenant_id: T1, first_name: "Sara", last_name: "Malik", employee_name: null, email: "sara@example.com", status: "active" });
    fake.seed("employee", { id: 8, tenant_id: T1, first_name: "", last_name: "", employee_name: "Bilal Ahmed", status: "active" });
    fake.seed("employee", { id: 9, tenant_id: T2, first_name: "Other", last_name: "Tenant", status: "active" });
    fake.seed("recruitmentAlert", {
        tenantId: T1, metric: "TIME_TO_FILL", status: "ACKNOWLEDGED", periodStart: new Date("2026-10-01T00:00:00Z"),
        value: 40, threshold: 30, details: { requisitionsFilled: 2, recipientId: 7 }, acknowledgedById: 8,
        lastSeenAt: new Date("2026-10-20T00:00:00Z"),
    });
    fake.seed("recruitmentAlert", {
        tenantId: T1, metric: "FAILED_HANDOFFS", status: "OPEN", periodStart: new Date("2026-10-01T00:00:00Z"),
        value: 1, threshold: 0, details: { failed: 1, recipientId: null, notifyRole: "HR" },
        lastSeenAt: new Date("2026-10-19T00:00:00Z"),
    });
    fake.seed("recruitmentAlert", {
        tenantId: T1, metric: "SLA_BREACHES", status: "OPEN", periodStart: new Date("2026-10-01T00:00:00Z"),
        value: 3, threshold: 1, details: { breached: 3, recipientId: 9 }, // an id from another tenant
        lastSeenAt: new Date("2026-10-18T00:00:00Z"),
    });
});

describe("alert list names", () => {
    it("names the recipient and the acknowledger, keeps the ids, one lookup under the tenant", async () => {
        const { alerts } = await asT1(async () => await listRecruitmentAlerts({ tenantId: T1 }));
        const [ttf, handoffs, sla] = alerts;

        expect(ttf).toMatchObject({
            metric: "TIME_TO_FILL",
            recipientId: 7, recipientName: "Sara Malik", notifyRole: null,
            acknowledgedById: 8, acknowledgedByName: "Bilal Ahmed",
            details: { requisitionsFilled: 2, recipientId: 7 },
        });
        // The HR-role fallback is a role label, not a person.
        expect(handoffs).toMatchObject({ recipientId: null, recipientName: null, notifyRole: "HR", acknowledgedByName: null });
        // Another tenant's employee does not resolve.
        expect(sla).toMatchObject({ recipientId: 9, recipientName: null });

        expect(employeeLookups()).toHaveLength(1);
        expect(employeeLookups()[0].tenant).toBe(T1);
        expect(JSON.stringify(alerts)).not.toContain("sara@example.com");
    });

    it("acknowledge answers with the names too", async () => {
        const open = fake.all("recruitmentAlert").find((a) => a.metric === "SLA_BREACHES");
        open.details = { breached: 3, recipientId: 7 };
        const alert = await asT1(async () => await acknowledgeRecruitmentAlert({ tenantId: T1, alertId: open.id, actorId: 8 }));
        expect(alert).toMatchObject({ status: "ACKNOWLEDGED", recipientName: "Sara Malik", acknowledgedById: 8, acknowledgedByName: "Bilal Ahmed" });
    });
});

describe("thresholds names", () => {
    it("the read carries alertRecipientName next to alertRecipientId", async () => {
        fake.seed("tenantRecruitmentSettings", { tenantId: T1, alertThresholds: { slaBreaches: 1 }, alertRecipientId: 7, version: 3 });
        const out = await asT1(async () => await getAlertThresholds({ tenantId: T1 }));
        expect(out).toMatchObject({ alertRecipientId: 7, alertRecipientName: "Sara Malik", version: 3 });
    });

    it("no recipient reads as null without a lookup", async () => {
        const out = await asT1(async () => await getAlertThresholds({ tenantId: T1 }));
        expect(out).toMatchObject({ alertRecipientId: null, alertRecipientName: null });
        expect(employeeLookups()).toHaveLength(0);
    });

    it("the save answers with the new recipient's name", async () => {
        const out = await asT1(async () =>
            await setAlertThresholds({ tenantId: T1, expectedVersion: 0, thresholds: { slaBreaches: 2 }, alertRecipientId: 8 }),
        );
        expect(out).toMatchObject({ alertRecipientId: 8, alertRecipientName: "Bilal Ahmed", version: 1 });
    });
});
