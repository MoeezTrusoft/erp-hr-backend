// src/services/test-session.service.js
//
// Phase 3b — one candidate's sitting on a kiosk (plan 7.3.4, 7.3.5 and the
// /kiosk/v1 endpoints in 7.6). The kiosk has no ERP user: the router verifies
// the workstation token, pins the workstation's tenant in the request context
// and calls these functions. Everything the candidate can do is here.
//
//   * THE CODE. Reception issues a six-digit code valid for 15 minutes; only
//     sha256(pepper | tenant | session | code) is stored. Starting matches the
//     code against the ISSUED sessions bound to this kiosk (or, when the
//     blueprint allows it, to any kiosk at the same site), consumes it in a
//     guarded update (single use) and returns a random session bearer token
//     once; only its hash is stored. The draw happens at that moment.
//   * ONE ITEM PER REQUEST. An item read returns the stem and the options in
//     the candidate's frozen order: never the key, the rationale, another item
//     or the pool. The first real item starts the clock (the practice item
//     never does) and fixes deadlineAt on the server.
//   * LATE IS LATE. An answer after the deadline (or while not IN_PROGRESS) is
//     refused; a request that finds the deadline passed submits the sitting.
//     FORWARD_ONLY refuses any item before the furthest one served.
//   * INTEGRITY. The kiosk reports focus loss, full-screen exit and network
//     loss; the server adds RAPID_ANSWER (an answer under two seconds after the
//     item was first served), NETWORK_LOSS (a heartbeat gap) and DEVICE_CHANGE
//     (the session's token from another kiosk, or another token on its kiosk).
//   * UNIFORM FAILURE. Every bad code, token, binding or state is the same
//     404 (kioskNotFound), so the endpoints are no oracle.
//   * THE JOB. runTestSessionJob (every minute) expires unused codes, submits
//     sittings past their deadline and closes sittings abandoned before the
//     clock started.
//   * CRASH RESUME (Phase 6, flag kioskResume with onsiteTest). When a kiosk
//     dies mid-sitting, reception issues a RESUME code for the same
//     IN_PROGRESS (or PAUSED) session on another kiosk at the same site
//     (reception.service.js issueKioskResumeCode): the old session token is
//     revoked there and then, the session is bound to the new kiosk, and the
//     code's hash sits on the session row (sessionCodeHash / codeExpiresAt,
//     the columns start uses for ISSUED rows, so no migration). The new kiosk
//     exchanges the code here (resumeKioskSession, POST sessions/resume) for
//     a fresh token. Nothing about the sitting changes: the same drawn items
//     (itemOrder), the saved answers, and the server clock exactly where it
//     is (a running clock kept running through the crash; a paused one stays
//     paused until reception resumes it), so a resume never adds time.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { isAnswerShapeValid } from "../lib/test-scoring.util.js";
import {
    ASSESSMENT_STATUS,
    INTEGRITY_TYPE,
    KIOSK_INTEGRITY_TYPES,
    LIVE_SESSION_STATUSES,
    SESSION_STATUS,
    deadlineFrom,
    isPastDeadline,
    remainingSeconds,
    sittingSeconds,
} from "../lib/test-band.util.js";
import { assembleItemOrder, cryptoRng } from "./test-session-assembly.service.js";
import { assessmentEvent, finalizeSession, loadInterviewContext, recordIncompleteResult } from "./test-result.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const COMPONENT = "test-session";

export const SESSION_CODE_TTL_MS = 15 * 60 * 1000;
export const RAPID_ANSWER_MS = 2000;
export const HEARTBEAT_GAP_MS = 90 * 1000;
export const ABANDON_AFTER_MS = 60 * 60 * 1000;
export const COMPLETION_MESSAGE = "Thank you, your test is complete. Please return to reception.";

const SUBMIT_REASON = Object.freeze({ CANDIDATE: "CANDIDATE", TIMEOUT: "TIMEOUT", PROCTOR: "PROCTOR" });
const SINGLE_TYPES = Object.freeze(["SINGLE", "IMAGE_SINGLE", "TRUE_FALSE"]);
const MAX_EVENTS_PER_POST = 20;
const MAX_DETAIL_KEYS = 10;
const MAX_DETAIL_TEXT = 200;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const positiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** The one failure a kiosk ever sees for a bad code, token, binding or state. */
export const kioskNotFound = () => fail("Not found", 404, "HR-RECRUITMENT-KIOSK-NOT-FOUND");

/** 503 while HR_RECRUITMENT_ONSITE_TEST is off (mapped to HR-5031). */
export function assertOnsiteTestEnabled() {
    if (!isRecruitmentFlagEnabled("onsiteTest")) {
        throw fail("The on-site test is disabled", 503, "HR-RECRUITMENT-ONSITE-TEST-DISABLED");
    }
}

