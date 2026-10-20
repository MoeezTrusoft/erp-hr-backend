// Recruitment Phase 4 — a manual schedule change marks the session's calendar
// invite like interviews do (create, move, delete), only with onboarding
// automation and calendar sync both on; with the flags off the create and
// update results are unchanged. A delete of a session with an invite leaves
// a hidden CANCEL tombstone for the worker; the schedule never lists it.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createOnboardingDb } from "./helpers/onboarding-sessions.fake.js";

const { db, state, addSession } = createOnboardingDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const schedule = await import("../../../src/services/onboardingSchedule.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const flagsOn = () => {
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
};
const CALENDAR_COLUMNS = ["calendarSyncStatus", "calendarSyncAction", "calendarSyncAttempts", "calendarNextAttemptAt", "calendarLastError"];

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push({ id: 30, tenant_id: TENANT, first_name: "Ayesha", last_name: "Malik", job_title: "Engineer" });
    state.checklists.push({ id: 70, tenantId: TENANT, employeeId: 30, startDate: new Date("2026-10-23T00:00:00Z") });
    jest.clearAllMocks();
});
afterEach(() => {
    delete process.env.HR_ONBOARDING_AUTOMATION;
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
});

describe("flags off: the existing writes are unchanged", () => {
    it("create and update write no calendar columns", async () => {
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true"; // calendarSync alone is not enough
        await asTenant(() => schedule.createSession({ checklistId: 70, title: "Lunch", sessionDate: "2026-10-26" }, TENANT));
        const created = db.onboardingSession.create.mock.calls[0][0].data;
        for (const col of CALENDAR_COLUMNS) expect(created).not.toHaveProperty(col);

        const s = addSession({ tenantId: TENANT, checklistId: 70, title: "X", sessionDate: new Date("2026-10-26T00:00:00Z") });
        await asTenant(() => schedule.updateSession(s.id, { fromTime: "10:00" }, TENANT));
        expect(db.onboardingSession.update.mock.calls[0][0].data).toEqual({ fromTime: "10:00" });
    });
});

describe("flags on", () => {
    beforeEach(flagsOn);

    it("a dated create is marked CREATE; an undated one is not", async () => {
        const dated = await asTenant(() => schedule.createSession({ checklistId: 70, title: "Lunch", sessionDate: "2026-10-26" }, TENANT));
        expect(dated).toMatchObject({ calendarSyncStatus: "PENDING", calendarSyncAction: "CREATE", calendarSyncAttempts: 0 });
        const undated = await asTenant(() => schedule.createSession({ checklistId: 70, title: "Later" }, TENANT));
        expect(undated.calendarSyncStatus).toBeNull();
    });

    it("a move marks UPDATE when an event exists and CREATE when not; a type-only change does not", async () => {
        const withEvent = addSession({ tenantId: TENANT, checklistId: 70, title: "A", sessionDate: new Date("2026-10-26T00:00:00Z"), calendarEventId: "evt-1", calendarSyncStatus: "SYNCED" });
        const noEvent = addSession({ tenantId: TENANT, checklistId: 70, title: "B", sessionDate: new Date("2026-10-26T00:00:00Z") });
        await expect(asTenant(() => schedule.updateSession(withEvent.id, { sessionDate: "2026-10-27" }, TENANT))).resolves.toMatchObject({ calendarSyncAction: "UPDATE", calendarSyncStatus: "PENDING" });
        await expect(asTenant(() => schedule.updateSession(noEvent.id, { location: "Room 4" }, TENANT))).resolves.toMatchObject({ calendarSyncAction: "CREATE" });
        const typeOnly = addSession({ tenantId: TENANT, checklistId: 70, title: "C", sessionDate: new Date("2026-10-26T00:00:00Z") });
        await expect(asTenant(() => schedule.updateSession(typeOnly.id, { sessionType: "training" }, TENANT))).resolves.toMatchObject({ calendarSyncStatus: null });
    });

    it("clearing the date of a session with an event queues the event's removal; with none there is nothing to do", async () => {
        const withEvent = addSession({ tenantId: TENANT, checklistId: 70, title: "A", sessionDate: new Date("2026-10-26T00:00:00Z"), calendarEventId: "evt-1" });
        await expect(asTenant(() => schedule.updateSession(withEvent.id, { sessionDate: null }, TENANT))).resolves.toMatchObject({ calendarSyncAction: "UPDATE", sessionDate: null });
        const undated = addSession({ tenantId: TENANT, checklistId: 70, title: "B" });
        await expect(asTenant(() => schedule.updateSession(undated.id, { title: "B2" }, TENANT))).resolves.toMatchObject({ calendarSyncStatus: null });
    });
});

