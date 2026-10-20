// src/services/candidate-communication.delivery.js
//
// Recruitment Phase 2 — sends the due QUEUED candidate messages.
//
// One tick:
//   1. finds due rows across tenants (SYSTEM scan: ids and tenants only):
//      QUEUED, scheduledFor <= now, nextAttemptAt null or due, no live claim;
//   2. per row, under ITS tenant's context, claims it with a conditional
//      updateMany (claimedBy + claimExpiresAt): count 1 wins, 0 means another
//      worker has it, so two overlapping ticks never send one row twice;
//   3. re-checks at SEND time, because hours can pass between queueing and
//      sending (the rejection delay): a no-longer-relevant message is
//      CANCELLED (a rejected application that was reinstated, a withdrawn
//      one); then, in order, an anonymized candidate, an active DNC entry for
//      the address, withdrawn consent, and no address SUPPRESS it. The flag
//      being off releases the claim and leaves it QUEUED, so switching the
//      flag on later still delivers;
//   4. calls the Notification Hub (fail-soft client). Success -> SENT. Failure
//      -> attempts+1 and an exponential nextAttemptAt; FAILED after 5.
//
// SENT and SUPPRESSED each enqueue an outbox event (ids, template, status,
// reason) in the same transaction as the status change. The address is read
// here and passed to the hub only: it is never stored, never logged, never in
// an event.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { generateWorkerId, sanitiseWorkerId } from "../jobs/outbox.dispatcher.js";
import { CONSENT_STATUS, findActiveDnc, normalizeEmail } from "./candidatePrivacy.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getCommunicationTemplate } from "./candidate-communication.templates.js";
import {
    COMMUNICATION_STATUS,
    candidateCommunicationSentEvent,
    candidateCommunicationSuppressedEvent,
} from "./candidate-communication.service.js";

const deliveryLog = logger.child({ component: "candidate-communication-delivery" });

export const MAX_DELIVERY_ATTEMPTS = 5;
export const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 500;
export const DELIVERY_LEASE_MS = 2 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const LAST_ERROR_MAX = 200;

/** Delay before retry n (1-based): 1m, 2m, 4m, 8m ... capped at 6h. */
export function deliveryBackoffMs(attempt) {
    const n = Math.max(1, Number(attempt) || 1);
    return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

const clampLimit = (limit) => {
    const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_DELIVERY_LIMIT;
    return n <= 0 ? DEFAULT_DELIVERY_LIMIT : Math.min(n, MAX_DELIVERY_LIMIT);
};

const dueWhere = (now) => ({
    status: COMMUNICATION_STATUS.QUEUED,
    scheduledFor: { lte: now },
    AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }] },
    ],
});

// Everything below mutates only a row this worker holds the claim on.
const heldWhere = (tenantId, row, workerId) =>
    withTenant(tenantId, { id: row.id, status: COMMUNICATION_STATUS.QUEUED, claimedBy: workerId });

const RELEASED = Object.freeze({ claimedBy: null, claimExpiresAt: null });

async function claimRow(tenantId, row, workerId, now) {
    const result = await prisma.candidateCommunication.updateMany({
        where: withTenant(tenantId, { id: row.id, ...dueWhere(now) }),
        data: { claimedBy: workerId, claimExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS) },
    });
    return Number(result?.count ?? 0) === 1;
}

/** Write the outcome (and its event) atomically, only while the claim holds. */
async function settle(tenantId, row, workerId, data, event) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const result = await tx.candidateCommunication.updateMany({ where: heldWhere(tenantId, row, workerId), data });
            if (Number(result?.count ?? 0) !== 1) return false;
            if (event) await enqueueHrDomainEvent(tx, event);
            return true;
        },
        { tenantId },
    );
}

// A message whose reason went away while it waited.
async function staleReason(tenantId, row) {
    if (!row.applicationId) return null;
    const application = await prisma.application.findFirst({
        where: withTenant(tenantId, { id: row.applicationId }),
        select: { id: true, stage: true },
    });
    if (!application) return "APPLICATION_REMOVED";
    if (application.stage === "withdrawn") return "WITHDRAWN";
    if (row.category === "REJECTION" && application.stage !== "rejected") return "REINSTATED";
    return null;
}

// The send-time privacy checks, in the order the plan fixes. Returns the
// suppression reason or null, plus the address to use.
async function suppressionFor(tenantId, row, now) {
    const candidate = await prisma.candidate.findFirst({
        where: withTenant(tenantId, { id: row.candidateId }),
        select: { id: true, email: true, consentStatus: true, anonymizedAt: true },
    });
    if (candidate?.anonymizedAt) return { reason: "ANONYMIZED" };
    const email = normalizeEmail(candidate?.email);
    if (email && (await findActiveDnc({ tenantId, email, at: now }))) return { reason: "DNC" };
    // Same rule as assertCommunicationsAllowed: only an explicit withdrawal
    // blocks (UNKNOWN is legacy, not a refusal).
    if (candidate?.consentStatus === CONSENT_STATUS.WITHDRAWN) return { reason: "CONSENT_WITHDRAWN" };
    if (!email) return { reason: "NO_EMAIL" };
    return { reason: null, email };
}

