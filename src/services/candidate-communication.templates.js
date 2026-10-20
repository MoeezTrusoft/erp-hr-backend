// src/services/candidate-communication.templates.js
//
// Recruitment Phase 2 — the catalogue of candidate-facing messages.
//
// Every recruitment event a candidate should hear about maps to ONE template
// here; most events map to nothing. The catalogue is pure (no DB, no I/O) so
// the mapping and the data a template may render are pinned by unit tests:
//
//   * templateForEvent(eventName, payload) picks the template from the event
//     alone (ids and stage names). It returns null for internal-only moves
//     (on_hold, a parking state the candidate never sees), for moves that do
//     not change what the candidate sees (on_hold -> screening is still
//     "Under Review"), and for a withdrawal by the candidate.
//   * buildData(context) returns ONLY what the hub template renders: first
//     name, job title, company name, the candidate-facing status, the
//     interview time and type, and the portal status page. Never the email or
//     phone (the hub gets the address as the recipient, not as data), never an
//     internal stage name, reason code, interviewer or recruiter note. Stages
//     go through candidateStatusView, the one candidate-visible vocabulary.
//
// The move to the interview stage has its own template but no event: the
// workflow only enters that stage once an interview is scheduled, and the
// interview.scheduled message already tells the candidate (two mails in the
// same second would say the same thing). Recruiters can still send it by hand.
import { projectCandidateStatus } from "../lib/candidateStatusView.js";

export const COMMUNICATION_CATEGORIES = Object.freeze(["STATUS", "INTERVIEW", "OFFER", "REJECTION", "MANUAL"]);

export const EVENTS = Object.freeze({
    APPLICATION_CREATED: "hr.recruitment.application_created.v1",
    APPLICATION_STAGE_CHANGED: "hr.recruitment.application_stage_changed.v1",
    INTERVIEW_SCHEDULED: "hr.recruitment.interview_scheduled.v1",
    INTERVIEW_RESCHEDULED: "hr.recruitment.interview_rescheduled.v1",
    INTERVIEW_CANCELLED: "hr.recruitment.interview_cancelled.v1",
    OFFER_SENT: "hr.recruitment.offer_sent.v1",
    REQUISITION_CLOSED: "hr.recruitment.requisition_closed.v1",
});

// The interview type a candidate may see. Unknown types render as null rather
// than leaking an enum the template has no copy for.
const INTERVIEW_TYPE_LABELS = Object.freeze({
    PHONE_SCREEN: "Phone screen",
    TECHNICAL: "Technical interview",
    BEHAVIORAL: "Behavioural interview",
    PANEL: "Panel interview",
    FINAL: "Final interview",
    ONSITE: "On-site interview",
    VIDEO: "Video interview",
});

const isoOrNull = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const textOrNull = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text || null;
};

// The candidate-facing status for an internal stage. `stage` is never copied
// into the data itself; only its projection is.
function candidateStatus(stage, offerStatus) {
    const view = projectCandidateStatus({ stage }, { offerStatus });
    return view ? { candidateStatus: view.status, candidateStatusLabel: view.label } : { candidateStatus: null, candidateStatusLabel: null };
}

// The fields every template renders.
function baseData(context = {}, stage) {
    return {
        candidateFirstName: textOrNull(context.candidate?.firstName),
        jobTitle: textOrNull(context.requisition?.title),
        companyName: textOrNull(context.settings?.companyName),
        ...candidateStatus(stage ?? context.application?.stage, context.offer?.status),
        statusPageUrl: textOrNull(context.statusPageUrl),
    };
}

function interviewData(context = {}) {
    const interview = context.interview ?? {};
    return {
        interviewAt: isoOrNull(interview.scheduledAt),
        interviewDurationMinutes: Number.isInteger(interview.durationMinutes) ? interview.durationMinutes : null,
        interviewType: INTERVIEW_TYPE_LABELS[interview.interviewType] ?? null,
    };
}

const withNote = (data, context) => {
    const note = textOrNull(context?.personalNote);
    return note ? { ...data, personalNote: note } : data;
};

const template = (def) => Object.freeze({ ...def, events: Object.freeze([...(def.events ?? [])]) });