/** Phase 6 — 503 while HR_RECRUITMENT_KIOSK_RESUME is off (mapped to HR-5031). */
export function assertKioskResumeEnabled() {
    assertOnsiteTestEnabled();
    if (!isRecruitmentFlagEnabled("kioskResume")) {
        throw fail("Kiosk crash resume is disabled", 503, "HR-RECRUITMENT-KIOSK-RESUME-DISABLED");
    }
}

/** At most this many resumes per sitting; after that the session is voided and retested. */
export const MAX_KIOSK_RESUMES = 2;

/** The sitting states a resume code may be issued for and exchanged in. */
export const RESUMABLE_SESSION_STATUSES = Object.freeze([SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.PAUSED]);

/**
 * A resume is recorded as a PROCTOR-sourced KIOSK_RESUME (the sitting moved
 * kiosk on reception's word; server-detected device changes stay SERVER-sourced
 * DEVICE_CHANGE), so the count is that row's, with no new column. It is on the
 * integrity timeline but is not one of the candidate's flags: a kiosk crash
 * must not push a sitting into REVIEW.
 */
export const resumeEventWhere = (tenantId, sessionId) =>
    withTenant(tenantId, { sessionId, type: INTEGRITY_TYPE.KIOSK_RESUME, source: "PROCTOR" });

/**
 * Phase 7 — the resumes that count toward MAX_KIOSK_RESUMES: a code that was
 * used, or the session's current code while it is still live. A code that
 * expired unused (or was replaced by a newer one before it was used) moved
 * nothing and does not count. Pure.
 *
 * Use is recorded on the resume's own event when the kiosk exchanges the code
 * (detail.usedAt); events written before that tracking existed
 * (detail.usageTracked absent) count as used, which is what they counted as.
 *
 * @param {Array<{ id: number, detail?: object|null }>} events the session's PROCTOR KIOSK_RESUME rows
 * @param {{ sessionCodeHash?: string|null, codeExpiresAt?: Date|string|null }} session
 */
export function countedKioskResumes(events, session, now = new Date()) {
    const rows = Array.isArray(events) ? events : [];
    const latestId = rows.reduce((max, e) => Math.max(max, Number(e?.id) || 0), 0);
    const live = Boolean(session?.sessionCodeHash) && session?.codeExpiresAt != null
        && new Date(session.codeExpiresAt).getTime() > now.getTime();
    return rows.filter((e) => {
        const detail = e?.detail && typeof e.detail === "object" ? e.detail : {};
        if (detail.usageTracked !== true) return true;
        if (detail.usedAt) return true;
        return live && Number(e.id) === latestId;
    }).length;
}

// ── Codes and tokens ─────────────────────────────────────────────────────────

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const pepper = () => process.env.HR_KIOSK_CODE_PEPPER || "hr-kiosk-session-code.v1";

/** A uniformly random six-digit code. */
export const generateSessionCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** The stored form of a session code: salted with the tenant and the session. */
export const hashSessionCode = ({ tenantId, sessionId, code }) => sha256(`${pepper()}|${tenantId}|${sessionId}|${code}`);

/** The stored form of a kiosk session bearer token. */
export const hashSessionToken = (token) => sha256(`kiosk-session|${token}`);

