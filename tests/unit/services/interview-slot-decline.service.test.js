// Recruitment Phase 6 — the candidate declines every offered interview slot
// from the choose link: the offer is CANCELLED with the coded reason, the link
// stops working, the recruiter is told through an ids-only event, every dead
// link is the same null, and a decline and a confirm cannot both win.
import { createHash } from "node:crypto";
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const axiosMock = { request: jest.fn(), create: jest.fn(() => axiosMock) };
const assertCommunicationsAllowed = jest.fn();
const sendCandidateEmail = jest.fn();
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
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/application-workflow.service.js", () => ({
    transitionApplicationStageInTransaction: jest.fn(async () => ({})),
    transitionApplicationStage: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({ upsertInterviewScorecard: jest.fn(), default: jest.fn() }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({
    getRecruitmentSettings,
    RECRUITMENT_SETTINGS_DEFAULTS: { timeZone: "Asia/Karachi" },
}));

const svc = await import("../../../src/services/interview-slot-offer.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-19T03:00:00.000Z");
const HOUR = 3_600_000;
const ORG = { level: "ORG", unrestricted: true, employeeId: 1, canSeeInternalNotes: true };
const ASSIGNED = { level: "ASSIGNED", unrestricted: false, employeeId: 3, canSeeInternalNotes: false };
const DECLINED = "hr.recruitment.interview_slots_declined.v1";

const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const asPortal = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId }, portal: true }, async () => await fn());
const sha = (token) => createHash("sha256").update(token).digest("hex");
const tokenFromEmail = () => new URL(sendCandidateEmail.mock.calls.at(-1)[0].data.chooseUrl).searchParams.get("token");

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push(
        { id: 3, tenant_id: TENANT, first_name: "Sara", last_name: "Khan", employee_name: "Sara Khan", work_email: "sara@corp.test", email: null },
        { id: 4, tenant_id: TENANT, first_name: "Ali", last_name: "Raza", employee_name: "Ali Raza", work_email: "ali@corp.test", email: null },
    );
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7, approvedById: null, recruiterId: 12 });
    state.candidates.push({ id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Malik", email: "ayesha@example.com", anonymizedAt: null });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "screening" });
}

const sendOffer = () => asTenant(() => svc.sendSlotOffer({
    tenantId: TENANT, scope: ORG, actorId: 1, now: NOW,
    applicationId: 9, interviewerIds: [3, 4], interviewType: "TECHNICAL", durationMinutes: 60,
    slots: ["2026-10-20T04:00:00Z", "2026-10-21T04:00:00Z"],
}));
const decline = (token, reason, opts = {}) =>
    asPortal(() => svc.declineSlotOffer({ token, reason, tenantId: opts.tenantId ?? TENANT, now: opts.now ?? NOW }), opts.tenantId ?? TENANT);

beforeEach(() => {
    seed();
    events.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_SELF_SCHEDULING = "true";
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
    assertCommunicationsAllowed.mockImplementation(async () => ({ allowed: true }));
    sendCandidateEmail.mockImplementation(async () => ({ sent: true }));
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_SELF_SCHEDULING;
});

describe("declineSlotOffer", () => {
    it("cancels the offer with the coded reason and tells the recruiter, ids only", async () => {
        await sendOffer();
        const token = tokenFromEmail();
        await expect(decline(token, "none_suit")).resolves.toEqual({ declined: true });

        const row = state.offers[0];
        expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "CANDIDATE_DECLINED:NONE_SUIT", tokenHash: null, cancelledAt: NOW });
        const event = events.find((e) => e.eventName === DECLINED);
        expect(event).toMatchObject({ tenantId: TENANT, aggregateType: "InterviewSlotOffer", aggregateId: row.id, actorId: null });
        expect(event.payload).toEqual({
            slotOfferId: String(row.id),
            applicationId: "9",
            requisitionId: "21",
            candidateId: "5",
            reasonCode: "NONE_SUIT",
            offeredById: "1",
            recruiterId: "12",
        });
        // Not the recruiter-cancel event: nothing tells the candidate their own
        // decline was a withdrawal.
        expect(events.some((e) => e.eventName === svc.SLOT_OFFER_EVENTS.CANCELLED)).toBe(false);
        // The link is dead for read, confirm and a second decline alike.
        await expect(asPortal(() => svc.getSlotOfferForCandidate({ token, tenantId: TENANT, now: NOW }))).resolves.toBeNull();
        await expect(asPortal(() => svc.confirmSlotOffer({ token, slotStart: "2026-10-20T04:00:00.000Z", tenantId: TENANT, now: NOW }))).resolves.toBeNull();
        await expect(decline(token)).resolves.toBeNull();
    });

    it("a reason is optional; an unknown one is a 400 before the token is looked at", async () => {
        await sendOffer();
        const token = tokenFromEmail();
        await expect(decline(token, "because")).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SLOT-DECLINE-REASON-INVALID" });
        expect(state.offers[0].status).toBe("SENT");
        await expect(decline(token)).resolves.toEqual({ declined: true });
        expect(state.offers[0].cancelReason).toBe("CANDIDATE_DECLINED");
        expect(events.find((e) => e.eventName === DECLINED).payload.reasonCode).toBeNull();
    });

    it("is the same null for unknown, malformed, other-tenant, expired and flag-off", async () => {
        await sendOffer();
        const token = tokenFromEmail();
        await expect(decline("B".repeat(43))).resolves.toBeNull();
        await expect(decline("short")).resolves.toBeNull();
        await expect(decline(token, null, { tenantId: OTHER })).resolves.toBeNull();
        await expect(decline(token, null, { now: new Date(NOW.getTime() + 73 * HOUR) })).resolves.toBeNull();
        process.env.HR_RECRUITMENT_SELF_SCHEDULING = "false";
        await expect(decline(token)).resolves.toBeNull();
        expect(state.offers[0]).toMatchObject({ status: "SENT", tokenHash: sha(token) });
        expect(events.some((e) => e.eventName === DECLINED)).toBe(false);
    });

    it("after a confirm the link cannot decline", async () => {
        await sendOffer();
        const token = tokenFromEmail();
        await asPortal(() => svc.confirmSlotOffer({ token, slotStart: "2026-10-21T04:00:00.000Z", tenantId: TENANT, now: NOW }));
        await expect(decline(token, "OTHER")).resolves.toBeNull();
        expect(state.offers[0].status).toBe("CONFIRMED");
    });

    it("the recruiter sees the decline as a coded fact, whatever the notes rule", async () => {
        await sendOffer();
        await decline(tokenFromEmail(), "ACCEPTED_OTHER_OFFER");
        const org = await asTenant(() => svc.listSlotOffers({ tenantId: TENANT, scope: ORG, applicationId: 9 }));
        expect(org.items[0]).toMatchObject({ status: "CANCELLED", declinedByCandidate: true, declineReason: "ACCEPTED_OTHER_OFFER" });
        const restricted = svc.presentSlotOffer({ ...state.offers[0] }, ASSIGNED);
        expect(restricted).toMatchObject({ cancelReason: null, declinedByCandidate: true, declineReason: "ACCEPTED_OTHER_OFFER" });
        // A recruiter's own cancel is not a decline.
        expect(svc.presentSlotOffer({ id: 1, cancelReason: "Panel changed" })).not.toHaveProperty("declinedByCandidate");
    });
});