describe("deleteSession", () => {
    it("a session without an invite is deleted at once", async () => {
        const s = addSession({ tenantId: TENANT, checklistId: 70, title: "A" });
        await expect(asTenant(() => schedule.deleteSession(s.id, TENANT))).resolves.toEqual({ id: s.id, checklistId: 70, deleted: true, calendarCancelQueued: false });
        expect(state.sessions).toEqual([]);
    });

    it("a session with an event, or a write in flight, becomes a hidden CANCEL tombstone", async () => {
        const now = new Date("2026-10-20T08:00:00Z");
        const synced = addSession({ tenantId: TENANT, checklistId: 70, title: "A", calendarEventId: "evt-1" });
        const inFlight = addSession({ tenantId: TENANT, checklistId: 70, title: "B", calendarClaimedBy: "w", calendarClaimExpiresAt: new Date(now.getTime() + 60_000) });
        const stale = addSession({ tenantId: TENANT, checklistId: 70, title: "C", calendarClaimedBy: "w", calendarClaimExpiresAt: new Date(now.getTime() - 60_000) });
        await expect(asTenant(() => schedule.deleteSession(synced.id, TENANT, { now }))).resolves.toMatchObject({ calendarCancelQueued: true });
        await expect(asTenant(() => schedule.deleteSession(inFlight.id, TENANT, { now }))).resolves.toMatchObject({ calendarCancelQueued: true });
        await expect(asTenant(() => schedule.deleteSession(stale.id, TENANT, { now }))).resolves.toMatchObject({ calendarCancelQueued: false });
        expect(state.sessions.map((s) => [s.title, s.calendarSyncAction, s.calendarSyncStatus])).toEqual([
            ["A", "CANCEL", "PENDING"],
            ["B", "CANCEL", "PENDING"],
        ]);

        // Hidden from the schedule, and gone for update and a second delete.
        const listed = await asTenant(() => schedule.listSchedule(70, TENANT));
        expect(listed).toEqual([]);
        await expect(asTenant(() => schedule.updateSession(synced.id, { title: "Z" }, TENANT))).rejects.toMatchObject({ status: 404 });
        await expect(asTenant(() => schedule.deleteSession(synced.id, TENANT))).rejects.toMatchObject({ status: 404 });
    });

    it("another tenant's session is not found", async () => {
        const s = addSession({ tenantId: OTHER, checklistId: 71, title: "A" });
        await expect(asTenant(() => schedule.deleteSession(s.id, TENANT))).rejects.toMatchObject({ status: 404 });
        await expect(asTenant(() => schedule.deleteSession("x", TENANT))).rejects.toMatchObject({ status: 400 });
        expect(state.sessions).toHaveLength(1);
    });

    it("the schedule still lists live sessions with or without a calendar state", async () => {
        addSession({ tenantId: TENANT, checklistId: 70, title: "Plain", sessionDate: new Date("2026-10-26T00:00:00Z") });
        addSession({ tenantId: TENANT, checklistId: 70, title: "Synced", sessionDate: new Date("2026-10-27T00:00:00Z"), calendarSyncAction: "CREATE", calendarSyncStatus: "SYNCED" });
        const listed = await asTenant(() => schedule.listSchedule(70, TENANT));
        expect(listed.map((s) => s.title)).toEqual(["Plain", "Synced"]);
        expect(Object.keys(listed[0]).sort()).toEqual(["assignee", "candidate", "fromTime", "id", "joiningDate", "location", "role", "sessionDate", "sessionType", "title", "toTime"]);
    });
});
