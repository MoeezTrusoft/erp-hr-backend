// Recruitment Phase 2 — the hr:events consumer that turns recruitment events
// into QUEUED candidate messages: dedupe on redelivery, the rejection delay
// from settings, reinstatement cancelling the queued rejection, the no-message
// cases, and ack-only-after-write on the stream.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb, createRecordingLogger } from "./candidate-communication.fakes.js";

const { db, store } = createFakeDb();
const { logger, calls: logCalls } = createRecordingLogger();
const getRecruitmentSettings = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidateVerification.service.js", () => ({
    PORTAL_STATUS_REQUEST_PATH: "/status",
}));

const {
    handleCandidateCommunicationEvent,
    processCandidateCommunicationEntry,
    startCandidateCommunicationConsumer,
    CANDIDATE_COMMS_DEAD_LETTER,
} = await import("../../../src/services/candidate-communication.consumer.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3600 * 1000;

let seq = 0;
const envelope = (name, payload, extra = {}) => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    name,
    tenantId: TENANT,
    occurredAt: NOW.toISOString(),
    actor: { type: "service", id: "erp-hr" },
    payload,
    ...extra,
});

const application = (over = {}) => ({
    id: 901,
    tenantId: TENANT,
    candidateId: 77,
    jobRequisitionId: 9,
    stage: "rejected",
    candidate: { id: 77, firstName: "Zoe" },
    jobRequisition: { id: 9, title: "Sales Lead" },
    offer: null,
    ...over,
});

const stageChanged = (fromStage, toStage, applicationId = 901) =>
    envelope("hr.recruitment.application_stage_changed.v1", {
        applicationId: String(applicationId),
        candidateId: "77",
        fromStage,
        toStage,
        reason: "MINIMUM_REQUIREMENTS_NOT_MET",
    });

beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    logCalls.length = 0;
    process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
    getRecruitmentSettings.mockResolvedValue({
        rejectionDelayHours: 12,
        companyName: "Trusoft",
        portalBaseUrl: "https://careers.example.com/",
    });
    store.candidates.push({ id: 77, tenantId: TENANT, firstName: "Zoe", email: "zoe@example.com" });
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_COMMUNICATIONS;
});

