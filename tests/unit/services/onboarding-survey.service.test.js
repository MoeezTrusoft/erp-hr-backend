// Recruitment Phase 4 (stream M) — the 30/60/90 survey job and completion:
// issue on the trigger day (once per checklist and type, within the grace
// window), never for an employee who has left, issue in place a row nobody
// issued, a concurrent duplicate, the one reminder two days before due, the
// flag, the tenant scope of every query, and completion per cohort.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const svc = await import("../../../src/services/onboarding-survey.service.js");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T02:00:00.000Z");
const DAY = 24 * 3600_000;
const date = (s) => new Date(`${s}T00:00:00.000Z`);
const named = (name) => recorder.events.filter((e) => e.eventName === `hr.onboarding.${name}.v1`);
const surveys = () => db.state.tables.onboardingSurvey ?? [];
const surveyOf = (checklistId, type) => surveys().find((s) => s.checklistId === checklistId && s.type === type);

function seed() {
    db.state.tables = {};
    db.state.ops.length = 0;
    recorder.events.length = 0;
    const t = db.state.tables;
    const active = { status: "active", employement_status: "active", separatedAt: null };
    t.employee = [
        { id: 3, tenant_id: A, ...active },
        { id: 4, tenant_id: A, status: "Separated", employement_status: "Separated", separatedAt: date("2026-10-10") },
        { id: 5, tenant_id: A, ...active },
        { id: 6, tenant_id: A, ...active },
        { id: 7, tenant_id: B, ...active },
        { id: 8, tenant_id: A, ...active },
    ];
    t.onboardingChecklist = [
        // DAY_30 on 15 Oct: due.
        { id: 300, tenantId: A, employeeId: 3, startDate: date("2026-09-15"), status: "IN_PROGRESS" },
        // Has left: nothing issued.
        { id: 301, tenantId: A, employeeId: 4, startDate: date("2026-09-10"), status: "COMPLETED" },
        // DAY_30 and DAY_60 are past the grace window; DAY_90 (18 Oct) is due.
        { id: 302, tenantId: A, employeeId: 5, startDate: date("2026-07-20"), status: "COMPLETED" },
        // DAY_30 already answered through the portal.
        { id: 303, tenantId: A, employeeId: 6, startDate: date("2026-09-01"), status: "COMPLETED" },
        // Tenant B: a row nobody issued yet is issued in place.
        { id: 304, tenantId: B, employeeId: 7, startDate: date("2026-09-19"), status: "IN_PROGRESS" },
        // DAY_30 issued on 15 Oct, due 22 Oct: inside the reminder window now.
        { id: 305, tenantId: A, employeeId: 8, startDate: date("2026-09-15"), status: "IN_PROGRESS" },
        // Starts later: nothing yet.
        { id: 306, tenantId: A, employeeId: 3, startDate: date("2026-10-01"), status: "IN_PROGRESS" },
    ];
    t.onboardingSurvey = [
        { id: 900, tenantId: A, checklistId: 303, employeeId: 6, type: "DAY_30", issuedAt: null, dueAt: null, remindedAt: null, submittedAt: date("2026-10-02"), responses: { ratings: {} } },
        { id: 901, tenantId: B, checklistId: 304, employeeId: 7, type: "DAY_30", issuedAt: null, dueAt: null, remindedAt: null, submittedAt: null },
        {
            id: 902, tenantId: A, checklistId: 305, employeeId: 8, type: "DAY_30",
            issuedAt: new Date("2026-10-15T02:00:00Z"), dueAt: new Date("2026-10-22T02:00:00Z"), remindedAt: null, submittedAt: null,
        },
    ];
}

beforeEach(() => {
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    seed();
});

