// Recruitment Phase 3a — candidate self-scheduling: propose (preview and
// save), send (flag, contact gate, re-validation, one live offer per
// application, token handling), the public read and confirm (uniform
// not-found, slot gone, the confirm race), cancel, list and the expiry job.
import { createHash } from "node:crypto";
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const axiosMock = { request: jest.fn(), create: jest.fn(() => axiosMock) };
const assertCommunicationsAllowed = jest.fn();
const sendCandidateEmail = jest.fn();
const transitionApplicationStageInTransaction = jest.fn(async () => ({}));
const SETTINGS = {
    slotOfferValidityHours: 72,
    workdayStart: "09:00",
    workdayEnd: "18:00",
    timeZone: "Asia/Karachi",
    portalBaseUrl: "https://careers.acme.test/",
    companyName: "Acme",
};
const getRecruitmentSettings = jest.fn(async () => ({ ...SETTINGS }));

jest.unstable_mockModule("axios", () => ({ default: axiosMock }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStageInTransaction, transitionApplicationStage: jest.fn() }));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({ upsertInterviewScorecard: jest.fn(), default: jest.fn() }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({
    getRecruitmentSettings,
    RECRUITMENT_SETTINGS_DEFAULTS: { timeZone: "Asia/Karachi" },
}));

const svc = await import("../../../src/services/interview-slot-offer.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-19T03:00:00.000Z"); // Monday 08:00 in Karachi
const HOUR = 3_600_000;
const ORG = { level: "ORG", unrestricted: true, employeeId: 1, canSeeInternalNotes: true };
const MANAGER = (id) => ({ level: "MANAGED", unrestricted: false, employeeId: id, canSeeInternalNotes: true });
const ASSIGNED = { level: "ASSIGNED", unrestricted: false, employeeId: 3, canSeeInternalNotes: false };

