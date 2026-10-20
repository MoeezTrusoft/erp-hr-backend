// src/services/candidate-communication.consumer.js
//
// Recruitment Phase 2 — turns recruitment events into QUEUED candidate
// messages.
//
// A consumer group ("hr-candidate-communications") on the hr:events stream the
// outbox dispatcher fills. The stream idiom is assessment/source-stream.js:
// create the group once (BUSYGROUP is fine), reclaim our stale pending entries
// with XAUTOCLAIM, read new ones with XREADGROUP, and ACK only once the event
// is handled: its row is written (or already was), or it is known to map to
// nothing. A failing event stays pending and is retried; after five attempts it
// goes to a dead-letter stream (ids only) and is acked so it cannot wedge the
// group.
//
// Two switches:
//   * HR_CANDIDATE_COMMS_WORKER_ENABLED === "true" runs the consumer at all
//     (and REDIS_URL, and never under NODE_ENV=test);
//   * the `communications` flag decides whether it ACTS. With the flag off an
//     event is acked and dropped: turning the flag on later must not send a
//     backlog of stale messages.
//
// Each event is handled under its own tenant's context (RLS), never SYSTEM,
// and the payload is trusted for ids only: the application, candidate and
// requisition are re-read under that tenant, so an event can never address a
// candidate of another tenant.
//
// Phase 6 (invitationLinks) — talent_pool_invitation_sent resolves to the
// INVITATION, not an application: the open invitation and its candidate are
// re-read under the tenant, and the row is queued with no application. With
// the flag off, or for an invitation that is no longer open, it maps to
// nothing.
import Redis from "ioredis";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { HR_EVENTS_STREAM } from "../jobs/outbox.dispatcher.js";
import { COMMUNICATION_TARGETS, EVENTS, isReinstatement, templateForEvent } from "./candidate-communication.templates.js";
import { isInvitationExpired } from "../lib/talentPoolPolicy.js";
import {
    COMMUNICATION_STATUS,
    buildCommunicationRow,
    cancelQueuedCommunications,
    communicationContext,
    loadApplicationForCommunication,
    loadTenantCommunicationFacts,
    queueCommunicationRows,
} from "./candidate-communication.service.js";

const consumerLog = logger.child({ component: "candidate-communication-consumer" });

export const CANDIDATE_COMMS_GROUP = "hr-candidate-communications";
export const CANDIDATE_COMMS_RETRY_HASH = "hr:candidate-comms:retry";
export const CANDIDATE_COMMS_DEAD_LETTER = "hr:candidate-comms:dead-letter";
const MAX_EVENT_ATTEMPTS = 5;
const READ_COUNT = 30;
const RECLAIM_IDLE_MS = 30_000;
const FANOUT_PAGE = 500;
const TERMINAL_STAGES = Object.freeze(["hired", "rejected", "withdrawn"]);

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const eventTime = (envelope) => {
    const at = envelope?.occurredAt ? new Date(envelope.occurredAt) : null;
    return at && !Number.isNaN(at.getTime()) ? at : undefined;
};

// ── Resolution: event -> the applications and template context it concerns ──

async function resolveInterviewTargets(tenantId, payload) {
    const interview = await prisma.interview.findFirst({
        where: withTenant(tenantId, { id: positiveInt(payload.interviewId) ?? -1 }),
        select: { id: true, applicationId: true, scheduledAt: true, durationMinutes: true, interviewType: true, status: true },
    });
    if (!interview) return [];
    const application = await loadApplicationForCommunication({ tenantId, applicationId: interview.applicationId });
    return application ? [{ application, extra: { interview, previousScheduledAt: payload.previousScheduledAt ?? null } }] : [];
}

async function resolveOfferTargets(tenantId, payload, extra = {}) {
    const offer = await prisma.offer.findFirst({
        where: withTenant(tenantId, { id: positiveInt(payload.offerId) ?? -1 }),
        select: { id: true, applicationId: true, status: true },
    });
    // An offer withdrawn before the event was handled is not announced.
    if (!offer || offer.status !== "SENT") return [];
    const application = await loadApplicationForCommunication({ tenantId, applicationId: offer.applicationId });
    return application ? [{ application, extra }] : [];
}

