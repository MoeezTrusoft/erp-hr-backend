// Recruitment Phase 2 — the candidate communication catalogue: which event maps
// to which template (most map to nothing), and what a template may render.
import { describe, it, expect } from "@jest/globals";

const {
    CANDIDATE_COMMUNICATION_TEMPLATES,
    EVENTS,
    getCommunicationTemplate,
    isReinstatement,
    listCommunicationTemplateSummaries,
    templateForEvent,
} = await import("../../../src/services/candidate-communication.templates.js");

const stage = (fromStage, toStage) => templateForEvent(EVENTS.APPLICATION_STAGE_CHANGED, { fromStage, toStage })?.id ?? null;

describe("templateForEvent", () => {
    it("maps each candidate-relevant event to its template", () => {
        expect(templateForEvent(EVENTS.APPLICATION_CREATED, {}).id).toBe("application.received");
        expect(templateForEvent(EVENTS.INTERVIEW_SCHEDULED, {}).id).toBe("interview.scheduled");
        expect(templateForEvent(EVENTS.INTERVIEW_RESCHEDULED, {}).id).toBe("interview.rescheduled");
        expect(templateForEvent(EVENTS.INTERVIEW_CANCELLED, {}).id).toBe("interview.cancelled");
        expect(templateForEvent(EVENTS.OFFER_SENT, {}).id).toBe("offer.sent");
        expect(templateForEvent(EVENTS.REQUISITION_CLOSED, {}).id).toBe("requisition.closed");
    });

    it("maps stage changes the candidate can see", () => {
        expect(stage("applied", "screening")).toBe("application.stage.screening");
        expect(stage("interview", "rejected")).toBe("application.rejected");
        expect(stage("rejected", "screening")).toBe("application.stage.screening");
    });

    it("sends nothing when the candidate withdrew", () => {
        expect(stage("screening", "withdrawn")).toBeNull();
        expect(stage("offer", "withdrawn")).toBeNull();
    });

    it("sends nothing for internal-only moves or moves the candidate cannot see", () => {
        expect(stage("screening", "on_hold")).toBeNull();
        expect(stage("on_hold", "screening")).toBeNull();
        // interview is announced by interview.scheduled, offer by offer.sent,
        // hired by onboarding.
        expect(stage("screening", "interview")).toBeNull();
        expect(stage("interview", "offer")).toBeNull();
        expect(stage("offer", "hired")).toBeNull();
        expect(stage("applied", "")).toBeNull();
    });

    it("maps internal and unrelated events to nothing", () => {
        for (const name of [
            "hr.recruitment.offer_created.v1",
            "hr.recruitment.offer_updated.v1",
            "hr.recruitment.offer_accepted.v1",
            "hr.recruitment.offer_withdrawn.v1",
            "hr.recruitment.interview_outcome_recorded.v1",
            "hr.recruitment.interview_reschedule_requested.v1",
            "hr.recruitment.interview_updated.v1",
            "hr.recruitment.requisition_posted.v1",
            "hr.recruitment.candidate_communication_sent.v1",
            "hr.leave.approved.v1",
        ]) {
            expect(templateForEvent(name, {})).toBeNull();
        }
    });

    it("recognises a reinstatement out of rejected", () => {
        expect(isReinstatement({ fromStage: "rejected", toStage: "screening" })).toBe(true);
        expect(isReinstatement({ fromStage: "screening", toStage: "rejected" })).toBe(false);
        expect(isReinstatement({ fromStage: "rejected", toStage: "rejected" })).toBe(false);
    });
});