function sameHash(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── The practice item ────────────────────────────────────────────────────────

/** Built in, fixed and never scored: it shows the controls before the clock. */
export const PRACTICE_ITEM = Object.freeze({
    ref: "practice",
    type: "SINGLE",
    stem: "Practice question (not scored): which of these is a day of the week?",
    options: Object.freeze([
        Object.freeze({ id: "a", text: "Monday" }),
        Object.freeze({ id: "b", text: "January" }),
        Object.freeze({ id: "c", text: "Blue" }),
        Object.freeze({ id: "d", text: "Seven" }),
    ]),
});
const PRACTICE_CORRECT = "a";

const practiceView = () => ({
    ref: PRACTICE_ITEM.ref,
    practice: true,
    type: PRACTICE_ITEM.type,
    stem: PRACTICE_ITEM.stem,
    options: PRACTICE_ITEM.options.map((o) => ({ id: o.id, text: o.text })),
});

// ── Reads shared by the endpoints ────────────────────────────────────────────

async function loadBlueprint(db, tenantId, id) {
    return db.candidateTestBlueprint.findFirst({
        where: withTenant(tenantId, { id }),
        select: {
            id: true, name: true, version: true, language: true, jobFamily: true, sections: true,
            durationMin: true, navigation: true, flagForReview: true, allowAnySiteKiosk: true, maxExtraTimePct: true,
        },
    });
}

async function kioskSettings(tenantId) {
    const row = await prisma.tenantRecruitmentSettings.findUnique({ where: { tenantId }, select: { kioskShowScore: true } });
    return { kioskShowScore: row?.kioskShowScore === true };
}

const hasAnswer = (answer) => Boolean(answer && typeof answer === "object" && Object.keys(answer).length);

async function answeredCount(db, tenantId, sessionId) {
    const rows = await db.candidateTestResponse.findMany({
        where: withTenant(tenantId, { sessionId }),
        select: { answer: true },
    });
    return rows.filter((r) => hasAnswer(r.answer)).length;
}

const orderOf = (session) => (Array.isArray(session?.itemOrder) ? session.itemOrder : []);
const maxServed = (order) => order.reduce((max, e) => (e.servedAt && e.n > max ? e.n : max), 0);

/** Options in the candidate's frozen order, whitelisted to what a kiosk may show. */
function orderedOptions(options, optionOrder) {
    const list = Array.isArray(options) ? options : [];
    const byId = new Map(list.map((o) => [String(o?.id), o]));
    const ids = Array.isArray(optionOrder) && optionOrder.length ? optionOrder.map(String) : [...byId.keys()];
    const rest = [...byId.keys()].filter((id) => !ids.includes(id));
    return [...ids, ...rest]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((o) => ({ id: String(o.id), text: o.text ?? "", ...(o.mediaId ? { mediaId: o.mediaId } : {}) }));
}

function answerFitsItem(item, answer) {
    if (!isAnswerShapeValid(item.type, answer)) return false;
    const ids = new Set((Array.isArray(item.options) ? item.options : []).map((o) => String(o?.id)));
    if (!ids.size) return true;
    if (SINGLE_TYPES.includes(item.type)) return ids.has(String(answer.optionId));
    if (item.type === "MULTI") return answer.optionIds.every((id) => ids.has(String(id)));
    return true;
}

async function recordServerEvent(db, session, type, detail, now) {
    await db.candidateTestIntegrityEvent.create({
        data: { tenantId: session.tenantId, sessionId: session.id, type, source: "SERVER", occurredAt: now, detail },
    });
}

// ── Session resolution ───────────────────────────────────────────────────────

/**
 * The session a kiosk request names, if the bearer token is its own and the
 * request comes from its workstation; otherwise kioskNotFound. A live
 * session's own token from another kiosk, or another token on its own kiosk,
 * is recorded as DEVICE_CHANGE first.
 */
export async function resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now = new Date() }) {
    const id = positiveInt(sessionId);
    if (!id || typeof sessionToken !== "string" || sessionToken.length < 16 || sessionToken.length > 200) throw kioskNotFound();
    const session = await prisma.candidateTestSession.findFirst({ where: withTenant(tenantId, { id }) });
    if (!session) throw kioskNotFound();
    const tokenOk = sameHash(hashSessionToken(sessionToken), session.sessionTokenHash);
    const sameKiosk = session.workstationId === workstation.id;
    if (tokenOk && sameKiosk) return session;
    if (LIVE_SESSION_STATUSES.includes(session.status) && (tokenOk || sameKiosk)) {
        await recordServerEvent(prisma, session, INTEGRITY_TYPE.DEVICE_CHANGE, {
            reason: tokenOk ? "WORKSTATION_MISMATCH" : "TOKEN_MISMATCH",
            workstationId: workstation.id,
        }, now);
    }
    throw kioskNotFound();
}

/** Submit a running sitting whose deadline has passed. Returns the fresh row. */
async function closeIfTimedOut(session, now) {
    if (session.status !== SESSION_STATUS.IN_PROGRESS || !isPastDeadline(session, now)) return session;
    await tenantTransaction(
        prisma,
        async (tx) => await finalizeSession(tx, { session, reason: SUBMIT_REASON.TIMEOUT, now }),
        { tenantId: session.tenantId },
    );
    return prisma.candidateTestSession.findFirst({ where: withTenant(session.tenantId, { id: session.id }) });
}

async function completion(session) {
    const settings = await kioskSettings(session.tenantId);
    const out = { status: SESSION_STATUS.SUBMITTED, message: COMPLETION_MESSAGE };
    if (!settings.kioskShowScore) return out;
    const result = await prisma.candidateTestResult.findFirst({
        where: withTenant(session.tenantId, { sessionId: session.id }),
        select: { scorePct: true },
    });
    return result ? { ...out, scorePct: result.scorePct } : out;
}

