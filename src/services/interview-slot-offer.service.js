// src/services/interview-slot-offer.service.js
//
// Recruitment Phase 3a — candidate SELF-SCHEDULING.
//
//   propose   the recruiter picks a panel; the slot finder (lib/slot-finder
//             .util.js) proposes three to five times where the whole panel is
//             free: calendar free-busy (when the calendarSync flag is on and
//             the Communication module answers), the panel's own scheduled
//             interviews, approved leave and work schedules. A preview by
//             default; `save` keeps it as a PROPOSED slot offer to edit/send.
//   send      re-checks every slot against the same availability gate the
//             schedule path uses, issues a random token (only its sha256 is
//             stored), sets SENT with expiresAt = now + slotOfferValidityHours
//             and emails the candidate the choose link. ONE live offer per
//             application: sending cancels any other PROPOSED or SENT offer.
//   confirm   the candidate picks one slot through the portal. The panel's
//             availability is re-checked for that slot; if it is gone, the
//             answer is a uniform "pick another" and the offer stays SENT.
//             Otherwise, in ONE transaction: the offer becomes CONFIRMED (a
//             guarded update, so two confirms of one offer create one
//             interview) and the interview is created through the recruiter's
//             own schedule path (scheduleInterviewInTransaction: leave gate,
//             contact gate, stage move, interview_scheduled event, calendar
//             CREATE mark) with source "candidate.self_schedule".
//   expire    a job turns SENT offers past expiresAt into EXPIRED.
//   decline   Phase 6 — the candidate declines EVERY offered slot from the same
//             link, with an optional coded reason (SLOT_DECLINE_REASONS). The
//             offer becomes CANCELLED with cancelReason "CANDIDATE_DECLINED" or
//             "CANDIDATE_DECLINED:<code>" (no new column: the status CHECK
//             already has CANCELLED), the link stops working, and the
//             recruiter hears of it through hr.recruitment.interview_slots_
//             declined.v1 (ids and the code only). Unknown, expired, used or
//             cancelled links are the same null as for read and confirm.
//
// Public surface rules (the portal routes): the token is looked up under
// SYSTEM context (the caller is anonymous and has no tenant), then everything
// else runs under the offer's own tenant, which must be the portal's pinned
// tenant. Unknown, expired, cancelled and confirmed tokens are all the same
// `null`. The candidate sees the job title, the slots, the panel's FIRST
// names and their own first name: nothing about other candidates, no
// internal ids, no notes.
//
// Contact rules: sending refuses a do-not-contact candidate (409
// HR-RECRUITMENT-CANDIDATE-DNC, without the address) and a candidate who
// withdrew consent; the email goes through the Notification Hub, fail-soft.
// Every event is ids only.
import { createHash, randomBytes } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { scopedEmployeeWhere, withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { RECRUITMENT_SCOPE, applicationScopeWhere } from "../lib/recruitmentAccess.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { blockedInterviewers } from "../lib/interviewScheduling.js";
import {
    SLOT_FINDER_DEFAULTS,
    findCommonSlots,
    isValidTimeZone,
    leaveRowToInterval,
    normalizeIntervals,
    overlaps,
} from "../lib/slot-finder.util.js";
import { RECRUITMENT_SETTINGS_DEFAULTS, getRecruitmentSettings } from "./recruitment-settings.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { freeBusy } from "./communication-calendar.client.js";
import { scheduleInterviewInTransaction } from "./interview.service.js";

const log = logger.child({ component: "interview-slot-offer" });

export const SLOT_OFFER_STATUS = Object.freeze({
    PROPOSED: "PROPOSED",
    SENT: "SENT",
    CONFIRMED: "CONFIRMED",
    EXPIRED: "EXPIRED",
    CANCELLED: "CANCELLED",
});
const OPEN_STATUSES = Object.freeze([SLOT_OFFER_STATUS.PROPOSED, SLOT_OFFER_STATUS.SENT]);

// An offer is made for an application a recruiter is still assessing.
export const INTERVIEWABLE_STAGES = Object.freeze(["applied", "screening", "interview"]);
export const INTERVIEW_TYPES = Object.freeze(["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"]);

export const SELF_SCHEDULE_SOURCE = "candidate.self_schedule";
// The careers portal page that renders the slot choice (the token alone
// identifies the offer).
export const PORTAL_SLOT_CHOICE_PATH = "/interviews/choose";
export const SLOT_OFFER_TEMPLATE_ID = "hr.recruitment.interview_slot_offer";

export const SLOT_OFFER_EVENTS = Object.freeze({
    OFFERED: "hr.recruitment.interview_slots_offered.v1",
    CONFIRMED: "hr.recruitment.interview_slot_confirmed.v1",
    EXPIRED: "hr.recruitment.interview_slot_offer_expired.v1",
    CANCELLED: "hr.recruitment.interview_slot_offer_cancelled.v1",
    // Phase 6 — the candidate declined every offered slot. A separate event
    // (not CANCELLED) so the recruiter is told and nothing tells the
    // candidate their own decline was a withdrawal.
    DECLINED: "hr.recruitment.interview_slots_declined.v1",
});

// Phase 6 — the coded reasons a candidate may give for declining every slot.
// Codes only: a free-text note from an anonymous link would be unvetted text
// in front of a recruiter.
export const SLOT_DECLINE_REASONS = Object.freeze(["NONE_SUIT", "NO_LONGER_INTERESTED", "ACCEPTED_OTHER_OFFER", "OTHER"]);
export const CANDIDATE_DECLINED = "CANDIDATE_DECLINED";

const MAX_PANEL = 10;
const MAX_SLOTS = 10; // the interview_slot_offers_slots_check bound
const MAX_LOCATION = 500;
const MAX_REASON = 500;
const DEFAULT_SEARCH_DAYS = 30; // the outer bound of a free-busy query when no `to` is given
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const WEEKDAY_KEYS = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const slotUnavailable = () =>
    fail("This time is no longer available, please pick another", 409, "HR-RECRUITMENT-SLOT-UNAVAILABLE");

const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const trimSlash = (value) => String(value ?? "").trim().replace(/\/+$/, "");

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const toDate = (value) => {
    if (value == null || value === "") return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

// ── Events (ids only) ────────────────────────────────────────────────────────

/** One builder for the four slot offer events; null when the row has no tenant. */
export function slotOfferEvent(eventName, offer, { candidateId = null, actorId = null, ...extra } = {}) {
    if (!offer?.tenantId) return null;
    return {
        eventName,
        tenantId: offer.tenantId,
        aggregateType: "InterviewSlotOffer",
        aggregateId: offer.id,
        actorId,
        payload: {
            slotOfferId: String(offer.id),
            applicationId: String(offer.applicationId),
            requisitionId: offer.requisitionId != null ? String(offer.requisitionId) : null,
            candidateId: candidateId != null ? String(candidateId) : null,
            ...extra,
        },
    };
}

// ── Input validation ─────────────────────────────────────────────────────────

function requireTenant(tenantId) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
}

// Proposing, sending and cancelling are recruiter decisions: ORG, or a
// hiring manager on their own requisition (applicationScopeWhere narrows).
function requireRecruiter(scope) {
    if (scope && !scope.unrestricted && scope.level !== RECRUITMENT_SCOPE.MANAGED) {
        throw fail("Only recruiters and the requisition's hiring manager can offer interview slots", 403, "HR-RECRUITMENT-SLOT-FORBIDDEN");
    }
}

function normalizePanel(interviewerIds) {
    const ids = [...new Set((Array.isArray(interviewerIds) ? interviewerIds : []).map(positiveInt))];
    if (!ids.length || ids.includes(null)) {
        throw fail("interviewerIds must list one or more employee ids", 400, "HR-RECRUITMENT-SLOT-PANEL-REQUIRED");
    }
    if (ids.length > MAX_PANEL) throw fail(`A panel has at most ${MAX_PANEL} interviewers`, 400, "HR-RECRUITMENT-SLOT-PANEL-REQUIRED");
    return ids;
}

function normalizeType(interviewType) {
    const type = String(interviewType ?? "PANEL").trim().toUpperCase();
    if (!INTERVIEW_TYPES.includes(type)) throw fail(`Unknown interview type "${type}"`, 400, "HR-RECRUITMENT-SLOT-TYPE-INVALID");
    return type;
}

function normalizeDuration(durationMinutes) {
    const n = Number(durationMinutes ?? 60);
    if (!Number.isInteger(n) || n < SLOT_FINDER_DEFAULTS.minDurationMinutes || n > SLOT_FINDER_DEFAULTS.maxDurationMinutes) {
        throw fail("durationMinutes must be a whole number from 15 to 480", 400, "HR-RECRUITMENT-SLOT-DURATION-INVALID");
    }
    return n;
}

function normalizeLocation(location) {
    const text = location == null ? "" : String(location).trim();
    if (text.length > MAX_LOCATION) throw fail(`location must be at most ${MAX_LOCATION} characters`, 400, "HR-RECRUITMENT-SLOT-LOCATION-INVALID");
    return text || null;
}

/** [{ start }] or [ISO] -> sorted, de-duplicated [{ start, end }] in the future. */
export function normalizeSlots(slots, durationMinutes, now = new Date()) {
    const list = Array.isArray(slots) ? slots : [];
    const starts = new Set();
    for (const slot of list) {
        const start = toDate(typeof slot === "object" && slot !== null ? slot.start : slot);
        if (!start) throw fail("Every slot needs a valid start time", 400, "HR-RECRUITMENT-SLOT-INVALID");
        if (start.getTime() <= new Date(now).getTime()) throw fail("Every slot must be in the future", 400, "HR-RECRUITMENT-SLOT-INVALID");
        starts.add(start.getTime());
    }
    if (!starts.size || starts.size > MAX_SLOTS) {
        throw fail(`Offer between 1 and ${MAX_SLOTS} slots`, 400, "HR-RECRUITMENT-SLOT-INVALID");
    }
    return [...starts].sort((a, b) => a - b).map((ms) => ({
        start: new Date(ms).toISOString(),
        end: new Date(ms + durationMinutes * 60_000).toISOString(),
    }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

const scopedApplicationWhere = (scope) => (scope && !scope.unrestricted ? applicationScopeWhere(scope) : {});

async function loadApplication(db, tenantId, applicationId, scope) {
    const id = positiveInt(applicationId);
    const application = id
        ? await db.application.findFirst({
            where: withTenant(tenantId, { id, ...scopedApplicationWhere(scope) }),
            select: {
                id: true,
                stage: true,
                candidateId: true,
                jobRequisitionId: true,
                jobRequisition: { select: { id: true, title: true } },
                candidate: { select: { id: true, firstName: true, email: true, anonymizedAt: true } },
            },
        })
        : null;
    if (!application) throw fail("Application not found", 404, "HR-RECRUITMENT-APPLICATION-NOT-FOUND");
    if (!INTERVIEWABLE_STAGES.includes(application.stage)) {
        throw fail(`An application at stage "${application.stage}" cannot be offered interview slots`, 409, "HR-RECRUITMENT-SLOT-STAGE-INVALID");
    }
    return application;
}

async function loadPanel(db, tenantId, ids) {
    const rows = await db.employee.findMany({
        where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
        select: { id: true, first_name: true, last_name: true, employee_name: true, work_email: true, email: true },
    });
    if (rows.length !== ids.length) {
        throw fail("Every interviewer must be an employee of this company", 400, "HR-RECRUITMENT-SLOT-PANEL-INVALID");
    }
    return rows;
}

async function loadSettings(tenantId) {
    const settings = await getRecruitmentSettings({ tenantId });
    if (!isValidTimeZone(settings.timeZone)) {
        log.warn({ tenantId }, "slot offer: the tenant time zone is not valid, using the default");
        return { ...settings, timeZone: RECRUITMENT_SETTINGS_DEFAULTS.timeZone };
    }
    return settings;
}

// ── The availability gate ────────────────────────────────────────────────────

/**
 * Everything the gate needs for a panel over [from, to): APPROVED leave, the
 * effective work schedules, and the panel's own SCHEDULED interviews (an
 * interviewer already on another panel is busy, calendar or not).
 */
export async function loadPanelAvailability(db, { tenantId, interviewerIds, from, to }) {
    const ids = interviewerIds;
    const padFrom = new Date(new Date(from).getTime() - DAY_MS);
    const padTo = new Date(new Date(to).getTime() + DAY_MS);
    const [leaveRows, schedules, interviews] = await Promise.all([
        db.leaveRequest.findMany({
            where: withTenant(tenantId, { employeeId: { in: ids }, status: "APPROVED", startDate: { lte: padTo }, endDate: { gte: padFrom } }),
            select: { employeeId: true, startDate: true, endDate: true },
        }),
        db.workSchedule.findMany({
            where: withTenant(tenantId, {
                employeeId: { in: ids },
                effective_start_date: { lte: padTo },
                OR: [{ effective_end_date: null }, { effective_end_date: { gte: padFrom } }],
            }),
            orderBy: { effective_start_date: "desc" },
            select: { employeeId: true, schedule_pattern: true, effective_start_date: true, effective_end_date: true },
        }),
        db.interview.findMany({
            where: withTenant(tenantId, {
                status: "SCHEDULED",
                scheduledAt: { gte: padFrom, lt: padTo },
                interviewers: { some: { employeeId: { in: ids } } },
            }),
            select: { id: true, scheduledAt: true, durationMinutes: true },
        }),
    ]);
    const busy = interviews.map((i) => ({
        start: new Date(i.scheduledAt),
        end: new Date(new Date(i.scheduledAt).getTime() + Number(i.durationMinutes || 60) * 60_000),
    }));
    return { interviewerIds: ids, leaveRows, schedules, busy };
}

function patternAt(schedules, employeeId, at) {
    const t = at.getTime();
    const row = schedules.find((s) =>
        s.employeeId === employeeId &&
        new Date(s.effective_start_date).getTime() <= t &&
        (s.effective_end_date == null || new Date(s.effective_end_date).getTime() >= t));
    return row?.schedule_pattern && typeof row.schedule_pattern === "object" ? row.schedule_pattern : null;
}

// Same weekday rule as interviewSchedule.checkInterviewerAvailability: an
// empty or missing day in the effective pattern is a non-working day; no
// schedule at all is no evidence of a conflict.
function offScheduleInterviewers(availability, start) {
    const dayKey = WEEKDAY_KEYS[start.getDay()];
    return availability.interviewerIds.filter((id) => {
        const pattern = patternAt(availability.schedules, id, start);
        if (!pattern) return false;
        const timing = pattern[dayKey];
        return !(typeof timing === "string" && timing.trim() !== "");
    });
}

/**
 * Why the panel cannot take [start, end), or null when it can. Approved leave
 * and the work schedule are the schedule path's own gate; a candidate cannot
 * pass an override, so the non-working-day warning refuses here.
 */
export function slotConflict(availability, start, end, calendarBusy = []) {
    if (blockedInterviewers(start, end, availability.leaveRows).length) return "LEAVE";
    if (offScheduleInterviewers(availability, start).length) return "NON_WORKING_DAY";
    const s = start.getTime();
    const e = end.getTime();
    if (availability.busy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime()))) return "INTERVIEW";
    if (calendarBusy.some((b) => overlaps(s, e, b.start, b.end))) return "CALENDAR";
    return null;
}

/** The weekdays the slot finder skips: the panel's own off days when every panelist has a schedule, else the tenant default. */
function panelOffWeekdays(availability, at) {
    const patterns = availability.interviewerIds.map((id) => patternAt(availability.schedules, id, at));
    if (patterns.some((p) => !p)) return [...SLOT_FINDER_DEFAULTS.nonWorkingWeekdays];
    const off = new Set();
    WEEKDAY_KEYS.forEach((key, day) => {
        if (patterns.some((p) => !(typeof p[key] === "string" && p[key].trim() !== ""))) off.add(day);
    });
    return [...off];
}

/** Calendar busy intervals when the calendarSync flag is on and the Communication module answers. */
async function calendarBusy({ tenantId, panel, from, to }) {
    if (!isRecruitmentFlagEnabled("calendarSync")) return { checked: false, busy: [] };
    const emailsByEmployeeId = Object.fromEntries(panel.map((e) => [String(e.id), e.work_email || e.email || null]));
    const result = await freeBusy({ tenantId, employeeIds: panel.map((e) => e.id), emailsByEmployeeId, from, to });
    return { checked: result.available === true, busy: result.available ? normalizeIntervals(result.busy) : [] };
}

// ── Views ────────────────────────────────────────────────────────────────────

const OFFER_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    requisitionId: true,
    interviewType: true,
    durationMinutes: true,
    location: true,
    interviewerIds: true,
    slots: true,
    status: true,
    expiresAt: true,
    sentAt: true,
    confirmedAt: true,
    chosenSlotStart: true,
    interviewId: true,
    cancelledAt: true,
    cancelReason: true,
    createdById: true,
    version: true,
    createdAt: true,
    updatedAt: true,
});

