// src/services/resume-parse-worker.service.js
//
// Phase 2 — the asynchronous resume parse worker. Intake queues a candidate's
// resume (resume-parse-queue.service.js writes a "ticket" row on the parse
// ledger); a tick of this worker claims the due ledger rows and runs them:
//
//   * a TICKET (placeholder key, file not read yet): download the file, hash
//     it, and resolve it against the tenant's content rows: promote it to the
//     content row, take a cache hit, inherit a terminal outcome, adopt a row
//     already in flight, or wait for another candidate's parse of the same
//     bytes (the queue service header has the full table);
//   * a CONTENT row (real hash) that is due: ONE attempt through the shared
//     executeParseAttempt, then project the result onto the candidate with the
//     same function the request path uses, write COMPLETED and emit
//     hr.recruitment.candidate_resume_parsed.v1 in that one transaction.
//
// Due means: PENDING or FAILED with nextAttemptAt <= now (a FAILED row with no
// nextAttemptAt is terminal), or RUNNING with an expired lease (a crashed
// claimant). Only CANDIDATE rows that name a candidate are worked: a preview
// has nobody to project onto.
//
// CLAIMS. Each row is claimed with an updateMany on its id AND the due
// predicate, setting RUNNING + claimedBy (a token unique to this claim) +
// claimExpiresAt. Postgres re-checks the predicate under the row lock, so of
// two overlapping ticks exactly one sees count 1; the other moves on. Every
// later write is guarded by the token, so a claimant that outlived its lease
// writes nothing.
//
// RETRIES follow the ledger's policy (lib/parse-retry.util.js): an attempt is spent
// before the plane call, a retryable failure schedules nextAttemptAt with
// backoffDelayMs, the third failure (or a permanent one) is terminal. A plane
// answer that misses the wait window is collected on a later tick by its task
// id (see aiPlaneClient.collectAiResult) without a new task or attempt.
//
// TENANCY. Due rows are found under SYSTEM context (one scan across tenants);
// each row is then worked under ITS tenant's context, with the tenant also in
// every where clause, and its writes in tenantTransaction.
import { randomUUID } from "node:crypto";
import os from "node:os";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { recordResumeParse } from "../lib/recruitment-ops-metrics.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";
import { enqueueCandidateResumeParse } from "./resume-parse-queue.service.js";
import {
    PARSE_LEASE_MS,
    PARSE_MAX_ATTEMPTS,
    hashResumeContent,
    isParseTicket,
    isRetryableFailure,
    lastErrorCode,
    nextAttemptAfterFailure,
    storedErrorIsRetryable,
} from "../lib/parse-retry.util.js";
import {
    PLANE_PENDING_CODE,
    candidateResumeParsedEvent,
    completeParseAttempt,
    executeParseAttempt,
    pendingMarkerOf,
    projectParsedResumeOntoCandidate,
} from "./resume-parsing.service.js";

const KIND = "CANDIDATE";
export const DEFAULT_TICK_LIMIT = 10;
// How long a ticket waits before looking again at a content row another
// candidate's parse is still working on.
const DEFER_MS = 30_000;
// Events the worker writes carry an automation actor (no human acted).
const AUTOMATION_CTX = Object.freeze({ actorType: "automation" });
const RELEASE_CLAIM = Object.freeze({ claimedBy: null, claimExpiresAt: null });

const workerLog = (fields, msg) => logger.info({ component: "resume-parse-worker", ...fields }, msg);

/** A stable id for one worker process (the claim tokens extend it). */
export const defaultWorkerId = () => `resume-parse:${os.hostname()}:${process.pid}`;

/** The due predicate: what a tick may claim. */
export function dueParseRowsWhere(now) {
    return {
        kind: KIND,
        candidateId: { not: null },
        OR: [
            { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now } },
            { status: "RUNNING", claimExpiresAt: { lt: now } },
        ],
    };
}

const errorText = (err) => `${err?.code ?? ""} ${err?.message ?? err}`.trim().slice(0, 500);
const leaseLost = () => Object.assign(new Error("claim lost"), { code: "HR-RESUME-LEASE-LOST", status: 409 });

/**
 * One worker tick: claim up to `limit` due rows and work each one. Requires the
 * parseWorker AND ai flags. Safe to run concurrently (claims are atomic) and
 * one row's failure never stops the rest.
 *
 * @param {{ now?: Date, limit?: number, workerId?: string, leaseMs?: number }} [args]
 * @returns {Promise<object>} { skipped: "FLAG_OFF" } or a summary of outcomes
 */
