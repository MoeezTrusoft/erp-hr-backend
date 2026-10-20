// src/services/reception.service.js
//
// Phase 3b — the Reception Console (plan 7.2 "Arrival and check-in", 7.3.5
// "Live proctoring", 7.9): today's arrivals, check-in, code issue and the live
// kiosk grid with pause, resume, void and extend.
//
// What reception may see. RECEPTION roles resolve to recruitment scope
// ASSESSMENT, which reaches no recruitment rows, so these reads go to the
// interview, session and check-in tables directly (tenant-scoped, never
// through applicationScopeWhere) and return only what the front desk needs:
// the candidate's display name, the interview time and place, the kiosk, the
// session status, progress, time left and the flag count. Never an item, a
// key, a score or a band: a finished sitting is "COMPLETED, refer to the
// recruiter", whatever its result.
//
// Sites. The codebase has no site table (locations are free text), so a site
// is a siteRef string: a workstation carries one, a check-in records one, and
// an interview is at a site when its location names it. A receptionist works
// one site at a time and passes its siteRef; a recruiter may leave it out to
// see every site. RBAC has no site claim yet, so the siteRef keeps a desk to
// its own queue rather than drawing a security boundary (see the note).
//
// Rules from the plan: ID verification keeps the ID type and the last four
// characters only; consent is required; extra time is granted only by a
// recruiter, with a reason, up to the blueprint's maxExtraTimePct; the code is
// six digits, single use and valid for 15 minutes on one kiosk; one live
// session per interview; a void needs a reason and leaves the result
// INCOMPLETE; an extension is the recruiter's, with a reason, within the cap.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import {
    ASSESSMENT_STATUS,
    FLAG_INTEGRITY_TYPES,
    INTEGRITY_TYPE,
    LIVE_SESSION_STATUSES,
    SESSION_STATUS,
    extendDeadline,
    remainingSeconds,
} from "../lib/test-band.util.js";
import { logAction } from "../utils/logs.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { assessmentEvent, loadInterviewContext, recordIncompleteResult } from "./test-result.service.js";
import { SESSION_CODE_TTL_MS, generateSessionCode, hashSessionCode } from "./test-session.service.js";

const COMPONENT = "reception";
const AUDIT_MODULE = "Recruitment Assessment";

export const ID_TYPES = Object.freeze(["CNIC", "PASSPORT", "DRIVING_LICENCE", "OTHER"]);
export const COMPLETED_NOTE = "Completed, refer to the recruiter";
const MAX_REASON = 1000;
const DEFAULT_TIME_ZONE = "Asia/Karachi";
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const positiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};
const interviewNotFound = () => fail("Interview not found", 404, "HR-RECRUITMENT-TEST-INTERVIEW-NOT-FOUND");
const sessionNotFound = () => fail("Test session not found", 404, "HR-RECRUITMENT-TEST-SESSION-NOT-FOUND");

function requireTenant(tenantId) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
}

const text = (value, max = MAX_REASON) => {
    const s = typeof value === "string" ? value.trim() : "";
    if (s.length > max) throw fail(`The text must be at most ${max} characters`, 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");
    return s || null;
};

// ── Site reach ───────────────────────────────────────────────────────────────

/** A non-recruiter must name their site; a recruiter may see every site. */
function siteFor(access, siteRef) {
    const site = text(siteRef, 100);
    if (!site && !access.recruiter) throw fail("siteRef is required", 400, "HR-RECRUITMENT-RECEPTION-SITE-REQUIRED");
    return site;
}

const sameSite = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const interviewAtSite = (location, site) => String(location ?? "").toLowerCase().includes(String(site).toLowerCase());

// ── Time zone day bounds ─────────────────────────────────────────────────────

function zoneOffsetMs(at, timeZone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).formatToParts(at).map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** [start, end) of the local day `date` (YYYY-MM-DD, default today) in the tenant's zone. */
export function localDayBounds({ date, now = new Date(), timeZone = DEFAULT_TIME_ZONE }) {
    let zone = timeZone;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
        zone = DEFAULT_TIME_ZONE;
    }
    let ymd = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    if (!ymd) ymd = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [y, m, d] = ymd.split("-").map(Number);
    const midnightUtc = Date.UTC(y, m - 1, d);
    const start = new Date(midnightUtc - zoneOffsetMs(new Date(midnightUtc), zone));
    return { date: ymd, start, end: new Date(start.getTime() + DAY_MS) };
}