async function stateOf(session, blueprint, now) {
    const order = orderOf(session);
    const state = {
        sessionId: session.id,
        status: session.status,
        started: Boolean(session.startedAt),
        practiceDone: Boolean(session.practiceDoneAt),
        remainingSec: remainingSeconds(session, now, blueprint?.durationMin ?? 0),
        totalItems: order.length,
        answered: await answeredCount(prisma, session.tenantId, session.id),
        navigation: blueprint?.navigation ?? "FREE",
        flagForReview: blueprint?.flagForReview !== false,
    };
    if (session.status === SESSION_STATUS.SUBMITTED) state.completion = await completion(session);
    return state;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

function instructions(blueprint, totalItems, seconds) {
    const minutes = Math.round(seconds / 60);
    return {
        title: blueprint.name,
        lines: [
            `This test has ${totalItems} questions and lasts ${minutes} minutes.`,
            blueprint.navigation === "FORWARD_ONLY"
                ? "Questions come one after another; you cannot go back to an earlier question."
                : "You can move between questions and change your answers until you submit.",
            "Each answer is saved as soon as you choose it. The test submits itself when the time runs out.",
            "Start with the practice question: it is not scored, and the clock starts at question 1.",
        ],
    };
}

/**
 * POST sessions/start { code, consent? } — consume the code and draw the test.
 * @returns the session bearer token (once), instructions, totals and the practice item
 */
export async function startKioskSession({ tenantId, workstation, code, consent, now = new Date(), rng = cryptoRng }) {
    const digits = String(code ?? "");
    if (!/^\d{6}$/.test(digits)) throw kioskNotFound();
    const token = randomBytes(32).toString("base64url");

    const { session, blueprint } = await tenantTransaction(
        prisma,
        async (tx) => {
            const candidates = await tx.candidateTestSession.findMany({
                where: withTenant(tenantId, {
                    status: SESSION_STATUS.ISSUED,
                    codeExpiresAt: { gt: now },
                    sessionCodeHash: { not: null },
                    OR: [{ workstationId: workstation.id }, ...(workstation.siteRef ? [{ siteRef: workstation.siteRef }] : [])],
                }),
            });
            const match = candidates.find((s) => sameHash(hashSessionCode({ tenantId, sessionId: s.id, code: digits }), s.sessionCodeHash));
            if (!match) throw kioskNotFound();
            const bp = await loadBlueprint(tx, tenantId, match.blueprintId);
            const anyKioskAtSite = bp?.allowAnySiteKiosk === true && match.siteRef && match.siteRef === workstation.siteRef;
            if (!bp || (match.workstationId !== workstation.id && !anyKioskAtSite)) throw kioskNotFound();

            // Single use: whichever request clears the code first owns the session.
            const claim = await tx.candidateTestSession.updateMany({
                where: withTenant(tenantId, { id: match.id, status: SESSION_STATUS.ISSUED, sessionCodeHash: match.sessionCodeHash }),
                data: {
                    status: SESSION_STATUS.IN_PROGRESS,
                    sessionCodeHash: null,
                    sessionTokenHash: hashSessionToken(token),
                    workstationId: workstation.id,
                    lastHeartbeatAt: now,
                    ...(consent === true ? { consentAt: now } : {}),
                },
            });
            if (!claim.count) throw kioskNotFound();
            const itemOrder = await assembleItemOrder(tx, { tenantId, blueprint: bp, candidateId: match.candidateId, sessionId: match.id, rng });
            await tx.candidateTestSession.update({ where: { id: match.id }, data: { itemOrder } });
            await tx.interview.updateMany({
                where: withTenant(tenantId, { id: match.interviewId, assessmentStatus: ASSESSMENT_STATUS.CHECKED_IN }),
                data: { assessmentStatus: ASSESSMENT_STATUS.IN_PROGRESS },
            });
            return { session: { ...match, status: SESSION_STATUS.IN_PROGRESS, itemOrder, workstationId: workstation.id }, blueprint: bp };
        },
        { tenantId },
    );

    const checkIn = session.checkInId
        ? await prisma.candidateCheckIn.findFirst({ where: withTenant(tenantId, { id: session.checkInId }), select: { accommodations: true } })
        : null;
    const seconds = sittingSeconds(blueprint.durationMin, session.extraTimePct);
    const total = orderOf(session).length;
    return {
        sessionId: session.id,
        sessionToken: token,
        instructions: instructions(blueprint, total, seconds),
        totalItems: total,
        durationMin: blueprint.durationMin,
        durationSec: seconds,
        remainingSec: seconds,
        navigation: blueprint.navigation,
        flagForReview: blueprint.flagForReview !== false,
        accommodations: {
            largeText: checkIn?.accommodations?.largeText === true,
            screenReader: checkIn?.accommodations?.screenReader === true,
        },
        practiceItem: practiceView(),
    };
}

/**
 * POST sessions/resume { code } — Phase 6. Exchange a reception-issued resume
 * code on the kiosk it names for a fresh session token. The sitting comes
 * back as it was: status, the server clock, the drawn items and which of them
 * were served, answered and flagged (the items and saved answers themselves
 * through GET items/:n). A sitting whose time ran out meanwhile is submitted
 * and the answer is the uniform 404, as is every bad code or binding.
 */
export async function resumeKioskSession({ tenantId, workstation, code, now = new Date() }) {
    if (!isRecruitmentFlagEnabled("kioskResume")) throw kioskNotFound();
    const digits = String(code ?? "");
    if (!/^\d{6}$/.test(digits)) throw kioskNotFound();
    const token = randomBytes(32).toString("base64url");

    const candidates = await prisma.candidateTestSession.findMany({
        where: withTenant(tenantId, {
            status: { in: [...RESUMABLE_SESSION_STATUSES] },
            workstationId: workstation.id,
            codeExpiresAt: { gt: now },
            sessionCodeHash: { not: null },
        }),
    });
    const match = candidates.find((s) => sameHash(hashSessionCode({ tenantId, sessionId: s.id, code: digits }), s.sessionCodeHash));
    if (!match) throw kioskNotFound();
    // Out of time while the kiosk was down: submit, never reopen.
    const current = await closeIfTimedOut(match, now);
    if (!RESUMABLE_SESSION_STATUSES.includes(current?.status)) throw kioskNotFound();

    const claimed = await tenantTransaction(
        prisma,
        async (tx) => {
            // Single use: whichever request clears the code first owns the token.
            const claim = await tx.candidateTestSession.updateMany({
                where: withTenant(tenantId, {
                    id: match.id,
                    status: { in: [...RESUMABLE_SESSION_STATUSES] },
                    workstationId: workstation.id,
                    sessionCodeHash: match.sessionCodeHash,
                }),
                // A fresh heartbeat: the crash is on the timeline as the resume,
                // not again as a network loss on the first beat.
                data: { sessionCodeHash: null, sessionTokenHash: hashSessionToken(token), lastHeartbeatAt: now },
            });
            if (!claim.count) return null;
            // Phase 7 — the code was used: its resume now counts toward the limit
            // for good (the latest resume event is the one this code was issued with).
            const issued = await tx.candidateTestIntegrityEvent.findFirst({
                where: resumeEventWhere(tenantId, match.id),
                orderBy: { id: "desc" },
                select: { id: true, detail: true },
            });
            if (issued) {
                await tx.candidateTestIntegrityEvent.updateMany({
                    where: withTenant(tenantId, { id: issued.id }),
                    data: { detail: { ...(issued.detail ?? {}), usedAt: now.toISOString(), usedOnWorkstationId: workstation.id } },
                });
            }
            return await tx.candidateTestSession.findFirst({ where: withTenant(tenantId, { id: match.id }) });
        },
        { tenantId },
    );
    if (!claimed) throw kioskNotFound();

    const blueprint = await loadBlueprint(prisma, tenantId, claimed.blueprintId);
    if (!blueprint) throw kioskNotFound();
    const [responses, checkIn] = await Promise.all([
        prisma.candidateTestResponse.findMany({
            where: withTenant(tenantId, { sessionId: claimed.id }),
            select: { itemId: true, answer: true, flagged: true },
        }),
        claimed.checkInId
            ? prisma.candidateCheckIn.findFirst({ where: withTenant(tenantId, { id: claimed.checkInId }), select: { accommodations: true } })
            : null,
    ]);
    const byItem = new Map(responses.map((r) => [Number(r.itemId), r]));
    const order = orderOf(claimed);
    const seconds = sittingSeconds(blueprint.durationMin, claimed.extraTimePct);
    logger.info({ component: COMPONENT, sessionId: claimed.id, workstationId: workstation.id }, "kiosk session resumed");
    return {
        sessionId: claimed.id,
        sessionToken: token,
        resumed: true,
        status: claimed.status,
        instructions: instructions(blueprint, order.length, seconds),
        totalItems: order.length,
        durationMin: blueprint.durationMin,
        durationSec: seconds,
        remainingSec: remainingSeconds(claimed, now, blueprint.durationMin),
        started: Boolean(claimed.startedAt),
        practiceDone: Boolean(claimed.practiceDoneAt),
        answered: responses.filter((r) => hasAnswer(r.answer)).length,
        currentItem: maxServed(order) || null,
        navigation: blueprint.navigation,
        flagForReview: blueprint.flagForReview !== false,
        accommodations: {
            largeText: checkIn?.accommodations?.largeText === true,
            screenReader: checkIn?.accommodations?.screenReader === true,
        },
        // Positions only: the item and the saved answer come from GET items/:n.
        progress: order.map((e) => {
            const r = byItem.get(Number(e.itemId));
            return { n: e.n, served: Boolean(e.servedAt), answered: hasAnswer(r?.answer), flagged: r?.flagged === true };
        }),
        ...(claimed.startedAt ? {} : { practiceItem: practiceView() }),
    };
}

/** GET sessions/:id — status, remaining time, progress and navigation mode. */
export async function getKioskSessionState({ tenantId, workstation, sessionId, sessionToken, now = new Date() }) {
    let session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    session = await closeIfTimedOut(session, now);
    const blueprint = await loadBlueprint(prisma, tenantId, session.blueprintId);
    return stateOf(session, blueprint, now);
}

/** GET sessions/:id/items/:n — one item; n = 0 or "practice" is the practice item. */
export async function getKioskItem({ tenantId, workstation, sessionId, sessionToken, n, now = new Date() }) {
    let session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    if (String(n) === "0" || String(n) === PRACTICE_ITEM.ref) {
        if (session.status !== SESSION_STATUS.IN_PROGRESS) throw kioskNotFound();
        return practiceView();
    }
    const pos = positiveInt(n);
    session = await closeIfTimedOut(session, now);
    if (!pos || session.status !== SESSION_STATUS.IN_PROGRESS) throw kioskNotFound();
    const order = orderOf(session);
    const entry = order.find((e) => e.n === pos);
    if (!entry) throw kioskNotFound();
    const blueprint = await loadBlueprint(prisma, tenantId, session.blueprintId);
    if (blueprint?.navigation === "FORWARD_ONLY" && pos < maxServed(order)) throw kioskNotFound();
    const item = await prisma.candidateTestItem.findFirst({
        where: withTenant(tenantId, { id: Number(entry.itemId) }),
        // Never the answer key, the rationale or option feedback.
        select: { id: true, type: true, stem: true, mediaId: true, options: true },
    });
    if (!item) throw kioskNotFound();

    const clock = session.startedAt ? null : { startedAt: now, deadlineAt: deadlineFrom(now, blueprint.durationMin, session.extraTimePct) };
    if (clock || !entry.servedAt) {
        const served = order.map((e) => (e.n === pos && !e.servedAt ? { ...e, servedAt: now.toISOString() } : e));
        session = await tenantTransaction(
            prisma,
            async (tx) => {
                const where = withTenant(tenantId, { id: session.id, status: SESSION_STATUS.IN_PROGRESS });
                let started = false;
                if (clock) {
                    const set = await tx.candidateTestSession.updateMany({ where: { ...where, startedAt: null }, data: { itemOrder: served, ...clock } });
                    started = set.count > 0;
                }
                if (!started) await tx.candidateTestSession.updateMany({ where, data: { itemOrder: served } });
                if (started) {
                    const interview = await loadInterviewContext(tx, tenantId, session.interviewId);
                    await enqueueHrDomainEvent(
                        tx,
                        assessmentEvent("test_session_started", {
                            tenantId,
                            aggregateType: "CandidateTestSession",
                            aggregateId: session.id,
                            payload: {
                                sessionId: String(session.id),
                                interviewId: String(session.interviewId),
                                applicationId: String(session.applicationId),
                                candidateId: String(session.candidateId),
                                interviewerIds: (interview?.interviewerIds ?? []).map(String),
                            },
                        }),
                    );
                }
                return await tx.candidateTestSession.findFirst({ where: withTenant(tenantId, { id: session.id }) });
            },
            { tenantId },
        );
    }

    const response = await prisma.candidateTestResponse.findFirst({
        where: withTenant(tenantId, { sessionId: session.id, itemId: item.id }),
        select: { answer: true, flagged: true },
    });
    return {
        n: pos,
        total: order.length,
        sectionKey: entry.sectionKey,
        type: item.type,
        stem: item.stem,
        mediaId: item.mediaId ?? null,
        options: orderedOptions(item.options, entry.optionOrder),
        flagged: response?.flagged === true,
        answer: hasAnswer(response?.answer) ? response.answer : null,
        remainingSec: remainingSeconds(session, now, blueprint.durationMin),
        navigation: blueprint.navigation,
    };
}

const clampSeconds = (v, max) => Math.min(Math.max(0, Math.floor(Number(v) || 0)), Math.max(0, max));

/**
 * PUT sessions/:id/responses/:itemRef { answer?, flagged?, timeSpentSec? } —
 * autosave one answer (or just the review flag). itemRef is the item's
 * position n, or "practice".
 */
export async function saveKioskResponse({ tenantId, workstation, sessionId, sessionToken, itemRef, answer, flagged, timeSpentSec, now = new Date() }) {
    let session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    if (String(itemRef) === PRACTICE_ITEM.ref) {
        if (session.status !== SESSION_STATUS.IN_PROGRESS) throw kioskNotFound();
        if (!answerFitsItem(PRACTICE_ITEM, answer)) throw fail("The answer is not valid for this question", 400, "HR-RECRUITMENT-KIOSK-ANSWER-INVALID");
        await prisma.candidateTestSession.updateMany({
            where: withTenant(tenantId, { id: session.id, practiceDoneAt: null }),
            data: { practiceDoneAt: now },
        });
        return { saved: true, practice: true, correct: String(answer.optionId) === PRACTICE_CORRECT };
    }

    const pos = positiveInt(itemRef);
    session = await closeIfTimedOut(session, now);
    // Late, paused, submitted or never started: refused.
    if (!pos || session.status !== SESSION_STATUS.IN_PROGRESS || !session.startedAt) throw kioskNotFound();
    const order = orderOf(session);
    const entry = order.find((e) => e.n === pos);
    if (!entry?.servedAt) throw kioskNotFound();
    const blueprint = await loadBlueprint(prisma, tenantId, session.blueprintId);
    if (blueprint?.navigation === "FORWARD_ONLY" && pos < maxServed(order)) throw kioskNotFound();
    const item = await prisma.candidateTestItem.findFirst({
        where: withTenant(tenantId, { id: Number(entry.itemId) }),
        select: { id: true, type: true, options: true },
    });
    if (!item) throw kioskNotFound();

    const flagOnly = answer === undefined || answer === null;
    if (flagOnly && typeof flagged !== "boolean") throw fail("An answer or a review flag is required", 400, "HR-RECRUITMENT-KIOSK-ANSWER-INVALID");
    if (flagged !== undefined && typeof flagged !== "boolean") throw fail("flagged must be true or false", 400, "HR-RECRUITMENT-KIOSK-ANSWER-INVALID");
    if (!flagOnly && !answerFitsItem(item, answer)) throw fail("The answer is not valid for this question", 400, "HR-RECRUITMENT-KIOSK-ANSWER-INVALID");
    const spent = clampSeconds(timeSpentSec, sittingSeconds(blueprint.durationMin, 100));
    const elapsedMs = now.getTime() - new Date(entry.servedAt).getTime();

    await tenantTransaction(
        prisma,
        async (tx) => {
            if (!flagOnly && elapsedMs < RAPID_ANSWER_MS) {
                await recordServerEvent(tx, session, INTEGRITY_TYPE.RAPID_ANSWER, { n: pos, elapsedMs }, now);
            }
            const key = { sessionId_itemId: { sessionId: session.id, itemId: item.id } };
            const flag = typeof flagged === "boolean" ? { flagged } : {};
            await tx.candidateTestResponse.upsert({
                where: key,
                create: {
                    tenantId, sessionId: session.id, itemId: item.id, itemVersion: Number(entry.itemVersion),
                    answer: flagOnly ? {} : answer, answeredAt: now, timeSpentSec: spent, ...flag,
                },
                update: flagOnly ? flag : { answer, answeredAt: now, timeSpentSec: spent, ...flag },
            });
        },
        { tenantId },
    );
    return { saved: true, n: pos, remainingSec: remainingSeconds(session, now, blueprint.durationMin) };
}

/** POST sessions/:id/heartbeat — keeps the session alive; a long gap is a NETWORK_LOSS. */
export async function kioskHeartbeat({ tenantId, workstation, sessionId, sessionToken, now = new Date() }) {
    let session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    session = await closeIfTimedOut(session, now);
    if (session.status === SESSION_STATUS.IN_PROGRESS) {
        const gap = session.lastHeartbeatAt ? now.getTime() - new Date(session.lastHeartbeatAt).getTime() : 0;
        if (session.startedAt && gap > HEARTBEAT_GAP_MS) {
            await recordServerEvent(prisma, session, INTEGRITY_TYPE.NETWORK_LOSS, { gapSec: Math.round(gap / 1000) }, now);
        }
        await prisma.candidateTestSession.updateMany({ where: withTenant(tenantId, { id: session.id }), data: { lastHeartbeatAt: now } });
        session = { ...session, lastHeartbeatAt: now };
    }
    const blueprint = await loadBlueprint(prisma, tenantId, session.blueprintId);
    return stateOf(session, blueprint, now);
}

function cleanDetail(detail) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
    const out = {};
    for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_KEYS)) {
        if (typeof value === "number" && Number.isFinite(value)) out[key.slice(0, 40)] = value;
        else if (typeof value === "boolean") out[key.slice(0, 40)] = value;
        else if (typeof value === "string") out[key.slice(0, 40)] = value.slice(0, MAX_DETAIL_TEXT);
    }
    return Object.keys(out).length ? out : null;
}