export async function runResumeParseWorkerTick({
    now = new Date(),
    limit = DEFAULT_TICK_LIMIT,
    workerId = defaultWorkerId(),
    leaseMs = PARSE_LEASE_MS,
} = {}) {
    if (!isRecruitmentFlagEnabled("parseWorker") || !isRecruitmentFlagEnabled("ai")) return { skipped: "FLAG_OFF" };

    const at = new Date(now);
    // Await INSIDE the callback: a Prisma query is lazy, and one returned
    // unexecuted would run outside the SYSTEM context.
    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.resumeParseAttempt.findMany({
            where: dueParseRowsWhere(at),
            select: { id: true, tenantId: true },
            orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
            take: limit,
        }));

    const summary = { scanned: due.length, claimed: 0, errors: 0, outcomes: {} };
    for (const { id, tenantId } of due) {
        if (!tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId } }, async () =>
                await processDueRow({ id, tenantId, now: at, claimToken: `${workerId}:${randomUUID().slice(0, 8)}`, leaseMs }));
            if (outcome !== "NOT_CLAIMED") summary.claimed += 1;
            summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
        } catch (err) {
            // The claim (if any) expires and the row is picked up again then.
            summary.errors += 1;
            logger.error({ errCode: err?.code, errMessage: err?.message, parseAttemptId: id, tenantId }, "resume parse worker: row failed");
        }
    }
    if (due.length) workerLog({ ...summary }, "resume parse worker: tick done");
    return summary;
}

async function processDueRow({ id, tenantId, now, claimToken, leaseMs }) {
    const ledger = prisma.resumeParseAttempt;
    const { count } = await ledger.updateMany({
        where: withTenant(tenantId, { id, ...dueParseRowsWhere(now) }),
        data: { status: "RUNNING", claimedBy: claimToken, claimExpiresAt: new Date(now.getTime() + leaseMs) },
    });
    if (count !== 1) return "NOT_CLAIMED";

    const row = await ledger.findFirst({ where: withTenant(tenantId, { id }) });
    if (!row || row.claimedBy !== claimToken) return "NOT_CLAIMED";

    const ctx = { tenantId, now, claimToken };
    return isParseTicket(row) ? processTicket(row, ctx) : processContentRow(row, ctx);
}

async function downloadResume(mediaId) {
    const dl = await downloadDamAssetBuffer(mediaId);
    if (!dl?.buffer) {
        throw Object.assign(new Error(`Could not download resume asset ${mediaId} from DAM`), {
            status: 502,
            code: "HR-RESUME-DAM-FETCH",
        });
    }
    return dl;
}

// ── candidate state ──────────────────────────────────────────────────────────

const setCandidateState = (client, { tenantId, candidateId, status, code }) =>
    client.candidate.updateMany({
        where: withTenant(tenantId, { id: candidateId }),
        data: { parseStatus: status, parseError: code ?? null },
    });

// A terminal outcome: the candidate's state and the event, in one transaction,
// plus any extra ledger write (e.g. dropping the ticket).
async function finishTerminal({ tenantId, candidateId, mediaId, parseAttemptId, status, attempts, code }, alsoInTx) {
    await tenantTransaction(
        prisma,
        async (tx) => {
            await setCandidateState(tx, { tenantId, candidateId, status, code });
            const event = candidateResumeParsedEvent(
                { tenantId, candidateId, mediaId, parseAttemptId, status, attempts },
                AUTOMATION_CTX,
            );
            if (event) await enqueueHrDomainEvent(tx, event);
            if (alsoInTx) await alsoInTx(tx);
        },
        { tenantId },
    );
}

// ── content rows ─────────────────────────────────────────────────────────────

async function processContentRow(row, { tenantId, now, claimToken }, downloaded = null) {
    const loadContent = async () => {
        const dl = downloaded ?? (await downloadResume(row.mediaId));
        // The row is the cache entry for exactly these bytes; parsing other
        // bytes into it would poison the cache.
        if (hashResumeContent(dl.buffer) !== row.contentHash) {
            throw Object.assign(new Error("The resume asset no longer matches its ledger row"), {
                status: 409,
                code: "HR-RESUME-CONTENT-CHANGED",
            });
        }
        return dl;
    };

    const out = await executeParseAttempt({
        row,
        claimToken,
        tenantId,
        candidateId: row.candidateId,
        loadContent,
        now,
    });

    const candidate = { tenantId, candidateId: row.candidateId };
    switch (out.outcome) {
        case "COMPLETED":
            return completeAndProject(row, out, { tenantId, claimToken });
        case "PENDING":
            await setCandidateState(prisma, { ...candidate, status: "PENDING", code: PLANE_PENDING_CODE });
            return "PENDING";
        case "RETRY_SCHEDULED":
            await setCandidateState(prisma, { ...candidate, status: "FAILED", code: out.error?.code ?? null });
            return "RETRY_SCHEDULED";
        case "FAILED":
        case "EXHAUSTED":
            await finishTerminal({
                ...candidate,
                mediaId: row.mediaId,
                parseAttemptId: row.id,
                status: out.outcome,
                attempts: out.attempt,
                code: out.error?.code ?? null,
            });
            return out.outcome;
        default:
            return out.outcome; // LEASE_LOST
    }
}