describe("handleCandidateCommunicationEvent", () => {
    it("queues a rejection after the tenant's rejection delay, without contact details", async () => {
        store.applications.push(application());
        const event = stageChanged("interview", "rejected");
        const result = await handleCandidateCommunicationEvent(event, { now: NOW });

        expect(result).toMatchObject({ outcome: "QUEUED", queued: 1 });
        expect(getRecruitmentSettings).toHaveBeenCalledWith({ tenantId: TENANT });
        const [row] = store.communications;
        expect(row).toMatchObject({
            tenantId: TENANT,
            status: "QUEUED",
            category: "REJECTION",
            templateId: "application.rejected",
            dedupeKey: `${event.id}:application.rejected`,
            eventId: event.id,
            eventName: event.name,
            candidateId: 77,
            applicationId: 901,
            requisitionId: 9,
        });
        expect(row.scheduledFor.getTime()).toBe(NOW.getTime() + 12 * HOUR);
        expect(row.data).toMatchObject({
            candidateFirstName: "Zoe",
            jobTitle: "Sales Lead",
            companyName: "Trusoft",
            candidateStatus: "CLOSED",
            statusPageUrl: "https://careers.example.com/status",
        });
        expect(JSON.stringify(row.data)).not.toMatch(/zoe@example|MINIMUM_REQUIREMENTS|rejected/);
        // Every query ran under the event's tenant (never SYSTEM, never none).
        expect(db.contextLog.length).toBeGreaterThan(0);
        for (const entry of db.contextLog) expect(entry).toMatchObject({ system: false, tenantId: TENANT });
    });

    it("measures the delay from the event time when the consumer lags", async () => {
        store.applications.push(application());
        const event = { ...stageChanged("screening", "rejected"), occurredAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() };
        await handleCandidateCommunicationEvent(event, { now: NOW });
        expect(store.communications[0].scheduledFor.getTime()).toBe(NOW.getTime() + 7 * HOUR);
    });

    it("is a no-op on redelivery of the same event", async () => {
        store.applications.push(application());
        const event = stageChanged("interview", "rejected");
        await handleCandidateCommunicationEvent(event, { now: NOW });
        const again = await handleCandidateCommunicationEvent(event, { now: NOW });
        expect(again).toMatchObject({ outcome: "DUPLICATE", queued: 0, duplicates: 1 });
        expect(store.communications).toHaveLength(1);
    });

    it("sends non-rejection messages at once", async () => {
        store.applications.push(application({ stage: "screening" }));
        await handleCandidateCommunicationEvent(stageChanged("applied", "screening"), { now: NOW });
        expect(store.communications[0]).toMatchObject({ category: "STATUS", templateId: "application.stage.screening" });
        expect(store.communications[0].scheduledFor.getTime()).toBe(NOW.getTime());
    });

    it("cancels the queued rejection when the application is reinstated", async () => {
        store.applications.push(application());
        await handleCandidateCommunicationEvent(stageChanged("interview", "rejected"), { now: NOW });
        store.applications[0].stage = "screening";

        const result = await handleCandidateCommunicationEvent(stageChanged("rejected", "screening"), { now: NOW });

        expect(result).toMatchObject({ cancelled: 1 });
        const rejection = store.communications.find((r) => r.templateId === "application.rejected");
        expect(rejection.status).toBe("CANCELLED");
        expect(rejection.data.cancellation).toMatchObject({ reason: "REINSTATED" });
        expect(store.communications.find((r) => r.templateId === "application.stage.screening").status).toBe("QUEUED");
    });

    it("does not cancel a rejection that already went out", async () => {
        store.applications.push(application());
        await handleCandidateCommunicationEvent(stageChanged("interview", "rejected"), { now: NOW });
        store.communications[0].status = "SENT";
        await handleCandidateCommunicationEvent(stageChanged("rejected", "screening"), { now: NOW });
        expect(store.communications[0].status).toBe("SENT");
    });

    it("writes nothing when the candidate withdrew or the move is internal", async () => {
        store.applications.push(application({ stage: "withdrawn" }));
        expect((await handleCandidateCommunicationEvent(stageChanged("screening", "withdrawn"), { now: NOW })).outcome).toBe("NO_MESSAGE");
        expect((await handleCandidateCommunicationEvent(stageChanged("screening", "on_hold"), { now: NOW })).outcome).toBe("NO_MESSAGE");
        expect(store.communications).toHaveLength(0);
        expect(getRecruitmentSettings).not.toHaveBeenCalled();
    });

    it("does not address a withdrawn application even when the event maps", async () => {
        store.applications.push(application({ stage: "withdrawn" }));
        const result = await handleCandidateCommunicationEvent(stageChanged("applied", "screening"), { now: NOW });
        expect(result.outcome).toBe("NO_MESSAGE");
        expect(store.communications).toHaveLength(0);
    });

    it("drops events while the communications flag is off", async () => {
        process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
        store.applications.push(application());
        const result = await handleCandidateCommunicationEvent(stageChanged("interview", "rejected"), { now: NOW });
        expect(result.outcome).toBe("FLAG_OFF");
        expect(store.communications).toHaveLength(0);
    });

    it("never resolves an application of another tenant", async () => {
        store.applications.push(application({ tenantId: OTHER }));
        const result = await handleCandidateCommunicationEvent(stageChanged("interview", "rejected"), { now: NOW });
        expect(result.outcome).toBe("NO_MESSAGE");
        expect(store.communications).toHaveLength(0);
    });

    it("acknowledges recruiter-added applications but not portal ones (the portal confirms its own)", async () => {
        store.applications.push(application({ id: 1, stage: "applied" }), application({ id: 2, stage: "applied" }));
        store.history.push({ id: 1, tenantId: TENANT, applicationId: 1, source: "public-portal" });
        const portal = await handleCandidateCommunicationEvent(
            envelope("hr.recruitment.application_created.v1", { applicationId: "1" }),
            { now: NOW },
        );
        const recruiter = await handleCandidateCommunicationEvent(
            envelope("hr.recruitment.application_created.v1", { applicationId: "2" }),
            { now: NOW },
        );
        expect(portal.outcome).toBe("NO_MESSAGE");
        expect(recruiter.outcome).toBe("QUEUED");
        expect(store.communications.map((r) => [r.applicationId, r.templateId])).toEqual([[2, "application.received"]]);
    });

    it("renders the interview time and type, never the panel", async () => {
        store.applications.push(application({ stage: "interview" }));
        store.interviews.push({
            id: 351, tenantId: TENANT, applicationId: 901, status: "SCHEDULED",
            scheduledAt: new Date("2026-11-02T10:00:00Z"), durationMinutes: 60, interviewType: "VIDEO", notes: "panel prep",
        });
        await handleCandidateCommunicationEvent(
            envelope("hr.recruitment.interview_scheduled.v1", { interviewId: "351", applicationId: "901", interviewerIds: ["8", "9"] }),
            { now: NOW },
        );
        const [row] = store.communications;
        expect(row).toMatchObject({ category: "INTERVIEW", templateId: "interview.scheduled" });
        expect(row.data).toMatchObject({ interviewAt: "2026-11-02T10:00:00.000Z", interviewType: "Video interview" });
        expect(JSON.stringify(row.data)).not.toMatch(/interviewer|panel prep|"8"/);
    });

    it("skips an interview that was cancelled before the scheduled event was handled", async () => {
        store.applications.push(application({ stage: "interview" }));
        store.interviews.push({ id: 351, tenantId: TENANT, applicationId: 901, status: "CANCELLED", scheduledAt: NOW, interviewType: "VIDEO" });
        const result = await handleCandidateCommunicationEvent(
            envelope("hr.recruitment.interview_scheduled.v1", { interviewId: "351" }),
            { now: NOW },
        );
        expect(result.outcome).toBe("NO_MESSAGE");
    });

    it("announces a sent offer, but not a withdrawn one or one already personalised", async () => {
        store.applications.push(application({ id: 1, stage: "offer" }), application({ id: 2, stage: "offer" }), application({ id: 3, stage: "offer" }));
        store.offers.push(
            { id: 11, tenantId: TENANT, applicationId: 1, status: "SENT" },
            { id: 12, tenantId: TENANT, applicationId: 2, status: "WITHDRAWN" },
            { id: 13, tenantId: TENANT, applicationId: 3, status: "SENT" },
        );
        store.communications.push({
            id: 500, tenantId: TENANT, applicationId: 3, templateId: "offer.sent", eventId: null, status: "QUEUED", dedupeKey: "manual:3:offer.sent:r1",
        });
        for (const offerId of ["11", "12", "13"]) {
            await handleCandidateCommunicationEvent(envelope("hr.recruitment.offer_sent.v1", { offerId, candidateId: "77" }), { now: NOW });
        }
        const auto = store.communications.filter((r) => r.eventId);
        expect(auto.map((r) => r.applicationId)).toEqual([1]);
        expect(auto[0]).toMatchObject({ category: "OFFER", templateId: "offer.sent" });
    });

    it("fans a closed requisition out to its open applications, one key each", async () => {
        store.applications.push(
            application({ id: 1, stage: "screening" }),
            application({ id: 2, stage: "interview", candidateId: 78 }),
            application({ id: 3, stage: "hired" }),
            application({ id: 4, stage: "rejected" }),
            application({ id: 5, stage: "withdrawn" }),
            application({ id: 6, stage: "screening", jobRequisitionId: 10 }),
        );
        const event = envelope("hr.recruitment.requisition_closed.v1", { requisitionId: "9", status: "CLOSED", reason: "FILLED" });
        await handleCandidateCommunicationEvent(event, { now: NOW });
        await handleCandidateCommunicationEvent(event, { now: NOW });
        expect(store.communications.map((r) => r.applicationId).sort()).toEqual([1, 2]);
        expect(store.communications.map((r) => r.dedupeKey)).toEqual([
            `${event.id}:requisition.closed:1`,
            `${event.id}:requisition.closed:2`,
        ]);
        expect(JSON.stringify(store.communications.map((r) => r.data))).not.toMatch(/FILLED/);
    });

    it("ignores events with no tenant or no id", async () => {
        expect((await handleCandidateCommunicationEvent({ name: "x", payload: {} })).outcome).toBe("IGNORED");
        expect((await handleCandidateCommunicationEvent({ ...stageChanged("a", "b"), tenantId: null })).outcome).toBe("IGNORED");
    });
});