/** Phase 6 — the candidate's decline, read back from cancelReason, or null. */
export function candidateDeclineOf(cancelReason) {
    const text = typeof cancelReason === "string" ? cancelReason : "";
    if (text !== CANDIDATE_DECLINED && !text.startsWith(`${CANDIDATE_DECLINED}:`)) return null;
    const code = text.slice(CANDIDATE_DECLINED.length + 1);
    return { reasonCode: SLOT_DECLINE_REASONS.includes(code) ? code : null };
}

/** The recruiter-facing view: never the token hash; the cancel note follows the internal-notes rule. */
export function presentSlotOffer(row, scope = null) {
    if (!row) return null;
    const { tokenHash: _hash, tenantId: _tenant, ...rest } = row;
    const showNotes = !scope || scope.canSeeInternalNotes === true;
    const view = { ...rest, cancelReason: showNotes ? rest.cancelReason ?? null : null };
    // A candidate's decline is a coded fact, not a note: every reader sees it.
    const decline = candidateDeclineOf(rest.cancelReason);
    return decline ? { ...view, declinedByCandidate: true, declineReason: decline.reasonCode } : view;
}

// ── Propose ──────────────────────────────────────────────────────────────────

/**
 * Propose slots for a panel. A preview unless `save` is true, in which case a
 * PROPOSED offer is stored (the recruiter can still edit the set at send).
 */