async function completeAndProject(row, out, { tenantId, claimToken }) {
    try {
        await tenantTransaction(
            prisma,
            async (tx) => {
                await completeParseAttempt(tx, row, claimToken, out.result);
                await projectParsedResumeOntoCandidate(tx, {
                    tenantId,
                    candidateId: row.candidateId,
                    mediaId: row.mediaId,
                    parsed: { ...out.result, contentHash: row.contentHash },
                    parseAttemptId: row.id,
                    fromCache: false,
                    attempts: out.attempt,
                    ctx: AUTOMATION_CTX,
                });
            },
            { tenantId },
        );
        recordResumeParse({ kind: KIND, outcome: "ok" });
        return "COMPLETED";
    } catch (err) {
        if (err?.code === "HR-RESUME-LEASE-LOST") return "LEASE_LOST";
        // The parse is paid for: keep it as the cache entry, and retry only the
        // projection through a ticket (a cache hit, no plane call).
        await completeParseAttempt(prisma, row, claimToken, out.result).catch(() => {});
        logger.warn(
            { errCode: err?.code, errMessage: err?.message, parseAttemptId: row.id, candidateId: row.candidateId },
            "resume parse worker: projection failed after a completed parse",
        );
        if (err?.status === 404) return "CANDIDATE_GONE";
        await enqueueCandidateResumeParse({ tenantId, candidateId: row.candidateId, mediaId: row.mediaId });
        return "PROJECTION_REQUEUED";
    }
}

// ── tickets ──────────────────────────────────────────────────────────────────

// A content row with no attempt left (and no late answer to wait for).
function isTerminalContent(content) {
    if (content.status !== "FAILED" || content.nextAttemptAt || pendingMarkerOf(content)) return false;
    return (content.attemptCount ?? 0) >= PARSE_MAX_ATTEMPTS || !storedErrorIsRetryable(content.lastError);
}

async function processTicket(ticket, ctx) {
    try {
        const dl = await downloadResume(ticket.mediaId);
        const contentHash = hashResumeContent(dl.buffer);
        const content = await prisma.resumeParseAttempt.findUnique({
            where: { tenantId_kind_contentHash: { tenantId: ctx.tenantId, kind: KIND, contentHash } },
        });

        if (!content) return await promoteTicket(ticket, contentHash, dl, ctx);
        if (content.status === "COMPLETED") return await projectCacheHit(ticket, content, ctx);
        if (isTerminalContent(content)) return await inheritTerminal(ticket, content, ctx);
        if (content.candidateId == null || content.candidateId === ticket.candidateId) {
            return await adoptContent(ticket, content, ctx);
        }
        return await deferTicket(ticket, content, ctx);
    } catch (err) {
        if (err?.code === "HR-RESUME-LEASE-LOST") return "LEASE_LOST";
        if (err?.status === 404) {
            await dropTicket(prisma, ticket, ctx).catch(() => {});
            return "CANDIDATE_GONE";
        }
        return failTicket(ticket, err, ctx);
    }
}

async function dropTicket(client, ticket, { tenantId, claimToken }) {
    const { count } = await client.resumeParseAttempt.deleteMany({ where: { id: ticket.id, tenantId, claimedBy: claimToken } });
    if (!count) throw leaseLost();
}

// No content row yet: the ticket becomes it (same row, real key) and runs
// attempt 1 right away with the bytes already in hand.
async function promoteTicket(ticket, contentHash, dl, ctx) {
    let count;
    try {
        ({ count } = await prisma.resumeParseAttempt.updateMany({
            where: { id: ticket.id, tenantId: ctx.tenantId, claimedBy: ctx.claimToken },
            data: { contentHash, attemptCount: 0, lastError: null },
        }));
    } catch (err) {
        // Another ticket (or a request) created the content row a moment ago.
        if (err?.code === "P2002") return deferTicket(ticket, null, ctx);
        throw err;
    }
    if (!count) return "LEASE_LOST";
    return processContentRow({ ...ticket, contentHash, attemptCount: 0, lastError: null }, ctx, dl);
}