const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const asPortal = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId }, portal: true }, async () => await fn());
const offer = (id) => state.offers.find((o) => o.id === id);
const sha = (token) => createHash("sha256").update(token).digest("hex");
const tokenFromEmail = (call = sendCandidateEmail.mock.calls.at(-1)) => new URL(call[0].data.chooseUrl).searchParams.get("token");

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push(
        { id: 3, tenant_id: TENANT, first_name: "Sara", last_name: "Khan", employee_name: "Sara Khan", work_email: "sara@corp.test", email: null },
        { id: 4, tenant_id: TENANT, first_name: null, last_name: null, employee_name: "Ali Raza", work_email: "ali@corp.test", email: null },
        { id: 50, tenant_id: OTHER, first_name: "Eve", last_name: "Other", employee_name: "Eve Other", work_email: "eve@other.test", email: null },
    );
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7, approvedById: null });
    state.candidates.push({ id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Malik", email: "ayesha@example.com", anonymizedAt: null });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "screening" });
}

const proposal = (over = {}) => ({ tenantId: TENANT, applicationId: 9, interviewerIds: [3, 4], interviewType: "TECHNICAL", durationMinutes: 60, location: "https://meet.example/abc", scope: ORG, actorId: 1, now: NOW, ...over });
const propose = (over) => asTenant(() => svc.proposeSlots(proposal(over)));
const send = (over = {}) => asTenant(() => svc.sendSlotOffer({ tenantId: TENANT, scope: ORG, actorId: 1, now: NOW, ...over }));
const sendNew = (over = {}) => send({ applicationId: 9, interviewerIds: [3, 4], interviewType: "TECHNICAL", durationMinutes: 60, slots: ["2026-10-20T04:00:00Z", "2026-10-21T04:00:00Z"], ...over });

beforeEach(() => {
    seed();
    events.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_SELF_SCHEDULING = "true";
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
    assertCommunicationsAllowed.mockImplementation(async () => ({ allowed: true }));
    sendCandidateEmail.mockImplementation(async () => ({ sent: true }));
    getRecruitmentSettings.mockImplementation(async () => ({ ...SETTINGS }));
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_SELF_SCHEDULING;
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
});

// ── propose ──────────────────────────────────────────────────────────────────

describe("proposeSlots", () => {
    it("previews five slots across days without saving, and without calendar when the flag is off", async () => {
        const res = await propose();
        expect(res.saved).toBe(false);
        expect(res.calendarChecked).toBe(false);
        expect(res.slots.map((s) => s.start)).toEqual([
            "2026-10-20T04:00:00.000Z",
            "2026-10-21T04:00:00.000Z",
            "2026-10-22T04:00:00.000Z",
            "2026-10-23T04:00:00.000Z",
            "2026-10-26T04:00:00.000Z",
        ]);
        expect(state.offers).toHaveLength(0);
        expect(axiosMock.request).not.toHaveBeenCalled();
    });

    it("avoids the panel's other interviews, approved leave and off days (pending leave does not count)", async () => {
        state.interviews.push({ id: 70, tenantId: TENANT, applicationId: 9, status: "SCHEDULED", scheduledAt: new Date("2026-10-20T04:00:00Z"), durationMinutes: 90 });
        state.interviewers.push({ interviewId: 70, employeeId: 4, tenantId: TENANT });
        state.leave.push(
            { id: 1, tenantId: TENANT, employeeId: 3, status: "APPROVED", startDate: new Date("2026-10-21T00:00:00Z"), endDate: new Date("2026-10-21T00:00:00Z") },
            { id: 2, tenantId: TENANT, employeeId: 4, status: "PENDING", startDate: new Date("2026-10-22T00:00:00Z"), endDate: new Date("2026-10-22T00:00:00Z") },
        );
        const week = { monday: "09-18", tuesday: "09-18", wednesday: "09-18", thursday: "", friday: "09-18", saturday: "", sunday: "" };
        state.schedules.push(
            { id: 1, tenantId: TENANT, employeeId: 3, effective_start_date: new Date("2026-01-01"), effective_end_date: null, schedule_pattern: week },
            { id: 2, tenantId: TENANT, employeeId: 4, effective_start_date: new Date("2026-01-01"), effective_end_date: null, schedule_pattern: { ...week, thursday: "09-18" } },
        );
        const res = await propose({ count: 3 });
        expect(res.slots.map((s) => s.start)).toEqual([
            "2026-10-20T05:30:00.000Z", // Tue after the 90-minute interview
            "2026-10-23T04:00:00.000Z", // Wed leave, Thu off for Sara -> Fri
            "2026-10-26T04:00:00.000Z",
        ]);
    });

    it("uses calendar free-busy when calendarSync is on and the Communication module answers", async () => {
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
        axiosMock.request.mockImplementation(async () => ({
            data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ busy: { 3: [{ start: "2026-10-20T04:00:00Z", end: "2026-10-20T08:00:00Z" }] } }) }] } }),
        }));
        const res = await propose({ count: 3 });
        expect(res.calendarChecked).toBe(true);
        expect(res.slots[0].start).toBe("2026-10-20T08:00:00.000Z");
        expect(axiosMock.request.mock.calls[0][0].data.params.name).toBe("communication_calendar_free_busy");
    });

    it("falls back to HR data alone when free-busy is down", async () => {
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
        axiosMock.request.mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
        const res = await propose({ count: 3 });
        expect(res.calendarChecked).toBe(false);
        expect(res.slots).toHaveLength(3);
    });

    it("save stores a PROPOSED offer", async () => {
        const res = await propose({ save: true });
        expect(res).toMatchObject({ saved: true, status: "PROPOSED", applicationId: 9, requisitionId: 21, interviewerIds: [3, 4], createdById: 1 });
        expect(res).not.toHaveProperty("tokenHash");
        expect(state.offers).toHaveLength(1);
        expect(state.offers[0].slots).toHaveLength(5);
    });

    it("refuses closed stages, other scopes, foreign panelists and bad input", async () => {
        state.applications[0].stage = "hired";
        await expect(propose()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SLOT-STAGE-INVALID" });
        state.applications[0].stage = "interview";
        await expect(propose({ scope: MANAGER(8) })).rejects.toMatchObject({ status: 404 });
        await expect(propose({ scope: MANAGER(7) })).resolves.toMatchObject({ saved: false });
        await expect(propose({ scope: ASSIGNED })).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-SLOT-FORBIDDEN" });
        await expect(propose({ interviewerIds: [3, 50] })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SLOT-PANEL-INVALID" });
        await expect(propose({ interviewerIds: [] })).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-PANEL-REQUIRED" });
        await expect(propose({ interviewType: "CHAT" })).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-TYPE-INVALID" });
        await expect(propose({ durationMinutes: 5 })).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-DURATION-INVALID" });
        await expect(propose({ applicationId: 999 })).rejects.toMatchObject({ status: 404 });
    });

    it("save with no free slot refuses rather than storing an empty offer", async () => {
        state.leave.push({ id: 3, tenantId: TENANT, employeeId: 3, status: "APPROVED", startDate: new Date("2026-10-19T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") });
        await expect(propose({ save: true })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SLOT-NONE-FOUND" });
        expect(state.offers).toHaveLength(0);
    });
});

// ── send ─────────────────────────────────────────────────────────────────────

describe("sendSlotOffer", () => {
    it("is refused with a -DISABLED 503 when selfScheduling is off", async () => {
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "false";
        await expect(sendNew()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-SELF-SCHEDULING-DISABLED" });
    });

    it("sends a saved proposal: SENT, hashed token, expiry, email link, ids-only event", async () => {
        const saved = await propose({ save: true });
        const res = await send({ slotOfferId: saved.id });

        const row = offer(saved.id);
        expect(row.status).toBe("SENT");
        expect(row.sentAt).toEqual(NOW);
        expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 72 * HOUR));
        expect(row.version).toBe(2);
        const token = tokenFromEmail();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(row.tokenHash).toBe(sha(token));
        expect(JSON.stringify(res)).not.toContain(token);
        expect(res).not.toHaveProperty("tokenHash");
        expect(res).toMatchObject({ status: "SENT", emailed: true });

        const mail = sendCandidateEmail.mock.calls[0][0];
        expect(mail).toMatchObject({ tenantId: TENANT, email: "ayesha@example.com", templateId: "hr.recruitment.interview_slot_offer", category: "INTERVIEW" });
        expect(mail.data.chooseUrl).toBe(`https://careers.acme.test/interviews/choose?token=${token}`);
        expect(mail.dedupeKey).toBe(`hr-interview-slot-offer:${saved.id}:2`);

        const offered = events.find((e) => e.eventName === "hr.recruitment.interview_slots_offered.v1");
        expect(offered.payload).toEqual({
            slotOfferId: String(saved.id),
            applicationId: "9",
            requisitionId: "21",
            candidateId: "5",
            slotCount: 5,
            expiresAt: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
            interviewerIds: ["3", "4"],
        });
        expect(JSON.stringify(events)).not.toMatch(/ayesha|token/i);
        expect(db.$queryRaw).toHaveBeenCalled();
    });

    it("lets the recruiter trim the proposed set at send", async () => {
        const saved = await propose({ save: true });
        await send({ slotOfferId: saved.id, slots: ["2026-10-22T04:00:00Z"] });
        expect(offer(saved.id).slots).toEqual([{ start: "2026-10-22T04:00:00.000Z", end: "2026-10-22T05:00:00.000Z" }]);
    });

    it("refuses a do-not-contact candidate without echoing the address, and writes nothing", async () => {
        assertCommunicationsAllowed.mockRejectedValue(Object.assign(new Error("This candidate is on the do-not-contact register (REQUESTED)"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        const err = await sendNew().catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-CANDIDATE-DNC" });
        expect(err.message).not.toContain("ayesha");
        expect(state.offers).toHaveLength(0);
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("keeps one live offer per application: a new send supersedes the old one", async () => {
        await sendNew();
        const firstToken = tokenFromEmail();
        const first = state.offers[0];
        await sendNew({ slots: ["2026-10-22T04:00:00Z"] });

        expect(first.status).toBe("CANCELLED");
        expect(first.cancelReason).toBe("SUPERSEDED");
        expect(first.tokenHash).toBeNull();
        expect(state.offers.filter((o) => o.status === "SENT")).toHaveLength(1);
        expect(events.filter((e) => e.eventName === "hr.recruitment.interview_slot_offer_cancelled.v1").map((e) => e.payload.reasonCode)).toEqual(["SUPERSEDED"]);
        await expect(asPortal(() => svc.getSlotOfferForCandidate({ token: firstToken, tenantId: TENANT, now: NOW }))).resolves.toBeNull();
    });

    it("re-checks every slot: a slot the panel lost is refused with which one and why", async () => {
        state.leave.push({ id: 4, tenantId: TENANT, employeeId: 4, status: "APPROVED", startDate: new Date("2026-10-21T00:00:00Z"), endDate: new Date("2026-10-21T00:00:00Z") });
        await expect(sendNew()).rejects.toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-SLOT-UNAVAILABLE",
            details: { unavailable: [{ start: "2026-10-21T04:00:00.000Z", reason: "LEAVE" }] },
        });
        expect(state.offers).toHaveLength(0);
    });

    it("needs a portal address, future slots, and a proposal that is still a proposal", async () => {
        getRecruitmentSettings.mockImplementation(async () => ({ ...SETTINGS, portalBaseUrl: null }));
        const savedEnv = process.env.HR_PORTAL_BASE_URL;
        delete process.env.HR_PORTAL_BASE_URL;
        await expect(sendNew()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-PORTAL-URL-REQUIRED" });
        if (savedEnv !== undefined) process.env.HR_PORTAL_BASE_URL = savedEnv;
        getRecruitmentSettings.mockImplementation(async () => ({ ...SETTINGS }));

        await expect(sendNew({ slots: ["2026-10-18T04:00:00Z"] })).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-INVALID" });
        const saved = await propose({ save: true });
        await send({ slotOfferId: saved.id });
        await expect(send({ slotOfferId: saved.id })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SLOT-OFFER-NOT-PROPOSED" });
    });

    it("the email being down does not undo the offer", async () => {
        sendCandidateEmail.mockResolvedValue({ sent: false, reason: "hub-unreachable" });
        const res = await sendNew();
        expect(res).toMatchObject({ status: "SENT", emailed: false });
    });
});

// ── public read and confirm ──────────────────────────────────────────────────

describe("getSlotOfferForCandidate", () => {
    it("shows the job, the slots and first names only", async () => {
        await sendNew();
        const token = tokenFromEmail();
        const view = await asPortal(() => svc.getSlotOfferForCandidate({ token, tenantId: TENANT, now: NOW }));
        expect(view).toEqual({
            firstName: "Ayesha",
            jobTitle: "Backend Engineer",
            companyName: "Acme",
            interviewType: "TECHNICAL",
            durationMinutes: 60,
            location: null,
            panelFirstNames: ["Sara", "Ali"],
            timeZone: "Asia/Karachi",
            expiresAt: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
            slots: [
                { start: "2026-10-20T04:00:00.000Z", end: "2026-10-20T05:00:00.000Z" },
                { start: "2026-10-21T04:00:00.000Z", end: "2026-10-21T05:00:00.000Z" },
            ],
        });
        expect(JSON.stringify(view)).not.toMatch(/Khan|Raza|@|"id"/);
    });

    it("answers the same null for unknown, malformed, other-tenant, expired, cancelled and flag-off", async () => {
        await sendNew();
        const token = tokenFromEmail();
        const read = (t, opts = {}) => asPortal(() => svc.getSlotOfferForCandidate({ token: t, tenantId: TENANT, now: NOW, ...opts }), opts.tenantId ?? TENANT);
        await expect(read("A".repeat(43))).resolves.toBeNull();
        await expect(read("short")).resolves.toBeNull();
        await expect(read(undefined)).resolves.toBeNull();
        await expect(read(token, { tenantId: OTHER })).resolves.toBeNull();
        await expect(read(token, { now: new Date(NOW.getTime() + 73 * HOUR) })).resolves.toBeNull();
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "false";
        await expect(read(token)).resolves.toBeNull();
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "true";
        await asTenant(() => svc.cancelSlotOffer({ tenantId: TENANT, slotOfferId: state.offers[0].id, reason: "Role on hold", scope: ORG, now: NOW }));
        await expect(read(token)).resolves.toBeNull();
    });
});

describe("confirmSlotOffer", () => {
    const confirm = (token, slotStart, opts = {}) =>
        asPortal(() => svc.confirmSlotOffer({ token, slotStart, tenantId: TENANT, now: NOW, ...opts }));

    it("creates the interview through the schedule path, in one transaction with the offer", async () => {
        await sendNew();
        const token = tokenFromEmail();
        const res = await confirm(token, "2026-10-21T04:00:00.000Z");
        expect(res).toEqual({ confirmed: true, start: "2026-10-21T04:00:00.000Z", end: "2026-10-21T05:00:00.000Z", durationMinutes: 60, location: null });

        const row = state.offers[0];
        const interview = state.interviews.find((i) => i.slotOfferId === row.id);
        expect(row).toMatchObject({ status: "CONFIRMED", interviewId: interview.id, tokenHash: null });
        expect(row.chosenSlotStart).toEqual(new Date("2026-10-21T04:00:00Z"));
        expect(interview).toMatchObject({
            applicationId: 9,
            interviewType: "TECHNICAL",
            durationMinutes: 60,
            calendarSyncStatus: "PENDING",
            calendarSyncAction: "CREATE",
            tenantId: TENANT,
        });
        expect(interview.scheduledAt).toEqual(new Date("2026-10-21T04:00:00Z"));
        expect(state.interviewers.filter((i) => i.interviewId === interview.id).map((i) => i.employeeId)).toEqual([3, 4]);
        expect(transitionApplicationStageInTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ id: 9, targetStage: "interview", source: "candidate.self_schedule" }),
            db,
        );
        expect(assertCommunicationsAllowed).toHaveBeenCalledWith({ tenantId: TENANT, candidateId: 5, purpose: "PROCESSING" }, { db });
        const names = events.map((e) => e.eventName);
        expect(names).toEqual(expect.arrayContaining(["hr.recruitment.interview_scheduled.v1", "hr.recruitment.interview_slot_confirmed.v1"]));
        expect(events.find((e) => e.eventName === "hr.recruitment.interview_slot_confirmed.v1").payload).toEqual({
            slotOfferId: String(row.id),
            applicationId: "9",
            requisitionId: "21",
            candidateId: "5",
            interviewId: String(interview.id),
            chosenSlotStart: "2026-10-21T04:00:00.000Z",
        });
        // The link is spent.
        await expect(confirm(token, "2026-10-20T04:00:00.000Z")).resolves.toBeNull();
    });

    it("two confirms of one offer create one interview", async () => {
        await sendNew();
        const token = tokenFromEmail();
        const results = await Promise.all([
            confirm(token, "2026-10-20T04:00:00.000Z"),
            confirm(token, "2026-10-21T04:00:00.000Z"),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((r) => r === null)).toHaveLength(1);
        expect(state.interviews).toHaveLength(1);
        expect(events.filter((e) => e.eventName === "hr.recruitment.interview_slot_confirmed.v1")).toHaveLength(1);
    });

    it("a slot the panel lost answers 'pick another' and keeps the offer SENT", async () => {
        await sendNew();
        const token = tokenFromEmail();
        state.leave.push({ id: 5, tenantId: TENANT, employeeId: 3, status: "APPROVED", startDate: new Date("2026-10-20T00:00:00Z"), endDate: new Date("2026-10-20T00:00:00Z") });
        await expect(confirm(token, "2026-10-20T04:00:00.000Z")).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" });
        expect(state.offers[0].status).toBe("SENT");
        expect(state.interviews).toHaveLength(0);
        await expect(confirm(token, "2026-10-21T04:00:00.000Z")).resolves.toMatchObject({ confirmed: true });
    });

    it("a time that is not one of the offered slots is the same 'pick another'", async () => {
        await sendNew();
        const token = tokenFromEmail();
        await expect(confirm(token, "2026-10-20T05:00:00.000Z")).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" });
        await expect(confirm(token, "garbage")).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" });
        await expect(confirm(token, "2026-10-20T04:00:00.000Z", { now: new Date("2026-10-20T04:30:00Z") })).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" });
        expect(state.offers[0].status).toBe("SENT");
    });

    it("the panel's calendar is checked again when calendarSync is on", async () => {
        await sendNew();
        const token = tokenFromEmail();
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
        axiosMock.request.mockImplementation(async () => ({
            data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ busy: { 4: [{ start: "2026-10-20T04:30:00Z", end: "2026-10-20T05:30:00Z" }] } }) }] } }),
        }));
        await expect(confirm(token, "2026-10-20T04:00:00.000Z")).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" });
        expect(state.offers[0].status).toBe("SENT");
    });

    it("a contact refusal inside the schedule path rolls the whole confirm back", async () => {
        await sendNew();
        const token = tokenFromEmail();
        assertCommunicationsAllowed.mockRejectedValue(Object.assign(new Error("blocked"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        await expect(confirm(token, "2026-10-20T04:00:00.000Z")).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
        expect(state.offers[0].status).toBe("SENT");
        expect(state.interviews).toHaveLength(0);
    });

    it("unknown, other-tenant and flag-off are all null", async () => {
        await sendNew();
        const token = tokenFromEmail();
        await expect(confirm("B".repeat(43), "2026-10-20T04:00:00.000Z")).resolves.toBeNull();
        await expect(asPortal(() => svc.confirmSlotOffer({ token, slotStart: "2026-10-20T04:00:00.000Z", tenantId: OTHER, now: NOW }), OTHER)).resolves.toBeNull();
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "false";
        await expect(confirm(token, "2026-10-20T04:00:00.000Z")).resolves.toBeNull();
        expect(state.offers[0].status).toBe("SENT");
    });
});

// ── cancel, list, expiry ─────────────────────────────────────────────────────

describe("cancelSlotOffer and listSlotOffers", () => {
    it("cancels an open offer with a reason; a confirmed one cannot be cancelled", async () => {
        await sendNew();
        const id = state.offers[0].id;
        await expect(asTenant(() => svc.cancelSlotOffer({ tenantId: TENANT, slotOfferId: id, reason: " ", scope: ORG }))).rejects.toMatchObject({ code: "HR-RECRUITMENT-SLOT-OFFER-REASON-REQUIRED" });
        const res = await asTenant(() => svc.cancelSlotOffer({ tenantId: TENANT, slotOfferId: id, reason: "Panel changed", scope: ORG, actorId: 1 }));
        expect(res).toMatchObject({ status: "CANCELLED", cancelReason: "Panel changed" });
        expect(offer(id).tokenHash).toBeNull();
        expect(events.at(-1)).toMatchObject({ eventName: "hr.recruitment.interview_slot_offer_cancelled.v1", payload: { reasonCode: "MANUAL", candidateId: "5" } });
        await expect(asTenant(() => svc.cancelSlotOffer({ tenantId: TENANT, slotOfferId: id, reason: "again", scope: ORG }))).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SLOT-OFFER-NOT-OPEN" });
        await expect(asTenant(() => svc.cancelSlotOffer({ tenantId: TENANT, slotOfferId: id, reason: "x", scope: ASSIGNED }))).rejects.toMatchObject({ status: 403 });
    });

    it("lists by application or requisition within the caller's scope, never with the hash", async () => {
        await sendNew();
        await propose({ save: true });
        const all = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: ORG, applicationId: 9 }));
        expect(all.total).toBe(2);
        expect(JSON.stringify(all)).not.toContain("tokenHash");
        const byReq = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: ORG, requisitionId: 21, status: "SENT" }));
        expect(byReq.items.map((i) => i.status)).toEqual(["SENT"]);
    });

    it("a manager sees only their own requisitions' offers; finance sees none", async () => {
        await sendNew();
        const mine = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: MANAGER(7) }));
        const theirs = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: MANAGER(8) }));
        const finance = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: { level: "FINANCE", unrestricted: false, employeeId: 2 } }));
        expect([mine.total, theirs.total, finance.total]).toEqual([1, 0, 0]);
    });
});