export async function proposeSlots({
    tenantId, applicationId, interviewerIds, interviewType, durationMinutes, location,
    from, to, count, actorId = null, scope = null, save = false, now = new Date(),
} = {}) {
    requireTenant(tenantId);
    requireRecruiter(scope);
    const ids = normalizePanel(interviewerIds);
    const type = normalizeType(interviewType);
    const duration = normalizeDuration(durationMinutes);
    const place = normalizeLocation(location);
    const at = new Date(now);
    const fromDate = from != null && from !== "" ? toDate(from) : null;
    const toDateValue = to != null && to !== "" ? toDate(to) : null;
    if ((from && !fromDate) || (to && !toDateValue)) throw fail("from and to must be ISO 8601 times", 400, "HR-RECRUITMENT-SLOT-RANGE-INVALID");

    const application = await loadApplication(prisma, tenantId, applicationId, scope);
    const panel = await loadPanel(prisma, tenantId, ids);
    const settings = await loadSettings(tenantId);

    const searchFrom = new Date(Math.max(at.getTime(), fromDate?.getTime() ?? 0));
    const searchTo = toDateValue ?? new Date(at.getTime() + DEFAULT_SEARCH_DAYS * DAY_MS);
    const availability = await loadPanelAvailability(prisma, { tenantId, interviewerIds: ids, from: searchFrom, to: searchTo });
    const calendar = await calendarBusy({ tenantId, panel, from: searchFrom, to: searchTo });

    const slots = findCommonSlots({
        busy: [...availability.busy, ...calendar.busy],
        leave: availability.leaveRows.map((r) => leaveRowToInterval(r, settings.timeZone)).filter(Boolean),
        nonWorkingWeekdays: panelOffWeekdays(availability, searchFrom),
        workdayStart: settings.workdayStart,
        workdayEnd: settings.workdayEnd,
        timeZone: settings.timeZone,
        durationMinutes: duration,
        from: fromDate ?? undefined,
        to: toDateValue ?? undefined,
        now: at,
        count,
        isSlotBlocked: (start, end) => slotConflict(availability, start, end) !== null,
    });

    const draft = {
        applicationId: application.id,
        requisitionId: application.jobRequisitionId,
        interviewType: type,
        durationMinutes: duration,
        location: place,
        interviewerIds: ids,
        slots,
    };
    const meta = { calendarChecked: calendar.checked, timeZone: settings.timeZone };
    if (!save) return { saved: false, ...draft, ...meta };
    if (!slots.length) throw fail("No common free slot was found for this panel; widen the range or change the panel", 409, "HR-RECRUITMENT-SLOT-NONE-FOUND");

    const row = await tenantTransaction(
        prisma,
        async (tx) =>
            await tx.interviewSlotOffer.create({
                data: { tenantId, ...draft, status: SLOT_OFFER_STATUS.PROPOSED, createdById: positiveInt(actorId) },
                select: OFFER_SELECT,
            }),
        { tenantId },
    );
    return { saved: true, ...presentSlotOffer(row, scope), ...meta };
}

