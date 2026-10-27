// Recruitment Phase 6 — manual onboarding sessions: `required` on create and
// update, and the host can be removed (null or blank clears it; a blank used
// to be stored as employee 0). A host change re-marks the calendar invite.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { z } from "zod";
import { createOnboardingDb } from "./helpers/onboarding-sessions.fake.js";

const { db, state, addSession } = createOnboardingDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const schedule = await import("../../../src/services/onboarding-schedule.service.js");
const { registerOnboardingScheduleTools } = await import("../../../src/mcp/tools/onboarding-schedule.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await fn());
const flagsOn = () => {
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
};

const tools = new Map();
registerOnboardingScheduleTools({ tool: (name, _d, schema, handler) => tools.set(name, { schema: z.object(schema), handler }) });
const HR = { userId: "1", employeeId: 5, tenantId: TENANT, isAdmin: false };
const callTool = (name, rawArgs, permissions = { "hr:onboarding": ["VIEW", "CREATE", "EDIT"] }) => {
    const { schema, handler } = tools.get(name);
    // Validate the way the MCP server does before the handler runs.
    const args = schema.parse(rawArgs);
    return mcpCtx.run({ user: HR, permissions }, () => handler(args));
};
const parse = (res) => JSON.parse(res.content[0].text);

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

describe("the tool inputs", () => {
    it("assigneeId accepts an id, null and a blank (as null); 0 and junk are refused", () => {
        const { schema } = tools.get("hr_onboarding_schedule_update");
        expect(schema.parse({ id: 1, assigneeId: "7" }).assigneeId).toBe(7);
        expect(schema.parse({ id: 1, assigneeId: null }).assigneeId).toBeNull();
        expect(schema.parse({ id: 1, assigneeId: "" }).assigneeId).toBeNull();
        expect(schema.parse({ id: 1 }).assigneeId).toBeUndefined();
        expect(() => schema.parse({ id: 1, assigneeId: 0 })).toThrow();
        expect(() => schema.parse({ id: 1, assigneeId: "x" })).toThrow();
        expect(schema.parse({ id: 1, required: true }).required).toBe(true);
        expect(() => schema.parse({ id: 1, required: "yes" })).toThrow();
    });

    it("create stores required and no host for a blank; update clears the host and sets required", async () => {
        const created = parse(await callTool("hr_onboarding_schedule_create", { checklistId: 70, title: "Policy walkthrough", assigneeId: "", required: true }));
        expect(created).toMatchObject({ assigneeId: null, required: true });

        const s = addSession({ tenantId: TENANT, checklistId: 70, title: "Lunch", assigneeId: 30 });
        const cleared = parse(await callTool("hr_onboarding_schedule_update", { id: s.id, assigneeId: null }));
        expect(cleared).toMatchObject({ id: s.id, assigneeId: null });
        const blank = addSession({ tenantId: TENANT, checklistId: 70, title: "Tour", assigneeId: 30 });
        expect(parse(await callTool("hr_onboarding_schedule_update", { id: blank.id, assigneeId: "  " }))).toMatchObject({ assigneeId: null });
        expect(parse(await callTool("hr_onboarding_schedule_update", { id: s.id, required: true }))).toMatchObject({ required: true, assigneeId: null });
        // Omitting both keeps them.
        expect(parse(await callTool("hr_onboarding_schedule_update", { id: s.id, title: "Team lunch" }))).toMatchObject({ required: true, assigneeId: null, title: "Team lunch" });
    });

    it("the gates are unchanged", async () => {
        const denied = parse(await callTool("hr_onboarding_schedule_update", { id: 1, assigneeId: null }, { "hr:onboarding": ["VIEW"] }));
        expect(denied.status).toBe(403);
    });
});

describe("the service", () => {
    it("create without required leaves the column default; with it, stores a strict boolean", async () => {
        await asTenant(() => schedule.createSession({ checklistId: 70, title: "A" }, TENANT));
        expect(db.onboardingSession.create.mock.calls[0][0].data).not.toHaveProperty("required");
        await asTenant(() => schedule.createSession({ checklistId: 70, title: "B", required: false }, TENANT));
        expect(db.onboardingSession.create.mock.calls[1][0].data.required).toBe(false);
    });

    it("a direct call refuses a non-positive host instead of storing 0", async () => {
        await expect(asTenant(() => schedule.createSession({ checklistId: 70, title: "A", assigneeId: 0 }, TENANT))).rejects.toMatchObject({ status: 400 });
        const s = addSession({ tenantId: TENANT, checklistId: 70, title: "X", assigneeId: 30 });
        await expect(asTenant(() => schedule.updateSession(s.id, { assigneeId: -3 }, TENANT))).rejects.toMatchObject({ status: 400 });
        await expect(asTenant(() => schedule.updateSession(s.id, { assigneeId: "" }, TENANT))).resolves.toMatchObject({ assigneeId: null });
    });

    it("flags off: clearing the host or setting required writes no calendar columns", async () => {
        const s = addSession({ tenantId: TENANT, checklistId: 70, title: "X", sessionDate: new Date("2026-10-26T00:00:00Z"), assigneeId: 30, calendarEventId: "evt-1" });
        await asTenant(() => schedule.updateSession(s.id, { assigneeId: null, required: true }, TENANT));
        expect(db.onboardingSession.update.mock.calls[0][0].data).toEqual({ assigneeId: null, required: true });
    });

    describe("flags on", () => {
        beforeEach(flagsOn);

        it("removing or changing the host re-syncs the invite (UPDATE with an event, CREATE without)", async () => {
            const withEvent = addSession({ tenantId: TENANT, checklistId: 70, title: "A", sessionDate: new Date("2026-10-26T00:00:00Z"), assigneeId: 30, calendarEventId: "evt-1", calendarSyncStatus: "SYNCED" });
            await expect(asTenant(() => schedule.updateSession(withEvent.id, { assigneeId: null }, TENANT))).resolves.toMatchObject({ assigneeId: null, calendarSyncAction: "UPDATE", calendarSyncStatus: "PENDING" });
            const noEvent = addSession({ tenantId: TENANT, checklistId: 70, title: "B", sessionDate: new Date("2026-10-26T00:00:00Z") });
            await expect(asTenant(() => schedule.updateSession(noEvent.id, { assigneeId: 31 }, TENANT))).resolves.toMatchObject({ assigneeId: 31, calendarSyncAction: "CREATE", calendarSyncStatus: "PENDING" });
        });

        it("changing required re-syncs a dated session; an undated one without an event has nothing to tell", async () => {
            const dated = addSession({ tenantId: TENANT, checklistId: 70, title: "A", sessionDate: new Date("2026-10-26T00:00:00Z"), calendarEventId: "evt-2", calendarSyncStatus: "SYNCED" });
            await expect(asTenant(() => schedule.updateSession(dated.id, { required: true }, TENANT))).resolves.toMatchObject({ required: true, calendarSyncAction: "UPDATE", calendarSyncStatus: "PENDING" });
            const undated = addSession({ tenantId: TENANT, checklistId: 70, title: "B" });
            await expect(asTenant(() => schedule.updateSession(undated.id, { required: true, assigneeId: null }, TENANT))).resolves.toMatchObject({ required: true, calendarSyncStatus: null });
        });

        it("a dated create with required and no host is marked CREATE", async () => {
            await expect(asTenant(() => schedule.createSession({ checklistId: 70, title: "Compliance", sessionDate: "2026-10-27", required: true, assigneeId: null }, TENANT)))
                .resolves.toMatchObject({ required: true, assigneeId: null, calendarSyncAction: "CREATE" });
        });
    });
});