describe("runSlotOfferExpiryJob", () => {
    it("expires SENT offers past their time once, under each row's tenant", async () => {
        await sendNew();
        const id = state.offers[0].id;
        db.contextLog.length = 0;
        await expect(svc.runSlotOfferExpiryJob({ now: new Date(NOW.getTime() + 71 * HOUR) })).resolves.toMatchObject({ scanned: 0 });
        const run = await svc.runSlotOfferExpiryJob({ now: new Date(NOW.getTime() + 72 * HOUR) });
        expect(run).toMatchObject({ scanned: 1, expired: 1 });
        expect(offer(id)).toMatchObject({ status: "EXPIRED", tokenHash: null });
        expect(events.at(-1)).toMatchObject({ eventName: "hr.recruitment.interview_slot_offer_expired.v1", payload: { slotOfferId: String(id), candidateId: "5" } });
        await expect(svc.runSlotOfferExpiryJob({ now: new Date(NOW.getTime() + 80 * HOUR) })).resolves.toMatchObject({ scanned: 0 });
        const systemQueries = db.contextLog.filter((q) => q.system);
        expect(systemQueries.every((q) => q.model === "interviewSlotOffer" && q.op === "findMany")).toBe(true);
        expect(db.contextLog.filter((q) => !q.system).every((q) => q.tenantId === TENANT)).toBe(true);
        expect(db.contextLog.some((q) => !q.system && q.op === "updateMany")).toBe(true);
    });

    it("does nothing while selfScheduling is off", async () => {
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "false";
        await expect(svc.runSlotOfferExpiryJob({ now: NOW })).resolves.toEqual({ skipped: "FLAG_OFF" });
    });
});