describe("runOnboardingSurveyJob", () => {
    it("is off with the flag", async () => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(await svc.runOnboardingSurveyJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.state.ops).toHaveLength(0);
    });

    it("issues what is due, skips leavers and the late, reminds once", async () => {
        const summary = await svc.runOnboardingSurveyJob({ now: NOW });
        expect(summary).toMatchObject({ issued: 3, reminded: 1, skippedLeft: 1, stale: 2, duplicate: 0, failed: 0 });

        expect(surveyOf(300, "DAY_30")).toMatchObject({ tenantId: A, employeeId: 3, issuedAt: NOW, dueAt: new Date(NOW.getTime() + 7 * DAY) });
        expect(surveyOf(301, "DAY_30")).toBeUndefined();
        expect(surveyOf(302, "DAY_30")).toBeUndefined();
        expect(surveyOf(302, "DAY_60")).toBeUndefined();
        expect(surveyOf(302, "DAY_90")).toMatchObject({ issuedAt: NOW });
        expect(surveyOf(303, "DAY_30").issuedAt).toBeNull();
        expect(surveyOf(304, "DAY_30")).toMatchObject({ id: 901, issuedAt: NOW });
        expect(surveyOf(305, "DAY_30").remindedAt).toEqual(NOW);
        expect(surveyOf(306, "DAY_30")).toBeUndefined();

        const issued = named("survey_issued");
        // Oldest start first.
        expect(issued.map((e) => [e.tenantId, e.payload.checklistId, e.payload.surveyType])).toEqual([
            [A, "302", "DAY_90"],
            [A, "300", "DAY_30"],
            [B, "304", "DAY_30"],
        ]);
        expect(issued[1]).toMatchObject({
            aggregateType: "OnboardingSurvey",
            payload: {
                employeeId: "3", recipientId: "3", issuedAt: NOW.toISOString(), dueAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
            },
        });
        const [reminder] = named("survey_reminder");
        expect(reminder).toMatchObject({ tenantId: A, aggregateId: 902, payload: { surveyId: "902", recipientId: "8", remindedAt: NOW.toISOString() } });
        expect(JSON.stringify(recorder.events)).not.toContain("ratings");
    });

    it("is idempotent: a second pass issues and reminds nothing", async () => {
        await svc.runOnboardingSurveyJob({ now: NOW });
        const count = surveys().length;
        const again = await svc.runOnboardingSurveyJob({ now: new Date(NOW.getTime() + 3600_000) });
        expect(again).toMatchObject({ issued: 0, reminded: 0 });
        expect(surveys()).toHaveLength(count);
        expect(named("survey_issued")).toHaveLength(3);
        expect(named("survey_reminder")).toHaveLength(1);
    });

    it("a survey created by a concurrent pass is a duplicate, not a second row", async () => {
        const original = db.onboardingSurvey;
        db.onboardingSurvey = {
            ...original,
            create: () => Promise.reject(Object.assign(new Error("Unique constraint failed"), { code: "P2002" })),
        };
        try {
            const summary = await svc.runOnboardingSurveyJob({ now: NOW });
            expect(summary).toMatchObject({ issued: 1, duplicate: 2, failed: 0 });
        } finally {
            db.onboardingSurvey = original;
        }
    });

    it("never reminds an employee who has left since the survey was issued", async () => {
        db.state.tables.employee.find((e) => e.id === 8).status = "Separated";
        const summary = await svc.runOnboardingSurveyJob({ now: NOW });
        expect(summary.reminded).toBe(0);
        expect(surveyOf(305, "DAY_30").remindedAt).toBeNull();
    });

    it("scans as SYSTEM and writes under each row's tenant", async () => {
        await svc.runOnboardingSurveyJob({ now: NOW });
        const writes = db.state.ops.filter((o) => ["create", "updateMany"].includes(o.op));
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((o) => (o.tenant === A || o.tenant === B) && o.tx)).toBe(true);
        expect(db.state.ops.filter((o) => o.tenant === "SYSTEM").every((o) => o.op === "findMany")).toBe(true);
    });
});

describe("getOnboardingSurveyCompletion", () => {
    const asA = (fn) => mcpCtx.run({ user: { tenantId: A } }, async () => await fn());

    it("reports per type per cohort month for the tenant only", async () => {
        await svc.runOnboardingSurveyJob({ now: NOW });
        const later = new Date(NOW.getTime() + 10 * DAY);
        const res = await asA(() => svc.getOnboardingSurveyCompletion({ tenantId: A, from: "2026-07", to: "2026-10", now: later }));
        expect(res.from).toBe("2026-07-01T00:00:00.000Z");
        expect(res.to).toBe("2026-10-31T23:59:59.999Z");
        expect(res.rows).toEqual([
            { cohortMonth: "2026-07", surveyType: "DAY_90", issued: 1, submitted: 0, overdue: 1, pending: 0, completionRate: 0 },
            { cohortMonth: "2026-09", surveyType: "DAY_30", issued: 3, submitted: 1, overdue: 2, pending: 0, completionRate: 33.3 },
        ]);
        expect(res.totals.find((t) => t.surveyType === "DAY_30")).toMatchObject({ issued: 3, submitted: 1 });
    });

    it("validates the range and the flag", async () => {
        await expect(asA(() => svc.getOnboardingSurveyCompletion({ tenantId: A, from: "2026-13-01", now: NOW }))).rejects.toMatchObject({ status: 400 });
        await expect(asA(() => svc.getOnboardingSurveyCompletion({ tenantId: A, from: "2026-10", to: "2026-07", now: NOW }))).rejects.toMatchObject({
            status: 400, code: "HR-ONBOARDING-SURVEY-RANGE-INVALID",
        });
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        await expect(asA(() => svc.getOnboardingSurveyCompletion({ tenantId: A, now: NOW }))).rejects.toMatchObject({
            status: 503, code: "HR-ONBOARDING-AUTOMATION-DISABLED",
        });
    });
});