const CATALOGUE = Object.freeze({
    "application.received": template({
        id: "application.received",
        category: "STATUS",
        events: [EVENTS.APPLICATION_CREATED],
        hubTemplateId: "hr.recruitment.candidate_application_received",
        description: "Acknowledges an application a recruiter added (portal applicants already get the portal confirmation)",
        manual: true,
        // The public portal confirms its own applications (with the status
        // link), so an event-driven acknowledgement would be a second mail.
        appliesTo: (context) => !context?.portalIntake,
        buildData: (context) => baseData(context, "applied"),
    }),
    "application.stage.screening": template({
        id: "application.stage.screening",
        category: "STATUS",
        events: [EVENTS.APPLICATION_STAGE_CHANGED],
        hubTemplateId: "hr.recruitment.candidate_under_review",
        description: "The application is under review",
        manual: true,
        manualStages: ["screening", "on_hold"],
        buildData: (context) => baseData(context, "screening"),
    }),
    "application.stage.interview": template({
        id: "application.stage.interview",
        category: "STATUS",
        events: [],
        hubTemplateId: "hr.recruitment.candidate_interview_stage",
        description: "The application moved to the interview stage (manual only: interview.scheduled covers the event)",
        manual: true,
        manualStages: ["interview"],
        buildData: (context) => baseData(context, "interview"),
    }),
    "application.rejected": template({
        id: "application.rejected",
        category: "REJECTION",
        events: [EVENTS.APPLICATION_STAGE_CHANGED],
        hubTemplateId: "hr.recruitment.candidate_application_closed",
        description: "The application was not successful (sent after the tenant's rejection delay; cancelled if reinstated)",
        manual: false,
        buildData: (context) => baseData(context, "rejected"),
    }),
    "interview.scheduled": template({
        id: "interview.scheduled",
        category: "INTERVIEW",
        events: [EVENTS.INTERVIEW_SCHEDULED],
        hubTemplateId: "hr.recruitment.candidate_interview_scheduled",
        description: "An interview was scheduled (time and type only)",
        manual: false,
        buildData: (context) => ({ ...baseData(context, "interview"), ...interviewData(context) }),
    }),
    "interview.rescheduled": template({
        id: "interview.rescheduled",
        category: "INTERVIEW",
        events: [EVENTS.INTERVIEW_RESCHEDULED],
        hubTemplateId: "hr.recruitment.candidate_interview_rescheduled",
        description: "An interview moved to a new time",
        manual: false,
        buildData: (context) => ({
            ...baseData(context, "interview"),
            ...interviewData(context),
            previousInterviewAt: isoOrNull(context?.previousScheduledAt),
        }),
    }),
    "interview.cancelled": template({
        id: "interview.cancelled",
        category: "INTERVIEW",
        events: [EVENTS.INTERVIEW_CANCELLED],
        hubTemplateId: "hr.recruitment.candidate_interview_cancelled",
        description: "An interview was cancelled (the reason code stays internal)",
        manual: false,
        buildData: (context) => ({ ...baseData(context), ...interviewData(context) }),
    }),
    "offer.sent": template({
        id: "offer.sent",
        category: "OFFER",
        events: [EVENTS.OFFER_SENT],
        hubTemplateId: "hr.recruitment.candidate_offer_sent",
        description: "An offer is waiting for the candidate (no compensation in the message; a recruiter may add a personal note)",
        manual: true,
        manualStages: ["offer"],
        personalNote: true,
        buildData: (context) => withNote(baseData(context, "offer"), context),
    }),
    "requisition.closed": template({
        id: "requisition.closed",
        category: "STATUS",
        events: [EVENTS.REQUISITION_CLOSED],
        hubTemplateId: "hr.recruitment.candidate_position_closed",
        description: "The position closed while the application was still open",
        manual: false,
        buildData: (context) => baseData(context, "rejected"),
    }),
    "general.update": template({
        id: "general.update",
        category: "MANUAL",
        events: [],
        hubTemplateId: "hr.recruitment.candidate_general_update",
        description: "A recruiter's update about the application, with an optional personal note",
        manual: true,
        personalNote: true,
        buildData: (context) => withNote(baseData(context), context),
    }),
});

export const CANDIDATE_COMMUNICATION_TEMPLATES = CATALOGUE;

/** The template for an id, or null. */
export function getCommunicationTemplate(templateId) {
    return Object.prototype.hasOwnProperty.call(CATALOGUE, templateId) ? CATALOGUE[templateId] : null;
}

/** The catalogue as the templates tool lists it (no functions). */
export function listCommunicationTemplateSummaries() {
    return Object.values(CATALOGUE).map((t) => ({
        id: t.id,
        category: t.category,
        events: [...t.events],
        description: t.description,
        manual: Boolean(t.manual),
        personalNote: Boolean(t.personalNote),
    }));
}

const stageOf = (value) => String(value ?? "").trim().toLowerCase();
const visibleOf = (stage) => projectCandidateStatus({ stage })?.status ?? null;

/**
 * True when a stage change takes an application OUT of rejected: the queued
 * rejection message for it must be cancelled.
 */
export function isReinstatement(payload = {}) {
    const from = stageOf(payload.fromStage);
    const to = stageOf(payload.toStage);
    return from === "rejected" && Boolean(to) && to !== "rejected";
}

function templateForStageChange(payload = {}) {
    const from = stageOf(payload.fromStage);
    const to = stageOf(payload.toStage);
    if (!to || to === "withdrawn") return null; // the candidate withdrew: no message
    // Nothing the candidate can see changed (on_hold is "Under Review" too).
    if (from && visibleOf(from) === visibleOf(to)) return null;
    if (to === "screening") return CATALOGUE["application.stage.screening"];
    if (to === "rejected") return CATALOGUE["application.rejected"];
    // interview: interview.scheduled; offer: offer.sent; hired: onboarding;
    // on_hold: internal only.
    return null;
}

/**
 * The template an event maps to, or null (most events map to nothing).
 * @param {string} eventName
 * @param {object} [payload]  the event's ids-only payload
 */
export function templateForEvent(eventName, payload = {}) {
    switch (eventName) {
        case EVENTS.APPLICATION_CREATED:
            return CATALOGUE["application.received"];
        case EVENTS.APPLICATION_STAGE_CHANGED:
            return templateForStageChange(payload);
        case EVENTS.INTERVIEW_SCHEDULED:
            return CATALOGUE["interview.scheduled"];
        case EVENTS.INTERVIEW_RESCHEDULED:
            return CATALOGUE["interview.rescheduled"];
        case EVENTS.INTERVIEW_CANCELLED:
            return CATALOGUE["interview.cancelled"];
        case EVENTS.OFFER_SENT:
            return CATALOGUE["offer.sent"];
        case EVENTS.REQUISITION_CLOSED:
            return CATALOGUE["requisition.closed"];
        default:
            return null;
    }
}

/** The event names the consumer acts on (mapped or reinstatement-relevant). */
export const HANDLED_EVENT_NAMES = Object.freeze(Object.values(EVENTS));