// ── Send ─────────────────────────────────────────────────────────────────────

// The DNC refusal never echoes the address; consent withdrawal keeps its own code.
async function assertCandidateContactable(tenantId, application) {
    if (!application.candidate || application.candidate.anonymizedAt) {
        throw fail("This candidate can no longer be contacted", 409, "HR-RECRUITMENT-CANDIDATE-ANONYMIZED");
    }
    try {
        await assertCommunicationsAllowed({ tenantId, candidateId: application.candidateId, purpose: "PROCESSING" });
    } catch (err) {
        if (err?.code === "HR-RECRUITMENT-DNC-BLOCKED") {
            throw fail("This candidate is on the do-not-contact register", 409, "HR-RECRUITMENT-CANDIDATE-DNC");
        }
        throw err;
    }
}

async function resolveSendDraft({ tenantId, slotOfferId, args, scope, now }) {
    if (slotOfferId != null) {
        const id = positiveInt(slotOfferId);
        const offer = id
            ? await prisma.interviewSlotOffer.findFirst({
                where: withTenant(tenantId, { id, ...(scope && !scope.unrestricted ? { application: { is: applicationScopeWhere(scope) } } : {}) }),
                select: OFFER_SELECT,
            })
            : null;
        if (!offer) throw fail("Slot offer not found", 404, "HR-RECRUITMENT-SLOT-OFFER-NOT-FOUND");
        if (offer.status !== SLOT_OFFER_STATUS.PROPOSED) {
            throw fail(`The slot offer is ${offer.status.toLowerCase()} and cannot be sent`, 409, "HR-RECRUITMENT-SLOT-OFFER-NOT-PROPOSED");
        }
        // The recruiter may trim the proposed set at send.
        const slots = normalizeSlots(args.slots ?? offer.slots, offer.durationMinutes, now);
        return { offerId: offer.id, ...offer, slots, interviewerIds: normalizePanel(offer.interviewerIds) };
    }
    const durationMinutesValue = normalizeDuration(args.durationMinutes);
    return {
        offerId: null,
        applicationId: positiveInt(args.applicationId),
        interviewType: normalizeType(args.interviewType),
        durationMinutes: durationMinutesValue,
        location: normalizeLocation(args.location),
        interviewerIds: normalizePanel(args.interviewerIds),
        slots: normalizeSlots(args.slots, durationMinutesValue, now),
    };
}

