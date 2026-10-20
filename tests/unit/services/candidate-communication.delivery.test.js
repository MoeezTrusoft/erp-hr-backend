// Recruitment Phase 2 — the delivery tick: claims, send-time re-checks in the
// plan's order (anonymized, DNC, consent, no email), the flag leaving rows
// QUEUED, hub failure backoff to FAILED, and no address in any log or event.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb, createRecordingLogger } from "./candidate-communication.fakes.js";

const { db, store } = createFakeDb();
const { logger, calls: logCalls } = createRecordingLogger();
const sendCandidateEmail = jest.fn();
const findActiveDnc = jest.fn();
const enqueueHrDomainEvent = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({
    CONSENT_STATUS: Object.freeze({ UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", WITHDRAWN: "WITHDRAWN" }),
    normalizeEmail: (email) => String(email ?? "").trim().toLowerCase(),
    findActiveDnc,
}));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidateVerification.service.js", () => ({
    PORTAL_STATUS_PATH: "/public/candidates/status",
}));

const { runCandidateCommunicationDeliveryTick, deliveryBackoffMs, MAX_DELIVERY_ATTEMPTS } = await import(
    "../../../src/services/candidate-communication.delivery.js"
);

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T12:00:00Z");
const EMAIL = "zoe@example.com";
const MINUTE = 60 * 1000;

let nextId = 1000;
const queued = (over = {}) => {
    const row = {
        id: nextId++,
        tenantId: TENANT,
        candidateId: 77,
        applicationId: 901,
        requisitionId: 9,
        templateId: "application.stage.screening",
        category: "STATUS",
        channel: "email",
        dedupeKey: `evt-${nextId}:application.stage.screening`,
        status: "QUEUED",
        suppressedReason: null,
        scheduledFor: new Date(NOW.getTime() - MINUTE),
        nextAttemptAt: null,
        claimedBy: null,
        claimExpiresAt: null,
        attempts: 0,
        lastError: null,
        sentAt: null,
        data: { candidateFirstName: "Zoe", jobTitle: "Sales Lead", candidateStatus: "UNDER_REVIEW" },
        ...over,
    };
    store.communications.push(row);
    return row;
};
const candidate = (over = {}) => store.candidates.push({ id: 77, tenantId: TENANT, email: EMAIL, consentStatus: "GRANTED", anonymizedAt: null, ...over });
const rowById = (id) => store.communications.find((r) => r.id === id);
const tick = (over = {}) => runCandidateCommunicationDeliveryTick({ now: NOW, workerId: "worker-a", ...over });

beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    logCalls.length = 0;
    process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
    store.applications.push({ id: 901, tenantId: TENANT, stage: "screening" });
    findActiveDnc.mockResolvedValue(null);
    sendCandidateEmail.mockResolvedValue({ sent: true, notificationId: "n-1" });
    enqueueHrDomainEvent.mockResolvedValue({ id: "outbox-1" });
});
afterEach(() => {
    // No test may ever log the address.
    expect(JSON.stringify(logCalls)).not.toContain(EMAIL);
    delete process.env.HR_RECRUITMENT_COMMUNICATIONS;
});