/** POST sessions/:id/integrity-events { events: [{ type, occurredAt?, detail? }] } (or one event). */
export async function recordKioskIntegrityEvents({ tenantId, workstation, sessionId, sessionToken, body, now = new Date() }) {
    const session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    if (![SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.PAUSED].includes(session.status)) throw kioskNotFound();
    const list = Array.isArray(body?.events) ? body.events : body?.type ? [body] : [];
    if (!list.length || list.length > MAX_EVENTS_PER_POST) throw fail("Between 1 and 20 events are required", 400, "HR-RECRUITMENT-KIOSK-EVENT-INVALID");
    const floor = new Date(session.issuedAt ?? 0).getTime();
    const rows = list.map((event) => {
        const type = String(event?.type ?? "").trim().toUpperCase();
        if (!KIOSK_INTEGRITY_TYPES.includes(type)) throw fail(`Unsupported event type ${type || "(none)"}`, 400, "HR-RECRUITMENT-KIOSK-EVENT-INVALID");
        const at = new Date(event?.occurredAt ?? now);
        // A kiosk clock may drift; the server keeps the timeline inside the sitting.
        const occurredAt = Number.isNaN(at.getTime()) || at > now || at.getTime() < floor ? now : at;
        return { tenantId, sessionId: session.id, type, source: "KIOSK", occurredAt, detail: cleanDetail(event?.detail) };
    });
    await prisma.candidateTestIntegrityEvent.createMany({ data: rows });
    return { recorded: rows.length };
}

