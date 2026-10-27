// Recruitment Phase 7 (A15) — two candidate message fixes in the hr:events
// consumer.
//   (a) An application created by accepting a nurture (role) invitation gets no
//       "application received": the acceptance already confirmed it. The
//       marker is the acceptance intake's own (TALENT_POOL + "nurture:<run>")
//       backed by an invitation of that run for that candidate and role; a
//       recruiter-added application, even with the same channel, still gets it.
//   (b) Reception checking a candidate in for an on-site test
//       (candidate_checked_in) sends assessment.arrival: first name, role,
//       company, interview time and type, never the ID, accommodations or site.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb, createRecordingLogger } from "./candidate-communication.fakes.js";

const { db, store } = createFakeDb();
const { logger } = createRecordingLogger();
const getRecruitmentSettings = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidate-verification.service.js", () => ({ PORTAL_STATUS_REQUEST_PATH: "/status" }));

const { handleCandidateCommunicationEvent } = await import("../../../src/services/candidate-communication.consumer.js");
const { templateForEvent, getCommunicationTemplate } = await import("../../../src/services/candidate-communication.templates.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-27T09:00:00Z");
let seq = 0;
const envelope = (name, payload) => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    name,
    tenantId: TENANT,
    occurredAt: NOW.toISOString(),
    payload,
});
const application = (over = {}) => ({
    id: 901,
    tenantId: TENANT,
    candidateId: 77,
    jobRequisitionId: 9,
    stage: "applied",
    sourceChannel: null,
    sourceDetail: null,
    candidate: { id: 77, firstName: "Zoe" },
    jobRequisition: { id: 9, title: "Sales Lead" },
    offer: null,
    ...over,
});
const created = (applicationId) => handleCandidateCommunicationEvent(
    envelope("hr.recruitment.application_created.v1", { applicationId: String(applicationId), candidateId: "77" }),
    { now: NOW },
);

beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
    getRecruitmentSettings.mockResolvedValue({ companyName: "Trusoft", portalBaseUrl: "https://careers.example.com/" });
    store.candidates.push({ id: 77, tenantId: TENANT, firstName: "Zoe", email: "zoe@example.com" });
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_COMMUNICATIONS;
});