async function assertSlotsAvailable({ tenantId, draft, panel }) {
    const first = new Date(draft.slots[0].start);
    const last = new Date(draft.slots[draft.slots.length - 1].end);
    const availability = await loadPanelAvailability(prisma, { tenantId, interviewerIds: draft.interviewerIds, from: first, to: last });
    const calendar = await calendarBusy({ tenantId, panel, from: first, to: last });
    const unavailable = draft.slots
        .map((slot) => ({ start: slot.start, reason: slotConflict(availability, new Date(slot.start), new Date(slot.end), calendar.busy) }))
        .filter((s) => s.reason);
    if (unavailable.length) {
        throw fail("Some slots are no longer free for the whole panel", 409, "HR-RECRUITMENT-SLOT-UNAVAILABLE", { unavailable });
    }
}

/** Cancel every other open offer of the application (one live offer each). */
async function supersedeOpenOffers(tx, { tenantId, applicationId, keepId, candidateId, actorId, now }) {
    const open = await tx.interviewSlotOffer.findMany({
        where: withTenant(tenantId, { applicationId, status: { in: [...OPEN_STATUSES] }, ...(keepId ? { id: { not: keepId } } : {}) }),
        select: { id: true, tenantId: true, applicationId: true, requisitionId: true },
    });
    for (const row of open) {
        const { count } = await tx.interviewSlotOffer.updateMany({
            where: withTenant(tenantId, { id: row.id, status: { in: [...OPEN_STATUSES] } }),
            data: { status: SLOT_OFFER_STATUS.CANCELLED, cancelledAt: now, cancelReason: "SUPERSEDED", tokenHash: null, version: { increment: 1 } },
        });
        if (count) await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.CANCELLED, row, { candidateId, actorId, reasonCode: "SUPERSEDED" }));
    }
    return open.length;
}

async function writeSentOffer(tx, { tenantId, draft, application, tokenHash, expiresAt, actorId, now }) {
    const sent = { status: SLOT_OFFER_STATUS.SENT, tokenHash, expiresAt, sentAt: now, slots: draft.slots };
    if (!draft.offerId) {
        return tx.interviewSlotOffer.create({
            data: {
                tenantId,
                applicationId: application.id,
                requisitionId: application.jobRequisitionId,
                interviewType: draft.interviewType,
                durationMinutes: draft.durationMinutes,
                location: draft.location,
                interviewerIds: draft.interviewerIds,
                createdById: positiveInt(actorId),
                ...sent,
            },
            select: OFFER_SELECT,
        });
    }
    const { count } = await tx.interviewSlotOffer.updateMany({
        where: withTenant(tenantId, { id: draft.offerId, status: SLOT_OFFER_STATUS.PROPOSED }),
        data: { ...sent, version: { increment: 1 } },
    });
    if (!count) throw fail("The slot offer is no longer a proposal", 409, "HR-RECRUITMENT-SLOT-OFFER-NOT-PROPOSED");
    return tx.interviewSlotOffer.findFirst({ where: withTenant(tenantId, { id: draft.offerId }), select: OFFER_SELECT });
}

/**
 * Send a slot offer (a saved proposal by slotOfferId, or a set given here).
 * @returns the offer view plus { emailed } — never the token.
 */
