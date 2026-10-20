// Recruitment Phase 4 — the orientation sessions created on handoff: the flag,
// baseline versus template, working-day dates, idempotency on checklist +
// key, host resolution, the calendar mark, the event; and the preview.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createOnboardingDb } from "./helpers/onboarding-sessions.fake.js";
import { createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state, contextLog } = createOnboardingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));

const plan = await import("../../../src/services/onboarding-session-plan.service.js");
const { DEFAULT_ONBOARDING_SESSIONS } = await import("../../../src/lib/onboarding-sessions.util.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T08:00:00Z");
// Friday 23 October 2026: day +2 is Tuesday the 27th.
const START = new Date("2026-10-23T00:00:00Z");

const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const create = (over = {}) =>
    asTenant(() => plan.createOrientationSessionsInTx(db, { tenantId: TENANT, checklistId: 70, employeeId: 30, startDate: START, now: NOW, offerId: 90, ...over }));
const sessions = () => state.sessions.filter((s) => s.checklistId === 70);
const byKey = (key) => sessions().find((s) => s.templateKey === key);

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push(
        { id: 30, tenant_id: TENANT, first_name: "Ayesha", last_name: "Malik", managerId: null },
        { id: 7, tenant_id: TENANT, first_name: "Rabia", last_name: "Recruiter" },
        { id: 8, tenant_id: TENANT, first_name: "Hamid", last_name: "Manager" },
    );
    state.checklists.push({ id: 70, tenantId: TENANT, employeeId: 30, startDate: START });
    state.requisitions.push({ id: 21, tenantId: TENANT, recruiterId: 7, requestedById: 8 });
    state.offers.push({ id: 90, tenantId: TENANT, jobRequisitionId: 21 });
}

beforeEach(() => {
    seed();
    events.length = 0;
    contextLog.length = 0;
    jest.clearAllMocks();
    process.env.HR_ONBOARDING_AUTOMATION = "true";
});
afterEach(() => {
    delete process.env.HR_ONBOARDING_AUTOMATION;
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
});

describe("createOrientationSessionsInTx", () => {
    it("flag off: nothing is read or written", async () => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        await expect(create()).resolves.toMatchObject({ created: 0, existing: 0, skipped: "FLAG_OFF" });
        expect(state.sessions).toEqual([]);
        expect(contextLog).toEqual([]);
    });

    it("no template: the baseline, on working days, hosts resolved, one ids-only event", async () => {
        const result = await create();
        expect(result).toMatchObject({ created: DEFAULT_ONBOARDING_SESSIONS.length, existing: 0, source: "DEFAULT", templateId: null, calendarQueued: false });
        expect(sessions()).toHaveLength(DEFAULT_ONBOARDING_SESSIONS.length);

        expect(byKey("welcome-hr-orientation")).toMatchObject({
            tenantId: TENANT,
            title: "Welcome and HR orientation",
            sessionType: "orientation",
            fromTime: "09:30",
            toTime: "11:00",
            required: true,
            assigneeId: 7, // the requisition's recruiter
            calendarSyncStatus: null,
        });
        expect(byKey("welcome-hr-orientation").sessionDate.toISOString()).toBe("2026-10-23T00:00:00.000Z");
        // Code of conduct is +2 working days from a Friday: Tuesday.
        expect(byKey("code-of-conduct").sessionDate.toISOString()).toBe("2026-10-27T00:00:00.000Z");
        // No Employee.managerId yet: the requisition's requester (the hiring manager).
        expect(byKey("manager-one-to-one").assigneeId).toBe(8);
        for (const s of sessions()) expect([0, 6]).not.toContain(s.sessionDate.getUTCDay());

        expect(events).toEqual([
            {
                eventName: "hr.onboarding.sessions_scheduled.v1",
                tenantId: TENANT,
                aggregateType: "OnboardingChecklist",
                aggregateId: 70,
                actorId: null,
                payload: { checklistId: "70", employeeId: "30", sessionIds: result.sessionIds.map(String), assigneeIds: ["7", "8"] },
            },
        ]);
        // Every query ran under the tenant, none escaped the context.
        expect(contextLog.every((c) => c.tenantId === TENANT)).toBe(true);
    });

    it("is idempotent: a replay creates nothing and announces nothing", async () => {
        await create();
        events.length = 0;
        const again = await create();
        expect(again).toMatchObject({ created: 0, existing: DEFAULT_ONBOARDING_SESSIONS.length, sessionIds: [] });
        expect(sessions()).toHaveLength(DEFAULT_ONBOARDING_SESSIONS.length);
        expect(events).toEqual([]);
    });

    it("a replay after a partial run fills in only what is missing", async () => {
        await create();
        const gone = byKey("data-protection");
        state.sessions = state.sessions.filter((s) => s.id !== gone.id);
        events.length = 0;
        const again = await create();
        expect(again).toMatchObject({ created: 1, existing: DEFAULT_ONBOARDING_SESSIONS.length - 1 });
        expect(events[0].payload.sessionIds).toEqual([String(byKey("data-protection").id)]);
    });

    it("the tenant's default template wins; an empty list creates nothing", async () => {
        state.templates.push({
            id: 4,
            tenantId: TENANT,
            name: "Standard",
            isActive: true,
            isDefault: true,
            sessions: [{ key: "buddy-lunch", title: "Lunch with your buddy", sessionType: "meeting", dayOffset: 1, fromTime: "13:00", toTime: "14:00", location: "Cafe", required: false, assigneeType: "BUDDY" }],
        });
        state.buddies.push({ id: 1, tenantId: TENANT, checklistId: 70, buddyId: 31 });
        const result = await create();
        expect(result).toMatchObject({ created: 1, source: "TEMPLATE", templateId: 4 });
        expect(byKey("buddy-lunch")).toMatchObject({ assigneeId: 31, location: "Cafe", required: false });
        expect(byKey("buddy-lunch").sessionDate.toISOString()).toBe("2026-10-26T00:00:00.000Z");

        state.sessions = [];
        state.templates[0].sessions = [];
        await expect(create()).resolves.toMatchObject({ created: 0, existing: 0, source: "TEMPLATE" });
        expect(state.sessions).toEqual([]);
    });

    it("another tenant's default template is not this tenant's", async () => {
        state.templates.push({ id: 5, tenantId: OTHER, isActive: true, isDefault: true, sessions: [] });
        await expect(create()).resolves.toMatchObject({ source: "DEFAULT" });
    });

    it("hosts: Employee.managerId and explicit overrides win; NEW_HIRE and an unknown buddy stay empty", async () => {
        state.employees[0].managerId = 12;
        state.templates.push({
            id: 6,
            tenantId: TENANT,
            isActive: true,
            isDefault: true,
            sessions: [
                { key: "m", title: "Manager", sessionType: "meeting", dayOffset: 0, assigneeType: "MANAGER" },
                { key: "h", title: "HR", sessionType: "orientation", dayOffset: 0, assigneeType: "HR" },
                { key: "b", title: "Buddy", sessionType: "meeting", dayOffset: 0, assigneeType: "BUDDY" },
                { key: "n", title: "Self study", sessionType: "training", dayOffset: 0, assigneeType: "NEW_HIRE" },
            ],
        });
        await create({ hrOwnerId: 44 });
        expect(byKey("m").assigneeId).toBe(12);
        expect(byKey("h").assigneeId).toBe(44);
        expect(byKey("b").assigneeId).toBeNull();
        expect(byKey("n").assigneeId).toBeNull();
    });

    it("without an offer the HR host is empty rather than guessed", async () => {
        await create({ offerId: null });
        expect(byKey("welcome-hr-orientation").assigneeId).toBeNull();
        expect(byKey("manager-one-to-one").assigneeId).toBeNull();
    });

    it("calendar sync on: each new session is marked PENDING CREATE", async () => {
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
        const result = await create();
        expect(result.calendarQueued).toBe(true);
        for (const s of sessions()) {
            expect(s).toMatchObject({ calendarSyncStatus: "PENDING", calendarSyncAction: "CREATE", calendarSyncAttempts: 0 });
            expect(s.calendarNextAttemptAt).toEqual(NOW);
        }
    });

    it("refuses a call without a tenant or checklist", async () => {
        await expect(asTenant(() => plan.createOrientationSessionsInTx(db, { checklistId: 70 }))).rejects.toMatchObject({ status: 400 });
        await expect(asTenant(() => plan.createOrientationSessionsInTx(db, { tenantId: TENANT }))).rejects.toMatchObject({
            code: "HR-ONBOARDING-SESSION-CHECKLIST-REQUIRED",
        });
    });
});