async function cancelStale(tenantId, row, workerId, reason, now) {
    const data = row.data && typeof row.data === "object" ? row.data : {};
    const cancellation = { reason, cancelledById: null, cancelledAt: now.toISOString() };
    await settle(tenantId, row, workerId, { status: COMMUNICATION_STATUS.CANCELLED, data: { ...data, cancellation }, ...RELEASED });
    return "cancelled";
}

async function suppress(tenantId, row, workerId, reason) {
    const event = candidateCommunicationSuppressedEvent({ ...row, tenantId }, {}, { reason });
    await settle(tenantId, row, workerId, { status: COMMUNICATION_STATUS.SUPPRESSED, suppressedReason: reason, ...RELEASED }, event);
    return "suppressed";
}

async function recordFailure(tenantId, row, workerId, reason, now) {
    const attempts = (row.attempts ?? 0) + 1;
    const failed = attempts >= MAX_DELIVERY_ATTEMPTS;
    await settle(tenantId, row, workerId, {
        attempts,
        lastError: String(reason ?? "send-failed").slice(0, LAST_ERROR_MAX),
        status: failed ? COMMUNICATION_STATUS.FAILED : COMMUNICATION_STATUS.QUEUED,
        nextAttemptAt: failed ? null : new Date(now.getTime() + deliveryBackoffMs(attempts)),
        ...RELEASED,
    });
    return failed ? "failed" : "retry";
}

async function deliver(tenantId, row, workerId, email, now) {
    const template = getCommunicationTemplate(row.templateId);
    if (!template) return recordFailure(tenantId, row, workerId, "unknown-template", now);
    const result = await sendCandidateEmail({
        tenantId,
        email,
        templateId: template.hubTemplateId,
        data: row.data ?? {},
        // The hub replays rather than duplicates a retried row.
        dedupeKey: `hr-candidate-communication:${row.id}`,
        category: row.category,
    });
    if (!result?.sent) return recordFailure(tenantId, row, workerId, result?.reason, now);
    const event = candidateCommunicationSentEvent({ ...row, tenantId, status: COMMUNICATION_STATUS.SENT });
    await settle(
        tenantId,
        row,
        workerId,
        { status: COMMUNICATION_STATUS.SENT, sentAt: now, attempts: (row.attempts ?? 0) + 1, lastError: null, nextAttemptAt: null, ...RELEASED },
        event,
    );
    return "sent";
}

/** One claimed row, start to finish. Returns the outcome label. */
async function processRow(tenantId, row, workerId, now) {
    if (!(await claimRow(tenantId, row, workerId, now))) return "raceLost";
    const stale = await staleReason(tenantId, row);
    if (stale) return cancelStale(tenantId, row, workerId, stale, now);
    const { reason, email } = await suppressionFor(tenantId, row, now);
    if (reason) return suppress(tenantId, row, workerId, reason);
    if (!isRecruitmentFlagEnabled("communications")) {
        await prisma.candidateCommunication.updateMany({ where: heldWhere(tenantId, row, workerId), data: { ...RELEASED } });
        return "deferred";
    }
    return deliver(tenantId, row, workerId, email, now);
}

const ROW_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    candidateId: true,
    applicationId: true,
    requisitionId: true,
    templateId: true,
    category: true,
    attempts: true,
    data: true,
});

/**
 * One delivery pass. Safe to run concurrently (claims), idempotent, and one bad
 * row never stops the run.
 * @returns {Promise<object>} counts per outcome
 */
export async function runCandidateCommunicationDeliveryTick({ now = new Date(), limit, workerId } = {}) {
    if (!isRecruitmentFlagEnabled("communications")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const worker = sanitiseWorkerId(workerId) || generateWorkerId();
    const summary = { scanned: 0, sent: 0, suppressed: 0, cancelled: 0, retry: 0, failed: 0, deferred: 0, raceLost: 0, errors: 0 };

    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.candidateCommunication.findMany({
            where: dueWhere(at),
            select: ROW_SELECT,
            orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = due.length;

    for (const row of due) {
        if (!row.tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () => await processRow(row.tenantId, row, worker, at));
            summary[outcome] = (summary[outcome] ?? 0) + 1;
        } catch (err) {
            // The claim lapses on its own, so the row is retried next tick.
            summary.errors += 1;
            deliveryLog.error({ communicationId: row.id, errMessage: err?.message }, "candidate communication delivery: row failed");
        }
    }
    if (summary.scanned) deliveryLog.info({ ...summary, workerId: worker }, "candidate communication delivery: tick done");
    return summary;
}
