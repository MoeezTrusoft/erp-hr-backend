// Recruitment Phase 6 — the talent pool invitation email through the candidate
// communication pipeline: the consumer resolves talent_pool_invitation_sent to
// the open invitation (no application), the delivery loop mints the
// single-use link right before the hub call (the raw token is in that call's
// data only: never on the row, in an event or in a log), a closed invitation
// cancels the message, and the emailed link answers the invitation.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createInvitationLinksDb } from "./helpers/invitation-links.fake.js";
import { createRecordingLogger } from "./candidate-communication.fakes.js";

const { db, state } = createInvitationLinksDb();
const { logger, calls: logCalls } = createRecordingLogger();
const flags = new Set();
const sendCandidateEmail = jest.fn();
const findActiveDnc = jest.fn();
const enqueueHrDomainEvent = jest.fn();
const getRecruitmentSettings = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/lib/recruitment-flags.util.js", () => ({ isRecruitmentFlagEnabled: (key) => flags.has(key) }));
jest.unstable_mockModule("../../../src/lib/recruitment-ops-metrics.util.js", () => ({ recordRetentionRun: jest.fn() }));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({
    CONSENT_STATUS: Object.freeze({ UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", WITHDRAWN: "WITHDRAWN" }),
    normalizeEmail: (email) => String(email ?? "").trim().toLowerCase(),
    findActiveDnc,
    assertCommunicationsAllowed: jest.fn(async () => ({ allowed: true })),
}));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidate-verification.service.js", () => ({ PORTAL_STATUS_REQUEST_PATH: "/status" }));
jest.unstable_mockModule("../../../src/services/talent-nurture.service.js", () => ({ intakeAcceptedNurtureInvitation: jest.fn() }));

const { handleCandidateCommunicationEvent } = await import("../../../src/services/candidate-communication.consumer.js");
const { runCandidateCommunicationDeliveryTick } = await import("../../../src/services/candidate-communication.delivery.js");
const { templateForEvent, getCommunicationTemplate } = await import("../../../src/services/candidate-communication.templates.js");
const { respondViaInvitationLink } = await import("../../../src/services/invitation-response.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T09:00:00.000Z");
const DAY = 86_400_000;
const EMAIL = "ayesha@example.com";
const INVITATION_SENT = "hr.recruitment.talent_pool_invitation_sent.v1";

let seq = 0;
const envelope = (payload) => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    name: INVITATION_SENT,
    tenantId: TENANT,
    occurredAt: NOW.toISOString(),
    payload,
});
const sent = (invitationId = 700, extra = {}) =>
    handleCandidateCommunicationEvent(envelope({ invitationId: String(invitationId), candidateId: "5", jobRequisitionId: "21", status: "INVITED", reused: false, ...extra }), { now: NOW });
const tick = () => runCandidateCommunicationDeliveryTick({ now: new Date(NOW.getTime() + 60_000), workerId: "worker-a" });
const hubCall = () => sendCandidateEmail.mock.calls.at(-1)[0];
const tokenOf = (call = hubCall()) => new URL(call.data.respondUrl).searchParams.get("token");

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.candidates.push({ id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Malik", email: EMAIL, consentStatus: "GRANTED", anonymizedAt: null });
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer" });
    state.invitations.push({
        id: 700, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, status: "INVITED", invitedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 14 * DAY), responseNote: null, responseTokenHash: null, responseTokenExpiresAt: null, respondedVia: null,
    });
}

beforeEach(() => {
    seed();
    jest.clearAllMocks();
    logCalls.length = 0;
    flags.clear();
    flags.add("communications");
    flags.add("invitationLinks");
    getRecruitmentSettings.mockResolvedValue({ portalBaseUrl: "https://careers.acme.test", companyName: "Acme", rejectionDelayHours: 0 });
    findActiveDnc.mockResolvedValue(null);
    sendCandidateEmail.mockResolvedValue({ sent: true });
    enqueueHrDomainEvent.mockResolvedValue({ id: "outbox-1" });
});
afterEach(() => {
    // Never the address, and never a token, in any log.
    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(EMAIL);
    for (const call of sendCandidateEmail.mock.calls) {
        if (call[0]?.data?.respondUrl) expect(logged).not.toContain(tokenOf(call[0]));
    }
});

describe("the template", () => {
    it("maps the invitation event and renders no stage, status or score", () => {
        const template = templateForEvent(INVITATION_SENT, {});
        expect(template).toBe(getCommunicationTemplate("talentPool.invitation"));
        expect(template).toMatchObject({ category: "STATUS", hubTemplateId: "hr.recruitment.candidate_talent_pool_invitation", manual: false });
        const data = template.buildData({
            application: { stage: "screening" },
            candidate: { firstName: "Ayesha" },
            requisition: { title: "Backend Engineer" },
            settings: { companyName: "Acme" },
            invitation: { id: 700, expiresAt: new Date("2026-11-03T09:00:00.000Z") },
        });
        expect(data).toEqual({
            candidateFirstName: "Ayesha",
            jobTitle: "Backend Engineer",
            companyName: "Acme",
            statusPageUrl: null,
            invitationExpiresAt: "2026-11-03T09:00:00.000Z",
            invitationId: "700",
        });
    });
});