describe("processCandidateCommunicationEntry (stream)", () => {
    const fakeRedis = () => {
        const retries = new Map();
        return {
            acked: [],
            deadLetters: [],
            xack: jest.fn(async function (stream, group, id) { this.acked.push(id); return 1; }),
            hdel: jest.fn(async (_hash, id) => retries.delete(id)),
            hincrby: jest.fn(async (_hash, id, by) => {
                retries.set(id, (retries.get(id) ?? 0) + by);
                return retries.get(id);
            }),
            xadd: jest.fn(async function (stream, _id, ...fields) { this.deadLetters.push({ stream, fields }); return "1-0"; }),
        };
    };
    const entry = (id, env) => [id, ["event", env?.name ?? "", "envelope", JSON.stringify(env), "eid", env?.id ?? ""]];

    it("acks after the row is written", async () => {
        store.applications.push(application());
        const redis = fakeRedis();
        const result = await processCandidateCommunicationEntry(redis, entry("1-1", stageChanged("interview", "rejected")));
        expect(result.outcome).toBe("QUEUED");
        expect(redis.acked).toEqual(["1-1"]);
        expect(store.communications).toHaveLength(1);
    });

    it("acks events that map to nothing and unparseable entries", async () => {
        const redis = fakeRedis();
        await processCandidateCommunicationEntry(redis, entry("1-2", envelope("hr.leave.approved.v1", {})));
        await processCandidateCommunicationEntry(redis, ["1-3", ["envelope", "{not json"]]);
        expect(redis.acked).toEqual(["1-2", "1-3"]);
    });

    it("leaves a failing event pending, then dead-letters it after five attempts", async () => {
        store.applications.push(application());
        const redis = fakeRedis();
        const original = db.application.findFirst.getMockImplementation();
        db.application.findFirst.mockRejectedValue(Object.assign(new Error("db down"), { code: "P1001" }));
        try {
            const ev = stageChanged("interview", "rejected");
            for (let i = 0; i < 4; i += 1) {
                expect((await processCandidateCommunicationEntry(redis, entry("1-4", ev))).outcome).toBe("RETRY");
            }
            expect(redis.acked).toEqual([]);
            expect((await processCandidateCommunicationEntry(redis, entry("1-4", ev))).outcome).toBe("DEAD_LETTERED");
            expect(redis.acked).toEqual(["1-4"]);
            expect(redis.deadLetters[0].stream).toBe(CANDIDATE_COMMS_DEAD_LETTER);
            expect(redis.deadLetters[0].fields).toEqual(expect.arrayContaining(["eventId", ev.id, "code", "P1001"]));
        } finally {
            db.application.findFirst.mockImplementation(original);
        }
        expect(JSON.stringify(logCalls)).not.toMatch(/zoe@example\.com/);
    });
});

describe("startCandidateCommunicationConsumer", () => {
    it("does not start under test, without the worker switch, or without redis", () => {
        const redisFactory = jest.fn();
        expect(startCandidateCommunicationConsumer({ env: { NODE_ENV: "test", HR_CANDIDATE_COMMS_WORKER_ENABLED: "true", REDIS_URL: "redis://x" }, redisFactory }).enabled).toBe(false);
        expect(startCandidateCommunicationConsumer({ env: { HR_CANDIDATE_COMMS_WORKER_ENABLED: "1", REDIS_URL: "redis://x" }, redisFactory }).enabled).toBe(false);
        expect(startCandidateCommunicationConsumer({ env: { HR_CANDIDATE_COMMS_WORKER_ENABLED: "true" }, redisFactory }).enabled).toBe(false);
        expect(redisFactory).not.toHaveBeenCalled();
    });
});