describe("A15a — no application received for an accepted invitation", () => {
    it("skips the application an accepted nurture invitation created", async () => {
        store.applications.push(application({ sourceChannel: "TALENT_POOL", sourceDetail: "nurture:12" }));
        store.invitations.push({ id: 3, tenantId: TENANT, candidateId: 77, jobRequisitionId: 9, nurtureRunId: 12, status: "ACCEPTED" });
        const result = await created(901);
        expect(result.outcome).toBe("NO_MESSAGE");
        expect(store.communications).toHaveLength(0);
        // Every read ran under the event's tenant.
        expect(db.contextLog.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });

    it("still acknowledges a recruiter-added application, even a talent pool one", async () => {
        store.applications.push(
            application({ id: 1 }),
            application({ id: 2, sourceChannel: "TALENT_POOL", sourceDetail: null }),
            // A typed detail with no invitation behind it does not mute the message.
            application({ id: 3, sourceChannel: "TALENT_POOL", sourceDetail: "nurture:12" }),
            // Another run's invitation, another role, or another tenant's row is no marker.
            application({ id: 4, sourceChannel: "TALENT_POOL", sourceDetail: "nurture:13", jobRequisitionId: 10 }),
        );
        store.invitations.push(
            { id: 5, tenantId: TENANT, candidateId: 77, jobRequisitionId: 9, nurtureRunId: 13, status: "ACCEPTED" },
            { id: 6, tenantId: OTHER, candidateId: 77, jobRequisitionId: 10, nurtureRunId: 13, status: "ACCEPTED" },
        );
        for (const id of [1, 2, 3, 4]) expect((await created(id)).outcome).toBe("QUEUED");
        expect(store.communications.map((r) => [r.applicationId, r.templateId])).toEqual([
            [1, "application.received"],
            [2, "application.received"],
            [3, "application.received"],
            [4, "application.received"],
        ]);
    });

    it("portal intakes are still left to the portal's own confirmation", async () => {
        store.applications.push(application());
        store.history.push({ id: 1, tenantId: TENANT, applicationId: 901, source: "public-portal" });
        expect((await created(901)).outcome).toBe("NO_MESSAGE");
    });
});

describe("A15b — the on-site assessment arrival message", () => {
    const checkedIn = (over = {}) => envelope("hr.recruitment.candidate_checked_in.v1", {
        checkInId: "61", interviewId: "351", applicationId: "901", candidateId: "77", recruiterId: "4", interviewerIds: ["8"], ...over,
    });

    it("maps the check-in event to assessment.arrival", () => {
        expect(templateForEvent("hr.recruitment.candidate_checked_in.v1")?.id).toBe("assessment.arrival");
        expect(getCommunicationTemplate("assessment.arrival")).toMatchObject({
            category: "INTERVIEW",
            hubTemplateId: "hr.recruitment.candidate_assessment_arrival",
            manual: false,
        });
    });

    it("queues the arrival message with the role, company and interview time only", async () => {
        store.applications.push(application({ stage: "interview" }));
        store.interviews.push({
            id: 351, tenantId: TENANT, applicationId: 901, status: "SCHEDULED", location: "Lahore office, floor 3",
            scheduledAt: new Date("2026-10-27T09:30:00Z"), durationMinutes: 60, interviewType: "ONSITE",
        });
        const result = await handleCandidateCommunicationEvent(checkedIn(), { now: NOW });
        expect(result.outcome).toBe("QUEUED");
        const [row] = store.communications;
        expect(row).toMatchObject({ templateId: "assessment.arrival", category: "INTERVIEW", applicationId: 901, candidateId: 77, scheduledFor: NOW });
        expect(row.data).toMatchObject({
            candidateFirstName: "Zoe",
            jobTitle: "Sales Lead",
            companyName: "Trusoft",
            interviewAt: "2026-10-27T09:30:00.000Z",
            interviewType: "On-site interview",
        });
        expect(JSON.stringify(row.data)).not.toMatch(/Lahore|idLast4|CNIC|accommodation|"8"|recruiter/i);

        // Redelivery is a no-op.
        const again = await handleCandidateCommunicationEvent({ ...checkedIn(), id: row.eventId }, { now: NOW });
        expect(again.outcome).toBe("DUPLICATE");
        expect(store.communications).toHaveLength(1);
    });

    it("sends nothing for a cancelled interview, a withdrawn application or another tenant's interview", async () => {
        store.applications.push(application({ stage: "interview" }), application({ id: 902, stage: "withdrawn" }));
        store.interviews.push(
            { id: 351, tenantId: TENANT, applicationId: 901, status: "CANCELLED", scheduledAt: NOW, interviewType: "ONSITE" },
            { id: 352, tenantId: TENANT, applicationId: 902, status: "SCHEDULED", scheduledAt: NOW, interviewType: "ONSITE" },
            { id: 353, tenantId: OTHER, applicationId: 901, status: "SCHEDULED", scheduledAt: NOW, interviewType: "ONSITE" },
        );
        for (const interviewId of ["351", "352", "353"]) {
            expect((await handleCandidateCommunicationEvent(checkedIn({ interviewId }), { now: NOW })).outcome).toBe("NO_MESSAGE");
        }
        expect(store.communications).toHaveLength(0);
    });

    it("is dropped while the communications flag is off", async () => {
        delete process.env.HR_RECRUITMENT_COMMUNICATIONS;
        expect((await handleCandidateCommunicationEvent(checkedIn(), { now: NOW })).outcome).toBe("FLAG_OFF");
    });
});