export async function sendSlotOffer({ tenantId, slotOfferId = null, actorId = null, scope = null, now = new Date(), ...args } = {}) {
    if (!isRecruitmentFlagEnabled("selfScheduling")) {
        throw fail("Candidate self-scheduling is disabled", 503, "HR-RECRUITMENT-SELF-SCHEDULING-DISABLED");
    }
    requireTenant(tenantId);
    requireRecruiter(scope);
    const at = new Date(now);
    const settings = await loadSettings(tenantId);
    const portalBase = trimSlash(settings.portalBaseUrl || process.env.HR_PORTAL_BASE_URL);
    if (!portalBase) throw fail("Set the careers portal address (portalBaseUrl) before offering slots", 409, "HR-RECRUITMENT-PORTAL-URL-REQUIRED");

    const draft = await resolveSendDraft({ tenantId, slotOfferId, args, scope, now: at });
    const application = await loadApplication(prisma, tenantId, draft.applicationId, scope);
    await assertCandidateContactable(tenantId, application);
    const panel = await loadPanel(prisma, tenantId, draft.interviewerIds);
    await assertSlotsAvailable({ tenantId, draft, panel });

    const token = newToken();
    const expiresAt = new Date(at.getTime() + Number(settings.slotOfferValidityHours || 72) * HOUR_MS);
    const actor = positiveInt(actorId);
    const row = await tenantTransaction(
        prisma,
        async (tx) => {
            // Serialise sends for one application so "one live offer" holds
            // under concurrency: the second send waits here, then supersedes.
            await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${application.id} FOR UPDATE`;
            await supersedeOpenOffers(tx, { tenantId, applicationId: application.id, keepId: draft.offerId, candidateId: application.candidateId, actorId: actor, now: at });
            const written = await writeSentOffer(tx, { tenantId, draft, application, tokenHash: hashToken(token), expiresAt, actorId: actor, now: at });
            await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.OFFERED, written, {
                candidateId: application.candidateId,
                actorId: actor,
                slotCount: draft.slots.length,
                expiresAt: expiresAt.toISOString(),
                interviewerIds: draft.interviewerIds.map(String),
            }));
            return written;
        },
        { tenantId },
    );

    // Fail-soft delivery after commit: the offer stands even if the hub is down.
    const send = await sendCandidateEmail({
        tenantId,
        email: application.candidate.email,
        templateId: SLOT_OFFER_TEMPLATE_ID,
        data: {
            firstName: application.candidate.firstName ?? "",
            jobTitle: application.jobRequisition?.title ?? "",
            companyName: settings.companyName ?? "",
            chooseUrl: `${portalBase}${PORTAL_SLOT_CHOICE_PATH}?token=${token}`,
            slotCount: draft.slots.length,
            durationMinutes: draft.durationMinutes,
            expiresAt: expiresAt.toISOString(),
        },
        dedupeKey: `hr-interview-slot-offer:${row.id}:${row.version}`,
        category: "INTERVIEW",
    });
    return { ...presentSlotOffer(row, scope), emailed: send?.sent === true };
}

// ── Cancel and list ──────────────────────────────────────────────────────────

/** Withdraw a PROPOSED or SENT offer with a reason. The link stops working. */
export async function cancelSlotOffer({ tenantId, slotOfferId, reason, actorId = null, scope = null, now = new Date() } = {}) {
    requireTenant(tenantId);
    requireRecruiter(scope);
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text || text.length > MAX_REASON) throw fail(`A reason of 1 to ${MAX_REASON} characters is required`, 400, "HR-RECRUITMENT-SLOT-OFFER-REASON-REQUIRED");
    const id = positiveInt(slotOfferId);
    if (!id) throw fail("Slot offer not found", 404, "HR-RECRUITMENT-SLOT-OFFER-NOT-FOUND");
    const actor = positiveInt(actorId);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const offer = await tx.interviewSlotOffer.findFirst({
                where: withTenant(tenantId, { id, ...(scope && !scope.unrestricted ? { application: { is: applicationScopeWhere(scope) } } : {}) }),
                select: { ...OFFER_SELECT, application: { select: { candidateId: true } } },
            });
            if (!offer) throw fail("Slot offer not found", 404, "HR-RECRUITMENT-SLOT-OFFER-NOT-FOUND");
            const notOpen = () => fail(`The slot offer is ${offer.status.toLowerCase()} and cannot be cancelled`, 409, "HR-RECRUITMENT-SLOT-OFFER-NOT-OPEN");
            if (!OPEN_STATUSES.includes(offer.status)) throw notOpen();
            const { count } = await tx.interviewSlotOffer.updateMany({
                where: withTenant(tenantId, { id, status: { in: [...OPEN_STATUSES] } }),
                data: { status: SLOT_OFFER_STATUS.CANCELLED, cancelledAt: new Date(now), cancelReason: text, tokenHash: null, version: { increment: 1 } },
            });
            if (!count) throw notOpen();
            await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.CANCELLED, offer, {
                candidateId: offer.application?.candidateId ?? null,
                actorId: actor,
                reasonCode: "MANUAL",
            }));
            const row = await tx.interviewSlotOffer.findFirst({ where: withTenant(tenantId, { id }), select: OFFER_SELECT });
            return presentSlotOffer(row, scope);
        },
        { tenantId },
    );
}

/** Slot offers by application or requisition, cut to the applications the caller can see. */
export async function listSlotOffers({ tenantId, scope = null, applicationId, requisitionId, status, page = 1, limit = 50 } = {}) {
    requireTenant(tenantId);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const pageNo = Math.max(Number(page) || 1, 1);
    const st = status ? String(status).trim().toUpperCase() : null;
    if (st && !Object.values(SLOT_OFFER_STATUS).includes(st)) throw fail(`Unknown status "${st}"`, 400, "HR-RECRUITMENT-SLOT-OFFER-STATUS-INVALID");
    const where = withTenant(tenantId, {
        ...(positiveInt(applicationId) ? { applicationId: positiveInt(applicationId) } : {}),
        ...(positiveInt(requisitionId) ? { requisitionId: positiveInt(requisitionId) } : {}),
        ...(st ? { status: st } : {}),
        ...(scope && !scope.unrestricted ? { application: { is: applicationScopeWhere(scope) } } : {}),
    });
    const [rows, total] = await Promise.all([
        prisma.interviewSlotOffer.findMany({ where, select: OFFER_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (pageNo - 1) * take, take }),
        prisma.interviewSlotOffer.count({ where }),
    ]);
    return { items: rows.map((r) => presentSlotOffer(r, scope)), total, page: pageNo, limit: take };
}

// ── Public (portal) ──────────────────────────────────────────────────────────

// The token IS the lookup; it is read under SYSTEM context because the
// caller has no tenant, and must belong to the portal's pinned tenant.
async function findOfferRef(token, pinnedTenantId) {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const ref = await mcpCtx.run({ system: true }, async () =>
        await prisma.interviewSlotOffer.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, tenantId: true } }),
    );
    if (!ref?.tenantId) return null;
    if (pinnedTenantId && ref.tenantId !== pinnedTenantId) return null;
    return ref;
}

const asTenant = (tenantId, fn) => mcpCtx.run({ ...(mcpCtx.getStore() ?? {}), user: { tenantId }, system: false }, fn);

const LIVE_OFFER_SELECT = Object.freeze({
    ...OFFER_SELECT,
    application: {
        select: {
            stage: true,
            candidateId: true,
            candidate: { select: { firstName: true, anonymizedAt: true } },
            jobRequisition: { select: { title: true, recruiterId: true } },
        },
    },
});

async function loadLiveOffer(db, ref, now) {
    const offer = await db.interviewSlotOffer.findFirst({
        where: withTenant(ref.tenantId, { id: ref.id, status: SLOT_OFFER_STATUS.SENT, expiresAt: { gt: now } }),
        select: LIVE_OFFER_SELECT,
    });
    if (!offer || offer.application?.candidate?.anonymizedAt) return null;
    if (!INTERVIEWABLE_STAGES.includes(offer.application?.stage)) return null;
    return offer;
}

const futureSlots = (offer, now) =>
    (Array.isArray(offer.slots) ? offer.slots : []).filter((s) => new Date(s.start).getTime() > now.getTime());

const firstName = (e) => String(e?.first_name ?? "").trim() || String(e?.employee_name ?? "").trim().split(/\s+/)[0] || null;

/**
 * The candidate's view of a live offer, or null for every not-found case
 * (flag off, malformed, unknown, expired, cancelled, confirmed, other tenant).
 */
export async function getSlotOfferForCandidate({ token, tenantId = null, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("selfScheduling")) return null;
    const at = new Date(now);
    const ref = await findOfferRef(token, tenantId);
    if (!ref) return null;
    return asTenant(ref.tenantId, async () => {
        const offer = await loadLiveOffer(prisma, ref, at);
        if (!offer) return null;
        const slots = futureSlots(offer, at);
        if (!slots.length) return null;
        const [panel, settings] = await Promise.all([
            prisma.employee.findMany({
                where: scopedEmployeeWhere(ref.tenantId, { id: { in: offer.interviewerIds ?? [] } }),
                select: { id: true, first_name: true, employee_name: true },
            }),
            loadSettings(ref.tenantId),
        ]);
        return {
            firstName: offer.application.candidate.firstName ?? null,
            jobTitle: offer.application.jobRequisition?.title ?? null,
            companyName: settings.companyName ?? null,
            interviewType: offer.interviewType,
            durationMinutes: offer.durationMinutes,
            location: offer.location ?? null,
            panelFirstNames: panel.map(firstName).filter(Boolean),
            timeZone: settings.timeZone,
            expiresAt: new Date(offer.expiresAt).toISOString(),
            slots: slots.map((s) => ({ start: s.start, end: s.end })),
        };
    });
}

/**
 * The candidate confirms one slot. Returns null for every not-found case;
 * throws HR-RECRUITMENT-SLOT-UNAVAILABLE (409) when the slot is not one of
 * the offer's future slots or the panel is no longer free (the offer stays
 * SENT so the candidate can pick another).
 */
export async function confirmSlotOffer({ token, slotStart, tenantId = null, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("selfScheduling")) return null;
    const at = new Date(now);
    const ref = await findOfferRef(token, tenantId);
    if (!ref) return null;
    return asTenant(ref.tenantId, async () => {
        const offer = await loadLiveOffer(prisma, ref, at);
        if (!offer) return null;
        const wanted = toDate(slotStart);
        const slot = wanted && futureSlots(offer, at).find((s) => new Date(s.start).getTime() === wanted.getTime());
        if (!slot) throw slotUnavailable();
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        const panel = await prisma.employee.findMany({
            where: scopedEmployeeWhere(ref.tenantId, { id: { in: offer.interviewerIds ?? [] } }),
            select: { id: true, work_email: true, email: true },
        });
        // The remote call stays outside the transaction.
        const calendar = await calendarBusy({ tenantId: ref.tenantId, panel, from: start, to: end });
        return confirmInTransaction({ ref, offer, start, end, calendarBusyList: calendar.busy, now: at });
    });
}

async function confirmInTransaction({ ref, offer, start, end, calendarBusyList, now }) {
    const tenantId = ref.tenantId;
    return tenantTransaction(
        prisma,
        async (tx) => {
            const availability = await loadPanelAvailability(tx, { tenantId, interviewerIds: offer.interviewerIds ?? [], from: start, to: end });
            if (slotConflict(availability, start, end, calendarBusyList)) throw slotUnavailable();
            // The guarded claim: exactly one confirm of this offer gets past here.
            const { count } = await tx.interviewSlotOffer.updateMany({
                where: withTenant(tenantId, { id: offer.id, status: SLOT_OFFER_STATUS.SENT, expiresAt: { gt: now } }),
                data: { status: SLOT_OFFER_STATUS.CONFIRMED, confirmedAt: now, chosenSlotStart: start, tokenHash: null, version: { increment: 1 } },
            });
            if (!count) return null;
            const interview = await scheduleInterviewInTransaction(tx, {
                applicationId: offer.applicationId,
                interviewType: offer.interviewType,
                scheduledAt: start.toISOString(),
                durationMinutes: offer.durationMinutes,
                location: offer.location,
                interviewerIds: offer.interviewerIds,
                tenantId,
                source: SELF_SCHEDULE_SOURCE,
                slotOfferId: offer.id,
                now,
            });
            await tx.interviewSlotOffer.updateMany({ where: withTenant(tenantId, { id: offer.id }), data: { interviewId: interview.id } });
            await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.CONFIRMED, offer, {
                candidateId: offer.application?.candidateId ?? null,
                interviewId: String(interview.id),
                chosenSlotStart: start.toISOString(),
            }));
            return {
                confirmed: true,
                start: start.toISOString(),
                end: end.toISOString(),
                durationMinutes: offer.durationMinutes,
                location: offer.location ?? null,
            };
        },
        { tenantId },
    );
}

// ── Decline (public, Phase 6) ────────────────────────────────────────────────

/** An optional coded reason: absent -> null; unknown -> 400 (checked before the token). */
export function normalizeDeclineReason(reason) {
    if (reason == null || (typeof reason === "string" && reason.trim() === "")) return null;
    const code = String(reason).trim().toUpperCase();
    if (!SLOT_DECLINE_REASONS.includes(code)) {
        throw fail(`reason must be one of ${SLOT_DECLINE_REASONS.join(", ")}`, 400, "HR-RECRUITMENT-SLOT-DECLINE-REASON-INVALID");
    }
    return code;
}

/**
 * The candidate declines every offered slot. Returns { declined: true } for a
 * live offer and null for every not-found case (the same set as read and
 * confirm). A second decline of the same link is that same null.
 */
export async function declineSlotOffer({ token, reason, tenantId = null, now = new Date() } = {}) {
    const code = normalizeDeclineReason(reason);
    if (!isRecruitmentFlagEnabled("selfScheduling")) return null;
    const at = new Date(now);
    const ref = await findOfferRef(token, tenantId);
    if (!ref) return null;
    return asTenant(ref.tenantId, async () => {
        const offer = await loadLiveOffer(prisma, ref, at);
        if (!offer) return null;
        return tenantTransaction(
            prisma,
            async (tx) => {
                // The guarded claim: one decline (or one confirm) wins the link.
                const { count } = await tx.interviewSlotOffer.updateMany({
                    where: withTenant(ref.tenantId, { id: offer.id, status: SLOT_OFFER_STATUS.SENT, expiresAt: { gt: at } }),
                    data: {
                        status: SLOT_OFFER_STATUS.CANCELLED,
                        cancelledAt: at,
                        cancelReason: code ? `${CANDIDATE_DECLINED}:${code}` : CANDIDATE_DECLINED,
                        tokenHash: null,
                        version: { increment: 1 },
                    },
                });
                if (!count) return null;
                await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.DECLINED, offer, {
                    candidateId: offer.application?.candidateId ?? null,
                    reasonCode: code,
                    // Routing: the recruiter who sent the offer, else the
                    // requisition's recruiter.
                    offeredById: offer.createdById != null ? String(offer.createdById) : null,
                    recruiterId: offer.application?.jobRequisition?.recruiterId != null
                        ? String(offer.application.jobRequisition.recruiterId)
                        : null,
                }));
                log.info({ tenantId: ref.tenantId, slotOfferId: offer.id, reasonCode: code }, "slot offer declined by the candidate");
                return { declined: true };
            },
            { tenantId: ref.tenantId },
        );
    });
}

// ── The expiry job ───────────────────────────────────────────────────────────

/**
 * Turn SENT offers past expiresAt into EXPIRED, across tenants. Flag
 * selfScheduling; per-row tenant transaction with a guarded update, so a run
 * that repeats (or overlaps) expires each offer once.
 */
export async function runSlotOfferExpiryJob({ now = new Date(), limit = 200 } = {}) {
    if (!isRecruitmentFlagEnabled("selfScheduling")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const summary = { scanned: 0, expired: 0, skipped: 0, errors: 0 };
    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.interviewSlotOffer.findMany({
            where: { status: SLOT_OFFER_STATUS.SENT, expiresAt: { lte: at } },
            select: { id: true, tenantId: true, applicationId: true, requisitionId: true, application: { select: { candidateId: true } } },
            orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
            take,
        }),
    );
    summary.scanned = due.length;
    for (const row of due) {
        try {
            const done = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
                await tenantTransaction(
                    prisma,
                    async (tx) => {
                        const { count } = await tx.interviewSlotOffer.updateMany({
                            where: withTenant(row.tenantId, { id: row.id, status: SLOT_OFFER_STATUS.SENT, expiresAt: { lte: at } }),
                            data: { status: SLOT_OFFER_STATUS.EXPIRED, tokenHash: null, version: { increment: 1 } },
                        });
                        if (count) {
                            await enqueueHrDomainEvent(tx, slotOfferEvent(SLOT_OFFER_EVENTS.EXPIRED, row, { candidateId: row.application?.candidateId ?? null }));
                        }
                        return count > 0;
                    },
                    { tenantId: row.tenantId },
                ),
            );
            summary[done ? "expired" : "skipped"] += 1;
        } catch (err) {
            summary.errors += 1;
            log.warn({ slotOfferId: row.id, errMessage: err?.message }, "slot offer expiry: row failed");
        }
    }
    if (summary.scanned) log.info(summary, "slot offer expiry run");
    return summary;
}

export default {
    proposeSlots,
    sendSlotOffer,
    cancelSlotOffer,
    listSlotOffers,
    getSlotOfferForCandidate,
    confirmSlotOffer,
    declineSlotOffer,
    runSlotOfferExpiryJob,
};