// Every still-open application on the requisition hears that it closed;
// hired, rejected and withdrawn ones already have their own outcome.
async function resolveRequisitionTargets(tenantId, payload) {
    const requisitionId = positiveInt(payload.requisitionId);
    if (!requisitionId) return [];
    const targets = [];
    let cursor = 0;
    for (;;) {
        const page = await prisma.application.findMany({
            where: withTenant(tenantId, { jobRequisitionId: requisitionId, stage: { notIn: [...TERMINAL_STAGES] }, id: { gt: cursor } }),
            select: {
                id: true,
                tenantId: true,
                candidateId: true,
                jobRequisitionId: true,
                stage: true,
                candidate: { select: { id: true, firstName: true } },
                jobRequisition: { select: { id: true, title: true } },
                offer: { select: { id: true, status: true } },
            },
            orderBy: { id: "asc" },
            take: FANOUT_PAGE,
        });
        targets.push(...page.map((application) => ({ application, extra: {} })));
        if (page.length < FANOUT_PAGE) return targets;
        cursor = page[page.length - 1].id;
    }
}

// Phase 6 — the open invitation, shaped as an application-less target: the row
// keeps the candidate and the requisition, the template renders the first
// name, the role title and the expiry.
async function resolveInvitationTargets(tenantId, payload) {
    if (!isRecruitmentFlagEnabled("invitationLinks")) return [];
    const invitation = await prisma.talentPoolInvitation.findFirst({
        where: withTenant(tenantId, { id: positiveInt(payload.invitationId) ?? -1 }),
        select: {
            id: true,
            candidateId: true,
            jobRequisitionId: true,
            status: true,
            expiresAt: true,
            candidate: { select: { id: true, firstName: true, anonymizedAt: true } },
            jobRequisition: { select: { id: true, title: true } },
        },
    });
    if (!invitation || invitation.status !== "INVITED" || isInvitationExpired(invitation)) return [];
    if (!invitation.candidate || invitation.candidate.anonymizedAt) return [];
    const target = {
        id: null,
        candidateId: invitation.candidateId,
        jobRequisitionId: invitation.jobRequisitionId ?? null,
        stage: null,
        candidate: { id: invitation.candidate.id, firstName: invitation.candidate.firstName },
        jobRequisition: invitation.jobRequisition ?? null,
        offer: null,
    };
    return [{ application: target, extra: { invitation: { id: invitation.id, expiresAt: invitation.expiresAt ?? null } } }];
}

async function isPortalIntake(tenantId, applicationId) {
    const row = await prisma.applicationStageHistory.findFirst({
        where: withTenant(tenantId, { applicationId, source: "public-portal" }),
        select: { id: true },
    });
    return Boolean(row);
}

async function resolveTargets(tenantId, eventName, payload, template) {
    if (template?.target === COMMUNICATION_TARGETS.INVITATION) return resolveInvitationTargets(tenantId, payload);
    if (eventName === EVENTS.REQUISITION_CLOSED) return resolveRequisitionTargets(tenantId, payload);
    if (eventName === EVENTS.OFFER_SENT) return resolveOfferTargets(tenantId, payload);
    if (eventName === EVENTS.OFFER_EXPIRY_REMINDER) {
        return resolveOfferTargets(tenantId, payload, { expiryDate: payload.expiryDate ?? null });
    }
    if (
        [EVENTS.INTERVIEW_SCHEDULED, EVENTS.INTERVIEW_RESCHEDULED, EVENTS.INTERVIEW_CANCELLED, EVENTS.INTERVIEW_REMINDER].includes(eventName)
    ) {
        return resolveInterviewTargets(tenantId, payload);
    }
    const application = await loadApplicationForCommunication({ tenantId, applicationId: payload.applicationId });
    if (!application) return [];
    const extra = eventName === EVENTS.APPLICATION_CREATED ? { portalIntake: await isPortalIntake(tenantId, application.id) } : {};
    return [{ application, extra }];
}

// A target the template must not address even though the event mapped.
function skipTarget(template, eventName, { application, extra }) {
    if (application.stage === "withdrawn") return true; // the candidate withdrew
    if (template.appliesTo && !template.appliesTo(extra)) return true;
    const interview = extra.interview;
    if (interview && eventName !== EVENTS.INTERVIEW_CANCELLED && interview.status === "CANCELLED") return true;
    // A reminder is only for an interview that is still going ahead.
    if (interview && eventName === EVENTS.INTERVIEW_REMINDER && interview.status !== "SCHEDULED") return true;
    return false;
}