describe("runCandidateCommunicationDeliveryTick", () => {
    it("sends a due row through the hub and records SENT with its event", async () => {
        candidate();
        const row = queued();
        const summary = await tick();

        expect(summary).toMatchObject({ scanned: 1, sent: 1 });
        expect(sendCandidateEmail).toHaveBeenCalledWith({
            tenantId: TENANT,
            email: EMAIL,
            templateId: "hr.recruitment.candidate_under_review",
            data: row.data,
            dedupeKey: `hr-candidate-communication:${row.id}`,
            category: "STATUS",
        });
        expect(rowById(row.id)).toMatchObject({ status: "SENT", sentAt: NOW, claimedBy: null, claimExpiresAt: null });
        const [, event] = enqueueHrDomainEvent.mock.calls[0];
        expect(event).toMatchObject({
            eventName: "hr.recruitment.candidate_communication_sent.v1",
            tenantId: TENANT,
            aggregateType: "CandidateCommunication",
            payload: { communicationId: String(row.id), candidateId: "77", applicationId: "901", templateId: row.templateId, status: "SENT", reason: null },
        });
        expect(JSON.stringify(event)).not.toMatch(/zoe|Sales Lead/i);
    });

    it("scans as SYSTEM and touches each row only under its own tenant", async () => {
        candidate();
        queued();
        await tick();
        const [scan, ...rest] = db.contextLog;
        expect(scan).toMatchObject({ model: "candidateCommunication", op: "findMany", system: true });
        expect(rest.length).toBeGreaterThan(2);
        for (const entry of rest) expect(entry).toMatchObject({ system: false, tenantId: TENANT });
    });

    it("leaves rows that are not due, backing off or claimed by a live lease", async () => {
        candidate();
        const future = queued({ scheduledFor: new Date(NOW.getTime() + MINUTE) });
        const backingOff = queued({ nextAttemptAt: new Date(NOW.getTime() + MINUTE) });
        const leased = queued({ claimedBy: "worker-b", claimExpiresAt: new Date(NOW.getTime() + MINUTE) });
        const expired = queued({ claimedBy: "worker-dead", claimExpiresAt: new Date(NOW.getTime() - MINUTE) });
        const done = queued({ status: "SENT" });

        const summary = await tick();

        expect(summary).toMatchObject({ scanned: 1, sent: 1 });
        expect(rowById(expired.id).status).toBe("SENT");
        for (const r of [future, backingOff, leased]) expect(rowById(r.id).status).toBe("QUEUED");
        expect(rowById(done.id).sentAt).toBeNull();
    });

    it("claims atomically: two overlapping ticks send a row once", async () => {
        candidate();
        queued();
        const [a, b] = await Promise.all([tick({ workerId: "worker-a" }), tick({ workerId: "worker-b" })]);
        expect(sendCandidateEmail).toHaveBeenCalledTimes(1);
        expect(a.sent + b.sent).toBe(1);
        expect(a.raceLost + b.raceLost).toBe(1);
    });

    describe("send-time checks, in order", () => {
        const suppressedAs = async (reason) => {
            const row = queued();
            const summary = await tick();
            expect(summary.suppressed).toBe(1);
            expect(rowById(row.id)).toMatchObject({ status: "SUPPRESSED", suppressedReason: reason, claimedBy: null });
            expect(sendCandidateEmail).not.toHaveBeenCalled();
            const [, event] = enqueueHrDomainEvent.mock.calls[0];
            expect(event).toMatchObject({
                eventName: "hr.recruitment.candidate_communication_suppressed.v1",
                payload: { status: "SUPPRESSED", reason },
            });
            expect(JSON.stringify(event)).not.toContain(EMAIL);
        };

        it("anonymized wins over DNC and consent", async () => {
            candidate({ anonymizedAt: new Date("2026-10-01T00:00:00Z"), consentStatus: "WITHDRAWN" });
            findActiveDnc.mockResolvedValue({ id: 1, reasonCode: "CANDIDATE_REQUEST" });
            await suppressedAs("ANONYMIZED");
        });

        it("DNC wins over withdrawn consent", async () => {
            candidate({ consentStatus: "WITHDRAWN" });
            findActiveDnc.mockResolvedValue({ id: 1, reasonCode: "CANDIDATE_REQUEST" });
            await suppressedAs("DNC");
            expect(findActiveDnc).toHaveBeenCalledWith({ tenantId: TENANT, email: EMAIL, at: NOW });
        });

        it("withdrawn consent wins over a missing address", async () => {
            candidate({ consentStatus: "WITHDRAWN", email: "" });
            await suppressedAs("CONSENT_WITHDRAWN");
        });

        it("no address suppresses as NO_EMAIL", async () => {
            candidate({ email: "  " });
            await suppressedAs("NO_EMAIL");
        });

        it("UNKNOWN consent is not a withdrawal", async () => {
            candidate({ consentStatus: "UNKNOWN" });
            queued();
            expect((await tick()).sent).toBe(1);
        });
    });

    it("cancels a rejection whose application was reinstated, and any message for a withdrawn application", async () => {
        candidate();
        store.applications.push({ id: 902, tenantId: TENANT, stage: "withdrawn" });
        const rejection = queued({ category: "REJECTION", templateId: "application.rejected" });
        const withdrawn = queued({ applicationId: 902 });

        const summary = await tick();

        expect(summary.cancelled).toBe(2);
        expect(rowById(rejection.id)).toMatchObject({ status: "CANCELLED", data: { cancellation: { reason: "REINSTATED" } } });
        expect(rowById(withdrawn.id)).toMatchObject({ status: "CANCELLED", data: { cancellation: { reason: "WITHDRAWN" } } });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("sends a rejection while the application is still rejected", async () => {
        candidate();
        store.applications[0].stage = "rejected";
        queued({ category: "REJECTION", templateId: "application.rejected" });
        expect((await tick()).sent).toBe(1);
        expect(sendCandidateEmail.mock.calls[0][0].templateId).toBe("hr.recruitment.candidate_application_closed");
    });

    it("does nothing with the flag off, so turning it on later still delivers", async () => {
        candidate({ consentStatus: "WITHDRAWN" });
        const row = queued();
        process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
        expect(await tick()).toEqual({ skipped: "FLAG_OFF" });
        expect(rowById(row.id)).toMatchObject({ status: "QUEUED", claimedBy: null, suppressedReason: null });
        expect(db.candidateCommunication.updateMany).not.toHaveBeenCalled();
    });

    it("leaves a claimed row QUEUED (claim released) if the flag goes off mid-tick", async () => {
        candidate();
        const row = queued();
        findActiveDnc.mockImplementation(async () => {
            process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
            return null;
        });
        const summary = await tick();
        expect(summary.deferred).toBe(1);
        expect(rowById(row.id)).toMatchObject({ status: "QUEUED", claimedBy: null, claimExpiresAt: null, attempts: 0 });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("retries a hub failure with exponential backoff and fails after five attempts", async () => {
        candidate();
        sendCandidateEmail.mockResolvedValue({ sent: false, reason: "hub-unreachable" });
        const row = queued();

        await tick();
        expect(rowById(row.id)).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "hub-unreachable", claimedBy: null });
        expect(rowById(row.id).nextAttemptAt.getTime()).toBe(NOW.getTime() + MINUTE);

        // Not due again until the backoff passes.
        expect((await tick()).scanned).toBe(0);
        const second = new Date(NOW.getTime() + MINUTE);
        await tick({ now: second });
        expect(rowById(row.id)).toMatchObject({ attempts: 2 });
        expect(rowById(row.id).nextAttemptAt.getTime()).toBe(second.getTime() + 2 * MINUTE);

        rowById(row.id).attempts = MAX_DELIVERY_ATTEMPTS - 1;
        rowById(row.id).nextAttemptAt = null;
        const summary = await tick({ now: second });
        expect(summary.failed).toBe(1);
        expect(rowById(row.id)).toMatchObject({ status: "FAILED", attempts: MAX_DELIVERY_ATTEMPTS, nextAttemptAt: null });
        expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
    });

    it("computes the backoff schedule with a cap", () => {
        expect([1, 2, 3, 4].map(deliveryBackoffMs)).toEqual([1, 2, 4, 8].map((m) => m * MINUTE));
        expect(deliveryBackoffMs(50)).toBe(6 * 60 * MINUTE);
    });

    it("keeps going when one row fails", async () => {
        candidate();
        const broken = queued();
        const fine = queued();
        db.candidate.findFirst.mockRejectedValueOnce(new Error("connection reset"));
        const summary = await tick();
        expect(summary).toMatchObject({ errors: 1, sent: 1 });
        expect(rowById(broken.id).status).toBe("QUEUED");
        expect(rowById(fine.id).status).toBe("SENT");
    });

    it("never logs the address, even on failures", async () => {
        candidate();
        sendCandidateEmail.mockResolvedValue({ sent: false, reason: "send-failed" });
        queued();
        queued();
        await tick();
        expect(logCalls.length).toBeGreaterThan(0);
        // (the afterEach asserts the address is absent from every log call)
    });
});