/** POST sessions/:id/submit { confirm: true } — the candidate ends the test. */
export async function submitKioskSession({ tenantId, workstation, sessionId, sessionToken, confirm, now = new Date() }) {
    if (confirm !== true) throw fail("Submission must be confirmed", 400, "HR-RECRUITMENT-KIOSK-CONFIRM-REQUIRED");
    let session = await resolveKioskSession({ tenantId, workstation, sessionId, sessionToken, now });
    session = await closeIfTimedOut(session, now);
    if (session.status === SESSION_STATUS.IN_PROGRESS) {
        await tenantTransaction(
            prisma,
            async (tx) => await finalizeSession(tx, { session, reason: SUBMIT_REASON.CANDIDATE, now }),
            { tenantId },
        );
        session = { ...session, status: SESSION_STATUS.SUBMITTED };
    }
    if (session.status !== SESSION_STATUS.SUBMITTED) throw kioskNotFound();
    return completion(session);
}

// ── The minute job ───────────────────────────────────────────────────────────

/** An unused code ran out: EXPIRED, and INCOMPLETE unless another session is live. */
async function expireIssued(row, at) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const claim = await tx.candidateTestSession.updateMany({
                where: withTenant(row.tenantId, { id: row.id, status: SESSION_STATUS.ISSUED, codeExpiresAt: { lte: at } }),
                data: { status: SESSION_STATUS.EXPIRED, sessionCodeHash: null },
            });
            if (!claim.count) return "skipped";
            const live = await tx.candidateTestSession.count({
                where: withTenant(row.tenantId, { interviewId: row.interviewId, id: { not: row.id }, status: { in: [...LIVE_SESSION_STATUSES] } }),
            });
            if (!live) await recordIncompleteResult(tx, { session: { ...row, status: SESSION_STATUS.EXPIRED }, now: at });
            return "expired";
        },
        { tenantId: row.tenantId },
    );
}