describe("buildData", () => {
    const context = {
        candidate: { firstName: "Zoe", lastName: "Khan", email: "zoe@example.com", phone: "+92 300 0000000" },
        requisition: { title: "Sales Lead", notes: "internal" },
        settings: { companyName: "Trusoft" },
        application: { stage: "rejected", dispositionReason: "MINIMUM_REQUIREMENTS_NOT_MET" },
        offer: { status: "SENT", salary: "250000" },
        interview: {
            scheduledAt: new Date("2026-11-02T10:00:00Z"),
            durationMinutes: 45,
            interviewType: "TECHNICAL",
            notes: "Ask about the gap year",
            interviewers: [{ name: "Ali" }],
        },
        previousScheduledAt: "2026-11-01T10:00:00Z",
        statusPageUrl: "https://careers.example.com/status",
        personalNote: "Looking forward to it",
        reason: "MINIMUM_REQUIREMENTS_NOT_MET",
    };
    const INTERNAL_STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected", "on_hold", "withdrawn"];

    it.each(Object.keys(CANDIDATE_COMMUNICATION_TEMPLATES))("%s renders no contact detail, internal stage or reason code", (id) => {
        const data = getCommunicationTemplate(id).buildData(context);
        const json = JSON.stringify(data);
        expect(json).not.toMatch(/zoe@example\.com|\+92 300|Khan/);
        expect(json).not.toMatch(/MINIMUM_REQUIREMENTS_NOT_MET|Ask about|Ali|250000|internal/);
        for (const value of Object.values(data)) {
            if (typeof value === "string") expect(INTERNAL_STAGES).not.toContain(value);
        }
        expect(Object.keys(data)).not.toEqual(expect.arrayContaining(["email"]));
        expect(data.candidateFirstName).toBe("Zoe");
        expect(data.jobTitle).toBe("Sales Lead");
        expect(data.companyName).toBe("Trusoft");
        expect(data.statusPageUrl).toBe(context.statusPageUrl);
    });

    it("projects the status through the candidate-visible vocabulary", () => {
        expect(getCommunicationTemplate("application.rejected").buildData(context).candidateStatus).toBe("CLOSED");
        expect(getCommunicationTemplate("application.stage.screening").buildData(context).candidateStatusLabel).toBe("Under Review");
        expect(getCommunicationTemplate("requisition.closed").buildData(context).candidateStatus).toBe("CLOSED");
        expect(getCommunicationTemplate("offer.sent").buildData(context).candidateStatus).toBe("OFFER");
    });

    it("renders interview time and type only", () => {
        const data = getCommunicationTemplate("interview.rescheduled").buildData(context);
        expect(data).toMatchObject({
            interviewAt: "2026-11-02T10:00:00.000Z",
            interviewDurationMinutes: 45,
            interviewType: "Technical interview",
            previousInterviewAt: "2026-11-01T10:00:00.000Z",
        });
    });

    it("carries the personal note only on templates that take one", () => {
        expect(getCommunicationTemplate("offer.sent").buildData(context).personalNote).toBe("Looking forward to it");
        expect(getCommunicationTemplate("general.update").buildData(context).personalNote).toBe("Looking forward to it");
        expect(getCommunicationTemplate("application.rejected").buildData(context).personalNote).toBeUndefined();
    });

    it("tolerates an empty context", () => {
        const data = getCommunicationTemplate("interview.scheduled").buildData({});
        expect(data).toMatchObject({ candidateFirstName: null, jobTitle: null, interviewAt: null, interviewType: null });
    });
});

describe("catalogue", () => {
    it("is frozen and lists without functions", () => {
        expect(Object.isFrozen(CANDIDATE_COMMUNICATION_TEMPLATES)).toBe(true);
        const summaries = listCommunicationTemplateSummaries();
        expect(summaries.map((t) => t.id)).toEqual(expect.arrayContaining(["application.rejected", "general.update"]));
        expect(JSON.stringify(summaries)).not.toMatch(/hubTemplateId|function/);
        expect(summaries.find((t) => t.id === "general.update")).toMatchObject({ category: "MANUAL", manual: true });
    });

    it("skips the acknowledgement for portal applications", () => {
        const received = getCommunicationTemplate("application.received");
        expect(received.appliesTo({ portalIntake: true })).toBe(false);
        expect(received.appliesTo({ portalIntake: false })).toBe(true);
    });

    it("returns null for an unknown template id", () => {
        expect(getCommunicationTemplate("nope")).toBeNull();
        expect(getCommunicationTemplate("constructor")).toBeNull();
    });
});