async function tenantTimeZone(tenantId) {
    const row = await prisma.tenantRecruitmentSettings.findUnique({ where: { tenantId }, select: { timeZone: true } });
    return row?.timeZone || DEFAULT_TIME_ZONE;
}

// ── What reception may see ───────────────────────────────────────────────────

/** assessmentStatus as the front desk sees it: no band ever. */
export function receptionAssessmentStatus(status) {
    switch (status) {
        case ASSESSMENT_STATUS.REQUIRED: return "AWAITING_CHECK_IN";
        case ASSESSMENT_STATUS.CHECKED_IN: return "CHECKED_IN";
        case ASSESSMENT_STATUS.IN_PROGRESS: return "IN_PROGRESS";
        case ASSESSMENT_STATUS.WAIVED: return "WAIVED";
        case ASSESSMENT_STATUS.NOT_REQUIRED: return "NOT_REQUIRED";
        default: return "COMPLETED";
    }
}

const receptionSessionStatus = (status) => (status === SESSION_STATUS.SUBMITTED ? "COMPLETED" : status);

const displayName = (c) => (c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || null : null);

async function namesFor(tenantId, candidateIds) {
    const ids = [...new Set(candidateIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await prisma.candidate.findMany({
        where: withTenant(tenantId, { id: { in: ids } }),
        select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((c) => [c.id, displayName(c)]));
}

/**
 * Today's assessment interviews (at the caller's site, or every site for a
 * recruiter): candidate name, time, place, check-in and session state.
 */
export async function listArrivals({ tenantId, access, siteRef, date, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    const bounds = localDayBounds({ date, now, timeZone: await tenantTimeZone(tenantId) });
    const interviews = await prisma.interview.findMany({
        where: withTenant(tenantId, {
            assessmentRequired: true,
            scheduledAt: { gte: bounds.start, lt: bounds.end },
            OR: [{ status: { in: ["SCHEDULED", "COMPLETED"] } }, { assessmentStatus: ASSESSMENT_STATUS.RELEASED }],
            ...(site ? { location: { contains: site, mode: "insensitive" } } : {}),
        }),
        select: { id: true, applicationId: true, scheduledAt: true, durationMinutes: true, interviewType: true, location: true, status: true, assessmentStatus: true },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: 500,
    });
    const ids = interviews.map((i) => i.id);
    const [applications, checkIns, sessions] = ids.length
        ? await Promise.all([
            prisma.application.findMany({
                where: withTenant(tenantId, { id: { in: [...new Set(interviews.map((i) => i.applicationId))] } }),
                select: { id: true, candidateId: true },
            }),
            prisma.candidateCheckIn.findMany({ where: withTenant(tenantId, { interviewId: { in: ids } }), select: { interviewId: true, arrivedAt: true, siteRef: true } }),
            prisma.candidateTestSession.findMany({
                where: withTenant(tenantId, { interviewId: { in: ids } }),
                select: { id: true, interviewId: true, status: true, workstationId: true, codeExpiresAt: true },
                orderBy: { id: "asc" },
            }),
        ])
        : [[], [], []];
    const candidateOf = new Map(applications.map((a) => [a.id, a.candidateId]));
    const names = await namesFor(tenantId, applications.map((a) => a.candidateId));
    const checkInOf = new Map(checkIns.map((c) => [c.interviewId, c]));
    const latestSession = new Map();
    for (const s of sessions) latestSession.set(s.interviewId, s);

    return {
        date: bounds.date,
        siteRef: site,
        items: interviews.map((i) => {
            const checkIn = checkInOf.get(i.id);
            const session = latestSession.get(i.id);
            const status = receptionAssessmentStatus(i.assessmentStatus);
            return {
                interviewId: i.id,
                candidateName: names.get(candidateOf.get(i.applicationId)) ?? null,
                scheduledAt: i.scheduledAt,
                durationMinutes: i.durationMinutes,
                interviewType: i.interviewType,
                location: i.location ?? null,
                assessmentStatus: status,
                ...(status === "COMPLETED" ? { note: COMPLETED_NOTE } : {}),
                checkedIn: Boolean(checkIn),
                arrivedAt: checkIn?.arrivedAt ?? null,
                session: session
                    ? { sessionId: session.id, status: receptionSessionStatus(session.status), workstationId: session.workstationId ?? null }
                    : null,
            };
        }),
    };
}

// ── Check-in ─────────────────────────────────────────────────────────────────

/** The bounded interview a front desk may act on (site reach for non-recruiters). */
async function interviewForDesk(db, { tenantId, access, interviewId, site }) {
    const interview = await loadInterviewContext(db, tenantId, positiveInt(interviewId) ?? 0);
    if (!interview || !interview.assessmentRequired) throw interviewNotFound();
    if (!access.recruiter && !interviewAtSite(interview.location, site)) throw interviewNotFound();
    return interview;
}

function normalizeAccommodations(raw, { access, maxExtraTimePct }) {
    if (!raw || typeof raw !== "object") return { value: null, extraTimePct: 0 };
    const extra = raw.extraTimePct === undefined || raw.extraTimePct === null ? 0 : Number(raw.extraTimePct);
    if (!Number.isInteger(extra) || extra < 0 || extra > 100) {
        throw fail("extraTimePct must be a whole percentage", 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");
    }
    if (extra > 0 && !access.recruiter) {
        throw fail("Only a recruiter can grant extra time", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    if (extra > maxExtraTimePct) {
        throw fail(`Extra time is capped at ${maxExtraTimePct}% for this test`, 400, "HR-RECRUITMENT-TEST-EXTRA-TIME-CAP");
    }
    const value = {
        extraTimePct: extra,
        largeText: raw.largeText === true,
        screenReader: raw.screenReader === true,
        ...(raw.language === "ur" || raw.language === "en" ? { language: raw.language } : {}),
    };
    const any = extra > 0 || value.largeText || value.screenReader || value.language;
    return { value: any ? value : null, extraTimePct: extra };
}

/**
 * Check a candidate in: ID type and the last four characters only, consent,
 * accommodations with a reason. The interview moves REQUIRED -> CHECKED_IN.
 */
export async function checkInCandidate({ tenantId, access, actorId = null, interviewId, idType, idLast4, consent, accommodations, accommodationReason, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    if (consent !== true) throw fail("The candidate's consent to the test is required", 400, "HR-RECRUITMENT-CHECKIN-CONSENT-REQUIRED");
    const type = String(idType ?? "").trim().toUpperCase();
    if (!ID_TYPES.includes(type)) throw fail(`idType must be one of ${ID_TYPES.join(", ")}`, 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");
    const last4 = String(idLast4 ?? "").trim();
    if (!/^[A-Za-z0-9]{4}$/.test(last4)) throw fail("idLast4 must be exactly the last four characters of the ID", 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");
    const reason = text(accommodationReason);
    const actor = positiveInt(actorId);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const interview = await interviewForDesk(tx, { tenantId, access, interviewId, site });
            if (interview.status !== "SCHEDULED") throw fail("The interview is not scheduled", 409, "HR-RECRUITMENT-CHECKIN-INVALID");
            if (interview.assessmentStatus !== ASSESSMENT_STATUS.REQUIRED) {
                throw fail("The candidate is already checked in or the test is settled", 409, "HR-RECRUITMENT-CHECKIN-INVALID");
            }
            const blueprint = interview.assessmentBlueprintId
                ? await tx.candidateTestBlueprint.findFirst({
                    where: withTenant(tenantId, { id: interview.assessmentBlueprintId }),
                    select: { maxExtraTimePct: true },
                })
                : null;
            const acc = normalizeAccommodations(accommodations, { access, maxExtraTimePct: blueprint?.maxExtraTimePct ?? 50 });
            if (acc.value && !reason) throw fail("A reason is required for an accommodation", 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");

            const checkIn = await tx.candidateCheckIn.create({
                data: {
                    tenantId,
                    interviewId: interview.id,
                    applicationId: interview.applicationId,
                    candidateId: interview.candidateId,
                    siteRef: site,
                    arrivedAt: now,
                    idType: type,
                    idLast4: last4,
                    verifiedById: actor,
                    consentAt: now,
                    accommodations: acc.value,
                    accommodationReason: acc.value ? reason : null,
                },
            });
            const moved = await tx.interview.updateMany({
                where: withTenant(tenantId, { id: interview.id, assessmentStatus: ASSESSMENT_STATUS.REQUIRED }),
                data: { assessmentStatus: ASSESSMENT_STATUS.CHECKED_IN },
            });
            if (!moved.count) throw fail("The candidate is already checked in", 409, "HR-RECRUITMENT-CHECKIN-INVALID");
            await enqueueHrDomainEvent(
                tx,
                assessmentEvent("candidate_checked_in", {
                    tenantId,
                    aggregateType: "CandidateCheckIn",
                    aggregateId: checkIn.id,
                    actorId: actor,
                    payload: {
                        checkInId: String(checkIn.id),
                        interviewId: String(interview.id),
                        applicationId: String(interview.applicationId),
                        candidateId: String(interview.candidateId),
                        recruiterId: interview.recruiterId != null ? String(interview.recruiterId) : null,
                        interviewerIds: interview.interviewerIds.map(String),
                    },
                }),
            );
            return {
                checkInId: checkIn.id,
                interviewId: interview.id,
                assessmentStatus: ASSESSMENT_STATUS.CHECKED_IN,
                accommodations: acc.value,
            };
        },
        { tenantId },
    );
}

// ── Code issue ───────────────────────────────────────────────────────────────

/**
 * Issue a session on one ACTIVE kiosk at the site. The six-digit code is
 * returned once and stored only as a salted hash.
 */
export async function issueTestSession({ tenantId, access, actorId = null, interviewId, workstationId, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    const actor = positiveInt(actorId);
    const code = generateSessionCode();

    return tenantTransaction(
        prisma,
        async (tx) => {
            const interview = await interviewForDesk(tx, { tenantId, access, interviewId, site });
            if (interview.status !== "SCHEDULED" || interview.assessmentStatus !== ASSESSMENT_STATUS.CHECKED_IN) {
                throw fail("Check the candidate in before issuing a test code", 409, "HR-RECRUITMENT-TEST-SESSION-INVALID");
            }
            const checkIn = await tx.candidateCheckIn.findFirst({ where: withTenant(tenantId, { interviewId: interview.id }) });
            if (!checkIn) throw fail("Check the candidate in before issuing a test code", 409, "HR-RECRUITMENT-TEST-SESSION-INVALID");
            const blueprint = interview.assessmentBlueprintId
                ? await tx.candidateTestBlueprint.findFirst({
                    where: withTenant(tenantId, { id: interview.assessmentBlueprintId }),
                    select: { id: true, version: true, status: true, maxExtraTimePct: true },
                })
                : null;
            if (!blueprint) throw fail("The interview has no test blueprint", 409, "HR-RECRUITMENT-TEST-BLUEPRINT-MISSING");

            const workstation = await tx.testWorkstation.findFirst({
                where: withTenant(tenantId, { id: positiveInt(workstationId) ?? 0, status: "ACTIVE" }),
                select: { id: true, label: true, siteRef: true },
            });
            const kioskSite = site ?? checkIn.siteRef;
            if (!workstation || (kioskSite && !sameSite(workstation.siteRef, kioskSite))) {
                throw fail("No active kiosk with that id at this site", 404, "HR-RECRUITMENT-TEST-WORKSTATION-NOT-FOUND");
            }

            const live = await tx.candidateTestSession.findMany({
                where: withTenant(tenantId, {
                    status: { in: [...LIVE_SESSION_STATUSES] },
                    OR: [{ interviewId: interview.id }, { workstationId: workstation.id }],
                }),
                select: { id: true, interviewId: true },
            });
            if (live.some((s) => s.interviewId === interview.id)) {
                throw fail("This interview already has a live test session", 409, "HR-RECRUITMENT-TEST-SESSION-LIVE");
            }
            if (live.length) throw fail("That kiosk is in use", 409, "HR-RECRUITMENT-TEST-WORKSTATION-BUSY");

            const previous = await tx.candidateTestSession.findFirst({
                where: withTenant(tenantId, { interviewId: interview.id }),
                orderBy: { id: "desc" },
                select: { id: true, attemptNo: true },
            });
            const extra = Math.min(Number(checkIn.accommodations?.extraTimePct) || 0, blueprint.maxExtraTimePct ?? 50);
            const codeExpiresAt = new Date(now.getTime() + SESSION_CODE_TTL_MS);
            const created = await tx.candidateTestSession.create({
                data: {
                    tenantId,
                    applicationId: interview.applicationId,
                    interviewId: interview.id,
                    candidateId: interview.candidateId,
                    checkInId: checkIn.id,
                    blueprintId: blueprint.id,
                    blueprintVersion: blueprint.version,
                    workstationId: workstation.id,
                    siteRef: workstation.siteRef,
                    status: SESSION_STATUS.ISSUED,
                    attemptNo: (previous?.attemptNo ?? 0) + 1,
                    previousSessionId: previous?.id ?? null,
                    issuedAt: now,
                    issuedById: actor,
                    codeExpiresAt,
                    extraTimePct: extra,
                },
            });
            // The salt includes the session id, so the hash is written second.
            await tx.candidateTestSession.update({
                where: { id: created.id },
                data: { sessionCodeHash: hashSessionCode({ tenantId, sessionId: created.id, code }) },
            });
            await enqueueHrDomainEvent(
                tx,
                assessmentEvent("test_session_issued", {
                    tenantId,
                    aggregateType: "CandidateTestSession",
                    aggregateId: created.id,
                    actorId: actor,
                    payload: {
                        sessionId: String(created.id),
                        interviewId: String(interview.id),
                        applicationId: String(interview.applicationId),
                        candidateId: String(interview.candidateId),
                        workstationId: String(workstation.id),
                    },
                }),
            );
            return {
                sessionId: created.id,
                code,
                codeExpiresAt,
                workstation: { id: workstation.id, label: workstation.label },
                attemptNo: created.attemptNo,
            };
        },
        { tenantId },
    );
}

// ── The live grid ────────────────────────────────────────────────────────────

/** Today's sessions at the site: who, which kiosk, status, progress, time and flags. */
export async function listLiveSessions({ tenantId, access, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    const bounds = localDayBounds({ now, timeZone: await tenantTimeZone(tenantId) });
    const sessions = await prisma.candidateTestSession.findMany({
        where: withTenant(tenantId, {
            OR: [{ status: { in: [...LIVE_SESSION_STATUSES] } }, { issuedAt: { gte: bounds.start, lt: bounds.end } }],
            ...(site ? { siteRef: { equals: site, mode: "insensitive" } } : {}),
        }),
        select: {
            id: true, interviewId: true, candidateId: true, blueprintId: true, workstationId: true, siteRef: true, status: true,
            issuedAt: true, codeExpiresAt: true, startedAt: true, deadlineAt: true, pausedAt: true, pausedTotalSec: true,
            extraTimePct: true, itemOrder: true, attemptNo: true,
        },
        orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
        take: 500,
    });
    const ids = sessions.map((s) => s.id);
    const [names, kiosks, blueprints, responses, flags] = await Promise.all([
        namesFor(tenantId, sessions.map((s) => s.candidateId)),
        ids.length
            ? prisma.testWorkstation.findMany({ where: withTenant(tenantId, { id: { in: [...new Set(sessions.map((s) => s.workstationId).filter(Boolean))] } }), select: { id: true, label: true } })
            : [],
        ids.length
            ? prisma.candidateTestBlueprint.findMany({ where: withTenant(tenantId, { id: { in: [...new Set(sessions.map((s) => s.blueprintId))] } }), select: { id: true, durationMin: true } })
            : [],
        ids.length ? prisma.candidateTestResponse.findMany({ where: withTenant(tenantId, { sessionId: { in: ids } }), select: { sessionId: true, answer: true } }) : [],
        ids.length
            ? prisma.candidateTestIntegrityEvent.findMany({ where: withTenant(tenantId, { sessionId: { in: ids }, type: { in: [...FLAG_INTEGRITY_TYPES] } }), select: { sessionId: true } })
            : [],
    ]);
    const labelOf = new Map(kiosks.map((k) => [k.id, k.label]));
    const durationOf = new Map(blueprints.map((b) => [b.id, b.durationMin]));
    const count = (rows, pick = () => true) => rows.reduce((m, r) => (pick(r) ? m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1) : m), new Map());
    const answered = count(responses, (r) => r.answer && Object.keys(r.answer).length > 0);
    const flagged = count(flags);

    return {
        siteRef: site,
        items: sessions.map((s) => {
            const status = receptionSessionStatus(s.status);
            const live = LIVE_SESSION_STATUSES.includes(s.status);
            return {
                sessionId: s.id,
                interviewId: s.interviewId,
                candidateName: names.get(s.candidateId) ?? null,
                workstation: s.workstationId ? { id: s.workstationId, label: labelOf.get(s.workstationId) ?? null } : null,
                siteRef: s.siteRef ?? null,
                status,
                ...(status === "COMPLETED" ? { note: COMPLETED_NOTE } : {}),
                attemptNo: s.attemptNo,
                progress: { answered: answered.get(s.id) ?? 0, total: Array.isArray(s.itemOrder) ? s.itemOrder.length : null },
                remainingSec: live && s.status !== SESSION_STATUS.ISSUED ? remainingSeconds(s, now, durationOf.get(s.blueprintId) ?? 0) : null,
                codeExpiresAt: s.status === SESSION_STATUS.ISSUED ? s.codeExpiresAt : null,
                integrityFlagCount: flagged.get(s.id) ?? 0,
            };
        }),
    };
}

// ── Proctor actions ──────────────────────────────────────────────────────────

async function sessionForDesk(tx, { tenantId, access, sessionId, site }) {
    const session = await tx.candidateTestSession.findFirst({ where: withTenant(tenantId, { id: positiveInt(sessionId) ?? 0 }) });
    if (!session) throw sessionNotFound();
    if (!access.recruiter && !sameSite(session.siteRef, site)) throw sessionNotFound();
    return session;
}

const stateConflict = (status) => fail(`The session is ${status}`, 409, "HR-RECRUITMENT-TEST-SESSION-STATE");

async function proctorEvent(tx, session, type, detail, now) {
    await tx.candidateTestIntegrityEvent.create({
        data: { tenantId: session.tenantId, sessionId: session.id, type, source: "PROCTOR", occurredAt: now, detail },
    });
}

/** Pause a running sitting; the clock stops until it is resumed. */
export async function pauseTestSession({ tenantId, access, actorId = null, sessionId, reason, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    const note = text(reason);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const session = await sessionForDesk(tx, { tenantId, access, sessionId, site });
            const moved = await tx.candidateTestSession.updateMany({
                where: withTenant(tenantId, { id: session.id, status: SESSION_STATUS.IN_PROGRESS }),
                data: { status: SESSION_STATUS.PAUSED, pausedAt: now },
            });
            if (!moved.count) throw stateConflict(session.status);
            await proctorEvent(tx, session, INTEGRITY_TYPE.PROCTOR_PAUSE, { byId: positiveInt(actorId), ...(note ? { reason: note } : {}) }, now);
            return { sessionId: session.id, status: SESSION_STATUS.PAUSED, pausedAt: now };
        },
        { tenantId },
    );
}

/** Resume a paused sitting; the paused time is banked so it never counts. */
export async function resumeTestSession({ tenantId, access, sessionId, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const session = await sessionForDesk(tx, { tenantId, access, sessionId, site });
            if (session.status !== SESSION_STATUS.PAUSED || !session.pausedAt) throw stateConflict(session.status);
            // A pause before the clock started costs the candidate nothing to bank.
            const pausedFor = session.startedAt
                ? Math.max(0, Math.floor((now.getTime() - new Date(session.pausedAt).getTime()) / 1000))
                : 0;
            const moved = await tx.candidateTestSession.updateMany({
                where: withTenant(tenantId, { id: session.id, status: SESSION_STATUS.PAUSED }),
                data: { status: SESSION_STATUS.IN_PROGRESS, pausedAt: null, pausedTotalSec: (session.pausedTotalSec ?? 0) + pausedFor },
            });
            if (!moved.count) throw stateConflict(session.status);
            return { sessionId: session.id, status: SESSION_STATUS.IN_PROGRESS, pausedForSec: pausedFor };
        },
        { tenantId },
    );
}

/** Void a session with a reason: VOIDED, the code and token dead, the result INCOMPLETE. */
export async function voidTestSession({ tenantId, access, actorId = null, sessionId, reason, siteRef, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reception");
    const site = siteFor(access, siteRef);
    const note = text(reason);
    if (!note) throw fail("A reason is required to void a session", 400, "HR-RECRUITMENT-TEST-REASON-REQUIRED");
    const actor = positiveInt(actorId);
    const out = await tenantTransaction(
        prisma,
        async (tx) => {
            const session = await sessionForDesk(tx, { tenantId, access, sessionId, site });
            const moved = await tx.candidateTestSession.updateMany({
                where: withTenant(tenantId, { id: session.id, status: { in: [...LIVE_SESSION_STATUSES] } }),
                data: { status: SESSION_STATUS.VOIDED, voidedAt: now, voidReason: note, sessionCodeHash: null, sessionTokenHash: null, pausedAt: null },
            });
            if (!moved.count) throw stateConflict(session.status);
            await proctorEvent(tx, session, INTEGRITY_TYPE.PROCTOR_VOID, { byId: actor, reason: note }, now);
            const result = await recordIncompleteResult(tx, { session: { ...session, status: SESSION_STATUS.VOIDED }, now });
            return { sessionId: session.id, status: SESSION_STATUS.VOIDED, resultId: result?.id ?? null };
        },
        { tenantId },
    );
    await logAction({
        employeeId: actor, type: "UPDATE", module: AUDIT_MODULE, result: "SUCCESS",
        notes: `Test session "${out.sessionId}" voided`, tenantId,
    });
    return out;
}

/**
 * Extend a sitting by some minutes (recruiter only, with a reason), never past
 * duration x (1 + maxExtraTimePct). Before the clock starts the extension is
 * added to the session's extra time instead.
 */
export async function extendTestSession({ tenantId, access, actorId = null, sessionId, minutes, reason, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "recruiter", "Only a recruiter can extend a test session");
    const add = Number(minutes);
    if (!Number.isInteger(add) || add < 1 || add > 120) throw fail("minutes must be a whole number from 1 to 120", 400, "HR-RECRUITMENT-RECEPTION-INPUT-INVALID");
    const note = text(reason);
    if (!note) throw fail("A reason is required to extend a session", 400, "HR-RECRUITMENT-TEST-REASON-REQUIRED");
    const actor = positiveInt(actorId);
    const out = await tenantTransaction(
        prisma,
        async (tx) => {
            const session = await sessionForDesk(tx, { tenantId, access, sessionId, site: null });
            if (!LIVE_SESSION_STATUSES.includes(session.status)) throw stateConflict(session.status);
            const blueprint = await tx.candidateTestBlueprint.findFirst({
                where: withTenant(tenantId, { id: session.blueprintId }),
                select: { durationMin: true, maxExtraTimePct: true },
            });
            const cap = blueprint?.maxExtraTimePct ?? 50;
            if (session.startedAt && session.deadlineAt) {
                const next = extendDeadline({ startedAt: session.startedAt, deadlineAt: session.deadlineAt, durationMin: blueprint.durationMin, maxExtraTimePct: cap, minutes: add });
                if (!next.ok) throw fail(`The extension would pass this test's ${cap}% extra-time cap`, 409, "HR-RECRUITMENT-TEST-EXTRA-TIME-CAP");
                await tx.candidateTestSession.update({ where: { id: session.id }, data: { deadlineAt: next.deadlineAt } });
                return { sessionId: session.id, deadlineAt: next.deadlineAt, remainingSec: remainingSeconds({ ...session, deadlineAt: next.deadlineAt }, now, blueprint.durationMin) };
            }
            const extra = (session.extraTimePct ?? 0) + Math.ceil((add * 100) / Math.max(1, blueprint?.durationMin ?? 30));
            if (extra > cap) throw fail(`The extension would pass this test's ${cap}% extra-time cap`, 409, "HR-RECRUITMENT-TEST-EXTRA-TIME-CAP");
            await tx.candidateTestSession.update({ where: { id: session.id }, data: { extraTimePct: extra } });
            return { sessionId: session.id, extraTimePct: extra };
        },
        { tenantId },
    );
    logger.info({ component: COMPONENT, sessionId: out.sessionId, minutes: add }, "test session extended");
    await logAction({
        employeeId: actor, type: "UPDATE", module: AUDIT_MODULE, result: "SUCCESS",
        notes: `Test session "${out.sessionId}" extended by ${add} min`, tenantId,
    });
    return out;
}

export default {
    listArrivals,
    checkInCandidate,
    issueTestSession,
    listLiveSessions,
    pauseTestSession,
    resumeTestSession,
    voidTestSession,
    extendTestSession,
};