/** The code was used but no item was ever served: the sitting is abandoned. */
async function abandon(row, at) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const claim = await tx.candidateTestSession.updateMany({
                where: withTenant(row.tenantId, { id: row.id, status: SESSION_STATUS.IN_PROGRESS, startedAt: null }),
                data: { status: SESSION_STATUS.EXPIRED, sessionTokenHash: null },
            });
            if (!claim.count) return "skipped";
            await recordIncompleteResult(tx, { session: { ...row, status: SESSION_STATUS.EXPIRED }, now: at });
            return "abandoned";
        },
        { tenantId: row.tenantId },
    );
}

async function timeout(row, at) {
    if (!isPastDeadline(row, at)) return "skipped";
    const outcome = await tenantTransaction(
        prisma,
        async (tx) => await finalizeSession(tx, { session: row, reason: SUBMIT_REASON.TIMEOUT, now: at }),
        { tenantId: row.tenantId },
    );
    return outcome.finalized ? "autoSubmitted" : "skipped";
}

/**
 * Every minute (flag onsiteTest): expire unused codes, auto-submit sittings
 * past their deadline (plus paused time) and close sittings abandoned before
 * the clock started. Cross-tenant scan under the system context; each row's
 * work under its own tenant; one bad row never stops the run.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 */
export async function runTestSessionJob({ now = new Date(), limit = 200 } = {}) {
    if (!isRecruitmentFlagEnabled("onsiteTest")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const summary = { scanned: 0, expired: 0, autoSubmitted: 0, abandoned: 0, skipped: 0, failed: 0 };

    const [issued, running] = await mcpCtx.run({ system: true }, async () => await Promise.all([
        prisma.candidateTestSession.findMany({
            where: { status: SESSION_STATUS.ISSUED, codeExpiresAt: { lte: at } },
            orderBy: [{ codeExpiresAt: "asc" }, { id: "asc" }],
            take,
        }),
        prisma.candidateTestSession.findMany({
            where: {
                status: SESSION_STATUS.IN_PROGRESS,
                OR: [{ deadlineAt: { lte: at } }, { startedAt: null, issuedAt: { lte: new Date(at.getTime() - ABANDON_AFTER_MS) } }],
            },
            orderBy: [{ id: "asc" }],
            take,
        }),
    ]));
    summary.scanned = issued.length + running.length;

    const work = [
        ...issued.map((row) => [row, expireIssued]),
        ...running.map((row) => [row, row.startedAt ? timeout : abandon]),
    ];
    for (const [row, step] of work) {
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () => await step(row, at));
            summary[outcome] += 1;
        } catch (err) {
            summary.failed += 1;
            logger.warn(
                { component: COMPONENT, sessionId: row.id, tenantId: row.tenantId, code: err?.code, errMessage: err?.message },
                "test session job: row failed",
            );
        }
    }
    if (summary.scanned) logger.info({ component: COMPONENT, ...summary }, "test session run");
    return summary;
}

export default {
    startKioskSession,
    resumeKioskSession,
    getKioskSessionState,
    getKioskItem,
    saveKioskResponse,
    kioskHeartbeat,
    recordKioskIntegrityEvents,
    submitKioskSession,
    runTestSessionJob,
};