describe("previewOnboardingSessionPlan", () => {
    const preview = (args) => asTenant(() => plan.previewOnboardingSessionPlan({ tenantId: TENANT, ...args }));

    it("the default plan for a start date, with weekdays; writes nothing", async () => {
        const result = await preview({ startDate: "2026-10-24" });
        expect(result).toMatchObject({ source: "DEFAULT", startDate: "2026-10-24", automationEnabled: true, calendarSyncEnabled: false });
        // A Saturday start: day one is the Monday.
        expect(result.sessions[0]).toMatchObject({ key: "welcome-hr-orientation", sessionDate: "2026-10-26", weekday: "Monday" });
        expect(state.sessions).toEqual([]);
    });

    it("a named template, including an inactive one; another tenant's is not found", async () => {
        state.templates.push({ id: 8, tenantId: TENANT, isActive: false, isDefault: false, sessions: [{ key: "x", title: "X", sessionType: "training", dayOffset: 1, assigneeType: "HR" }] });
        state.templates.push({ id: 9, tenantId: OTHER, isActive: true, isDefault: true, sessions: [] });
        const result = await preview({ startDate: "2026-10-23", templateId: 8 });
        expect(result).toMatchObject({ source: "TEMPLATE", templateId: 8, sessions: [{ key: "x", sessionDate: "2026-10-26" }] });
        await expect(preview({ startDate: "2026-10-23", templateId: 9 })).rejects.toMatchObject({ status: 404, code: "HR-ONBOARDING-TEMPLATE-NOT-FOUND" });
    });

    it("a draft list is validated; a bad one is 422 with the reason", async () => {
        const result = await preview({ startDate: "2026-10-23", sessions: [{ key: "d", title: "Draft", sessionType: "compliance", dayOffset: 3, assigneeType: "HR" }] });
        expect(result).toMatchObject({ source: "DRAFT", sessions: [{ key: "d", sessionDate: "2026-10-28", weekday: "Wednesday" }] });
        await expect(preview({ startDate: "2026-10-23", sessions: [{ key: "d", title: "", sessionType: "compliance", dayOffset: 3, assigneeType: "HR" }] })).rejects.toMatchObject({
            status: 422,
            code: "HR-ONBOARDING-TEMPLATE-INVALID",
        });
    });

    it("refuses a missing or unreadable start date", async () => {
        for (const startDate of [undefined, "", "next week", "2026-13-45"]) {
            await expect(preview({ startDate })).rejects.toMatchObject({ status: 400, code: "HR-ONBOARDING-SESSION-START-INVALID" });
        }
    });
});