describe("the consumer", () => {
    it("queues one application-less row for the open invitation, with no link in it", async () => {
        await expect(sent()).resolves.toMatchObject({ outcome: "QUEUED", queued: 1 });
        await expect(sent()).resolves.toMatchObject({ outcome: "QUEUED" }); // a second event (a re-send) is a second message
        const [row] = state.communications;
        expect(row).toMatchObject({
            tenantId: TENANT,
            candidateId: 5,
            applicationId: null,
            requisitionId: 21,
            templateId: "talentPool.invitation",
            category: "STATUS",
            eventName: INVITATION_SENT,
        });
        expect(row.data).toMatchObject({ candidateFirstName: "Ayesha", jobTitle: "Backend Engineer", invitationId: "700" });
        expect(JSON.stringify(row)).not.toMatch(/respondUrl|token|@/);
        expect(db.contextLog.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });

    it("maps to nothing with the flag off, or for an answered, lapsed or erased invitation", async () => {
        flags.delete("invitationLinks");
        await expect(sent()).resolves.toMatchObject({ outcome: "NO_MESSAGE" });
        flags.add("invitationLinks");
        state.invitations[0].expiresAt = new Date(NOW.getTime() - DAY);
        await expect(sent()).resolves.toMatchObject({ outcome: "NO_MESSAGE" });
        state.invitations[0].expiresAt = null;
        state.candidates[0].anonymizedAt = NOW;
        await expect(sent()).resolves.toMatchObject({ outcome: "NO_MESSAGE" });
        state.candidates[0].anonymizedAt = null;
        state.invitations[0].status = "DECLINED";
        await expect(sent()).resolves.toMatchObject({ outcome: "NO_MESSAGE" });
        await expect(sent(999)).resolves.toMatchObject({ outcome: "NO_MESSAGE" });
        expect(state.communications).toHaveLength(0);
    });
});

describe("delivery", () => {
    it("mints the link at send time: the hub gets it, the row and the events never do", async () => {
        await sent();
        await expect(tick()).resolves.toMatchObject({ sent: 1 });
        const call = hubCall();
        expect(call).toMatchObject({ tenantId: TENANT, email: EMAIL, templateId: "hr.recruitment.candidate_talent_pool_invitation", category: "STATUS" });
        expect(call.data).toEqual({
            candidateFirstName: "Ayesha",
            jobTitle: "Backend Engineer",
            companyName: "Acme",
            statusPageUrl: "https://careers.acme.test/status",
            invitationExpiresAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
            respondUrl: expect.stringMatching(/^https:\/\/careers\.acme\.test\/invitations\/respond\?token=[A-Za-z0-9_-]{43}$/),
        });
        const token = tokenOf(call);
        expect(call.dedupeKey).toMatch(new RegExp(`^hr-candidate-communication:${state.communications[0].id}:[0-9a-f]{16}$`));
        expect(state.communications[0].status).toBe("SENT");
        expect(JSON.stringify(state)).not.toContain(token);
        expect(JSON.stringify(enqueueHrDomainEvent.mock.calls)).not.toContain(token);

        // The emailed link answers the invitation.
        const answer = await mcpCtx.run({ user: { tenantId: TENANT }, portal: true }, async () =>
            await respondViaInvitationLink({ tenantId: TENANT, token, body: { answer: "DECLINE" }, now: new Date(NOW.getTime() + DAY) }));
        expect(answer).toEqual({ answer: "DECLINED", applicationReceived: false });
        expect(state.invitations[0]).toMatchObject({ status: "DECLINED", respondedVia: "CANDIDATE_LINK", responseTokenHash: null });
    });

    it("a retried send mints a new link under a new dedupe key", async () => {
        await sent();
        sendCandidateEmail.mockResolvedValueOnce({ sent: false, reason: "hub-down" });
        await expect(tick()).resolves.toMatchObject({ retry: 1 });
        const first = hubCall();
        state.communications[0].nextAttemptAt = null;
        await expect(tick()).resolves.toMatchObject({ sent: 1 });
        const second = hubCall();
        expect(second.dedupeKey).not.toBe(first.dedupeKey);
        expect(tokenOf(second)).not.toBe(tokenOf(first));
    });

    it("an invitation that closed while the message waited cancels it; no link is minted", async () => {
        await sent();
        state.invitations[0].status = "WITHDRAWN";
        await expect(tick()).resolves.toMatchObject({ cancelled: 1 });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
        expect(state.communications[0]).toMatchObject({ status: "CANCELLED", data: expect.objectContaining({ cancellation: expect.objectContaining({ reason: "INVITATION_CLOSED" }) }) });
        expect(state.invitations[0].responseTokenHash).toBeNull();
    });

    it("a do-not-contact entry suppresses it before any link exists", async () => {
        await sent();
        findActiveDnc.mockResolvedValue({ id: 1 });
        await expect(tick()).resolves.toMatchObject({ suppressed: 1 });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
        expect(state.invitations[0].responseTokenHash).toBeNull();
    });

    it("no portal address is a retryable failure; the flag turned off cancels", async () => {
        const saved = process.env.HR_PORTAL_BASE_URL;
        delete process.env.HR_PORTAL_BASE_URL;
        await sent();
        getRecruitmentSettings.mockResolvedValue({ portalBaseUrl: null });
        await expect(tick()).resolves.toMatchObject({ retry: 1 });
        expect(state.communications[0]).toMatchObject({ status: "QUEUED", lastError: "NO_PORTAL_URL" });
        if (saved !== undefined) process.env.HR_PORTAL_BASE_URL = saved;

        state.communications[0].nextAttemptAt = null;
        flags.delete("invitationLinks");
        await expect(tick()).resolves.toMatchObject({ cancelled: 1 });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });
});