// A recruiter who already sent a personalised offer message must not see the
// automatic one go out on top of it.
async function hasManualOfferMessage(tenantId, applicationId, templateId) {
    const row = await prisma.candidateCommunication.findFirst({
        where: withTenant(tenantId, {
            applicationId,
            templateId,
            eventId: null,
            status: { in: [COMMUNICATION_STATUS.QUEUED, COMMUNICATION_STATUS.SENT] },
        }),
        select: { id: true },
    });
    return Boolean(row);
}

async function buildRows({ tenantId, envelope, template, targets, now }) {
    const facts = await loadTenantCommunicationFacts(tenantId);
    const fanOut = envelope.name === EVENTS.REQUISITION_CLOSED;
    const rows = [];
    for (const target of targets) {
        if (skipTarget(template, envelope.name, target)) continue;
        if (template.category === "OFFER" && (await hasManualOfferMessage(tenantId, target.application.id, template.id))) continue;
        rows.push(
            buildCommunicationRow({
                tenantId,
                template,
                application: target.application,
                context: communicationContext(target.application, facts, target.extra),
                // One event, one message per template — per application when the
                // event fans out to a requisition's applicants.
                dedupeKey: fanOut ? `${envelope.id}:${template.id}:${target.application.id}` : `${envelope.id}:${template.id}`,
                eventId: envelope.id,
                eventName: envelope.name,
                rejectionDelayHours: facts.settings?.rejectionDelayHours,
                decidedAt: eventTime(envelope),
                now,
            }),
        );
    }
    return rows;
}

/**
 * Handle one hr:events envelope. Never sends anything: it only writes or
 * cancels QUEUED rows. Throws on a database failure (the caller leaves the
 * stream entry pending so it is retried).
 *
 * @returns {Promise<{ outcome: string, queued?: number, duplicates?: number, cancelled?: number }>}
 */
export async function handleCandidateCommunicationEvent(envelope, { now = new Date() } = {}) {
    const tenantId = envelope?.tenantId;
    const payload = envelope?.payload ?? {};
    if (!tenantId || !envelope?.id || !envelope?.name) return { outcome: "IGNORED" };
    const template = templateForEvent(envelope.name, payload);
    const reinstated = envelope.name === EVENTS.APPLICATION_STAGE_CHANGED && isReinstatement(payload);
    if (!template && !reinstated) return { outcome: "NO_MESSAGE" };
    if (!isRecruitmentFlagEnabled("communications")) return { outcome: "FLAG_OFF" };

    return mcpCtx.run({ user: { tenantId } }, async () => {
        let cancelled = 0;
        if (reinstated && positiveInt(payload.applicationId)) {
            cancelled = await cancelQueuedCommunications({
                tenantId,
                where: { applicationId: positiveInt(payload.applicationId), category: "REJECTION" },
                reason: "REINSTATED",
                now,
            });
        }
        if (!template) return { outcome: cancelled ? "CANCELLED" : "NO_MESSAGE", cancelled };

        const targets = await resolveTargets(tenantId, envelope.name, payload, template);
        const rows = await buildRows({ tenantId, envelope, template, targets, now });
        if (!rows.length) return { outcome: "NO_MESSAGE", cancelled };
        const { queued, duplicates } = await queueCommunicationRows(tenantId, rows);
        return { outcome: queued ? "QUEUED" : "DUPLICATE", queued, duplicates, cancelled };
    });
}

// ── Stream plumbing ─────────────────────────────────────────────────────────

const fieldsToObject = (fields = []) =>
    Object.fromEntries(Array.from({ length: Math.floor(fields.length / 2) }, (_, i) => [fields[2 * i], fields[2 * i + 1]]));

/**
 * Process one stream entry: handle, then ack. Exported for tests; the redis
 * client is injected.
 */