async function projectCacheHit(ticket, content, ctx) {
    await tenantTransaction(
        prisma,
        async (tx) => {
            await projectParsedResumeOntoCandidate(tx, {
                tenantId: ctx.tenantId,
                candidateId: ticket.candidateId,
                mediaId: ticket.mediaId,
                parsed: { ...(content.parsedJson ?? {}), contentHash: content.contentHash },
                parseAttemptId: content.id,
                fromCache: true,
                attempts: content.attemptCount,
                ctx: AUTOMATION_CTX,
            });
            await dropTicket(tx, ticket, ctx);
        },
        { tenantId: ctx.tenantId },
    );
    recordResumeParse({ kind: KIND, outcome: "cache-hit" });
    return "CACHE_HIT";
}

async function inheritTerminal(ticket, content, ctx) {
    const exhausted = (content.attemptCount ?? 0) >= PARSE_MAX_ATTEMPTS;
    const status = exhausted ? "EXHAUSTED" : "FAILED";
    await finishTerminal(
        {
            tenantId: ctx.tenantId,
            candidateId: ticket.candidateId,
            mediaId: ticket.mediaId,
            parseAttemptId: content.id,
            status,
            attempts: content.attemptCount ?? 0,
            code: exhausted ? "HR-RESUME-ATTEMPTS-EXHAUSTED" : lastErrorCode(content.lastError),
        },
        async (tx) => await dropTicket(tx, ticket, ctx),
    );
    return status;
}

// A content row in flight with no candidate (a request-path parse) or this
// one: it takes the candidate and the ticket goes; the row's own schedule
// drives the rest.
async function adoptContent(ticket, content, ctx) {
    const unscheduled = content.status === "FAILED" && !content.nextAttemptAt;
    const adopted = await tenantTransaction(
        prisma,
        async (tx) => {
            const { count } = await tx.resumeParseAttempt.updateMany({
                where: {
                    id: content.id,
                    tenantId: ctx.tenantId,
                    OR: [{ candidateId: null }, { candidateId: ticket.candidateId }],
                },
                data: { candidateId: ticket.candidateId, ...(unscheduled ? { nextAttemptAt: ctx.now } : {}) },
            });
            if (!count) return false;
            await dropTicket(tx, ticket, ctx);
            return true;
        },
        { tenantId: ctx.tenantId },
    );
    return adopted ? "ADOPTED" : deferTicket(ticket, content, ctx);
}

// Another candidate's parse of the same bytes is in flight: look again once it
// is due or its lease is out, and take the cache hit then.
async function deferTicket(ticket, content, { tenantId, now, claimToken }) {
    const times = [now.getTime() + DEFER_MS, content?.nextAttemptAt, content?.claimExpiresAt]
        .filter(Boolean)
        .map((t) => new Date(t).getTime());
    await prisma.resumeParseAttempt.updateMany({
        where: { id: ticket.id, tenantId, claimedBy: claimToken },
        data: { status: "PENDING", nextAttemptAt: new Date(Math.max(...times)), ...RELEASE_CLAIM },
    });
    return "DEFERRED";
}

// A ticket-level failure (the DAM download, a projection): counted on the
// ticket under the same ceiling.
async function failTicket(ticket, err, { tenantId, now, claimToken }) {
    const attempt = (ticket.attemptCount ?? 0) + 1;
    const retryable = isRetryableFailure(err);
    const nextAttemptAt = nextAttemptAfterFailure({ attempt, retryable, now });
    const { count } = await prisma.resumeParseAttempt.updateMany({
        where: { id: ticket.id, tenantId, claimedBy: claimToken },
        data: { status: "FAILED", attemptCount: attempt, lastError: errorText(err), nextAttemptAt, ...RELEASE_CLAIM },
    });
    if (!count) return "LEASE_LOST";
    recordResumeParse({ kind: KIND, outcome: "failed" });

    const candidate = { tenantId, candidateId: ticket.candidateId };
    if (nextAttemptAt) {
        await setCandidateState(prisma, { ...candidate, status: "FAILED", code: err?.code ?? null });
        return "RETRY_SCHEDULED";
    }
    const status = retryable ? "EXHAUSTED" : "FAILED";
    await finishTerminal({
        ...candidate,
        mediaId: ticket.mediaId,
        parseAttemptId: ticket.id,
        status,
        attempts: attempt,
        code: err?.code ?? null,
    });
    return status;
}