export async function processCandidateCommunicationEntry(redis, [entryId, fields], { stream = HR_EVENTS_STREAM, group = CANDIDATE_COMMS_GROUP } = {}) {
    const data = fieldsToObject(fields);
    let envelope = null;
    try {
        envelope = JSON.parse(data.envelope || "null");
    } catch {
        envelope = null;
    }
    try {
        // Unparseable entries map to nothing: ack them.
        const result = envelope ? await handleCandidateCommunicationEvent(envelope) : { outcome: "IGNORED" };
        await redis.xack(stream, group, entryId);
        await redis.hdel(CANDIDATE_COMMS_RETRY_HASH, entryId);
        return result;
    } catch (err) {
        const attempts = await redis.hincrby(CANDIDATE_COMMS_RETRY_HASH, entryId, 1);
        consumerLog.warn(
            { entryId, eventName: envelope?.name ?? null, eventId: envelope?.id ?? null, attempts, errCode: err?.code ?? null },
            "candidate communication consumer: event failed, will retry",
        );
        if (attempts >= MAX_EVENT_ATTEMPTS) {
            await redis.xadd(
                CANDIDATE_COMMS_DEAD_LETTER,
                "*",
                "sourceId", entryId,
                "eventId", String(envelope?.id ?? ""),
                "eventName", String(envelope?.name ?? ""),
                "code", String(err?.code ?? "HANDLER_FAILED"),
            );
            await redis.xack(stream, group, entryId);
            await redis.hdel(CANDIDATE_COMMS_RETRY_HASH, entryId);
            return { outcome: "DEAD_LETTERED" };
        }
        return { outcome: "RETRY" };
    }
}

/**
 * One consumer pass: ensure the group, reclaim stale pending entries, read new
 * ones. Exported so the loop and the tests share it.
 */
export async function runCandidateCommunicationConsumerTick(redis, state, { stream = HR_EVENTS_STREAM, group = CANDIDATE_COMMS_GROUP, blockMs = 1000 } = {}) {
    if (!state.ready) {
        if (redis.status === "wait") await redis.connect();
        try {
            await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
        } catch (err) {
            if (!String(err?.message ?? "").includes("BUSYGROUP")) throw err;
        }
        state.ready = true;
    }
    let processed = 0;
    const claimed = await redis.xautoclaim(stream, group, state.consumer, RECLAIM_IDLE_MS, "0-0", "COUNT", READ_COUNT);
    for (const entry of claimed?.[1] ?? []) {
        if (!entry) continue;
        await processCandidateCommunicationEntry(redis, entry, { stream, group });
        processed += 1;
    }
    const streams = await redis.xreadgroup("GROUP", group, state.consumer, "COUNT", READ_COUNT, "BLOCK", blockMs, "STREAMS", stream, ">");
    for (const [, entries] of streams ?? []) {
        for (const entry of entries ?? []) {
            await processCandidateCommunicationEntry(redis, entry, { stream, group });
            processed += 1;
        }
    }
    return processed;
}

/**
 * Start the consumer. Disabled (no-op handle) under NODE_ENV=test, without
 * HR_CANDIDATE_COMMS_WORKER_ENABLED=true, or without REDIS_URL.
 * @returns {{ enabled: boolean, stop: () => Promise<void> }}
 */
export function startCandidateCommunicationConsumer({ env = process.env, redisFactory } = {}) {
    if (env.NODE_ENV === "test" || env.HR_CANDIDATE_COMMS_WORKER_ENABLED !== "true" || !env.REDIS_URL) {
        return { enabled: false, stop: async () => {} };
    }
    const redis = redisFactory
        ? redisFactory(env.REDIS_URL)
        : new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on?.("error", () => consumerLog.warn("candidate communication consumer: redis unavailable"));
    const state = { ready: false, consumer: `hr-candidate-comms-${process.pid}` };
    let stopped = false;
    let timer = null;
    let running = Promise.resolve();

    const tick = async () => {
        if (stopped) return;
        try {
            await runCandidateCommunicationConsumerTick(redis, state);
        } catch (err) {
            state.ready = false;
            consumerLog.warn({ errMessage: err?.message }, "candidate communication consumer: will retry");
        } finally {
            if (!stopped) {
                timer = setTimeout(() => {
                    running = tick();
                }, 1000);
                timer.unref?.();
            }
        }
    };
    running = tick();
    consumerLog.info({ group: CANDIDATE_COMMS_GROUP, consumer: state.consumer }, "candidate communication consumer: started");
    return {
        enabled: true,
        stop: async () => {
            stopped = true;
            clearTimeout(timer);
            await running;
            redis.disconnect();
        },
    };
}
