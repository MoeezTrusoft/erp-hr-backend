// src/services/resume-parse-queue.service.js
//
// Phase 2 — queue a candidate's resume for the asynchronous parse worker. The
// intake paths call this instead of parsing in the request, so an applicant
// never waits on the AI plane and a plane outage never fails an application.
//
// Contract (callers rely on it): never throws for a missing resume or a
// failed queue write; returns { queued: boolean, reason?: string }.
//
// WHY A TICKET ROW. The parse ledger (resume_parse_attempts) is keyed by
// (tenantId, kind, contentHash), and that key is the cache (D-13: per tenant)
// and the home of the three-attempt ceiling. The hash is unknown until the
// file is downloaded, which must not happen in the request. So the queue entry
// is a ledger row with a placeholder key, a "ticket":
//
//     contentHash = "pending:c<candidateId>:m<mediaId>"   (parseTicketHash)
//     status PENDING, attemptCount 0, candidateId, mediaId, nextAttemptAt = now
//
// A SHA-256 hex digest has no colon, so a ticket can never collide with or be
// served as a cache entry, and the unique key makes the enqueue idempotent per
// tenant + candidate + media. The worker resolves a ticket once it has the
// bytes (resume-parse-worker.service.js):
//   * no content row for that hash  -> the ticket BECOMES the content row (its
//                                      key is rewritten to the real hash) and
//                                      runs attempt 1;
//   * a COMPLETED content row        -> cache hit: project it, drop the ticket
//                                      (no plane call; same tenant only, since
//                                      the lookup carries the ticket's tenant);
//   * a terminal content row         -> the candidate gets FAILED/EXHAUSTED and
//                                      the ticket is dropped (the ceiling is per
//                                      content, so a re-upload of the same bytes
//                                      does not buy three more attempts);
//   * a content row still in flight  -> it is adopted when it has no candidate
//                                      (or this one); when it serves another
//                                      candidate the ticket waits for it and
//                                      then takes the cache hit.
// Attempts are only ever counted on content rows. A ticket spends nothing
// except on DAM download failures, which it counts on itself under the same
// three-attempt ceiling.
//
// The read side for the MCP tools (parse status and a recruiter re-queue) lives
// here too: it is the queue's view of one candidate.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { candidateScopeWhere } from "../lib/recruitment-access.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import {
    PARSE_MAX_ATTEMPTS,
    PARSE_TICKET_PREFIX,
    isParseTicket,
    lastErrorCode,
    parseTicketHash,
} from "../lib/parse-retry.util.js";

const KIND = "CANDIDATE";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const leaseIsLive = (row, now) =>
    row?.status === "RUNNING" && row.claimExpiresAt && new Date(row.claimExpiresAt).getTime() > new Date(now).getTime();

/**
 * A ledger row with no attempt left: FAILED with nothing scheduled. (A FAILED
 * row with nextAttemptAt is a retry waiting for the worker.)
 */
export const isTerminalParseRow = (row) => row?.status === "FAILED" && !row.nextAttemptAt;

// The reset a forced re-queue applies to a ticket or content row: the ceiling
// and any stored answer go, the row is due now.
const resetData = (now, candidateId) => ({
    status: "PENDING",
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: now,
    claimedBy: null,
    claimExpiresAt: null,
    candidateId,
});

// Run `fn` with the tenant as the request tenant. Background and portal callers
// may arrive without one; a caller already holding a DIFFERENT tenant is refused.
function inTenantContext(tenantId, fn) {
    const store = mcpCtx.getStore();
    const current = store?.user?.tenantId;
    if (current && current !== tenantId) {
        throw fail("Tenant context mismatch", 403, "HR-TENANT-MISMATCH");
    }
    if (current || store?.system) return fn();
    return mcpCtx.run({ ...(store ?? {}), user: { ...(store?.user ?? {}), tenantId } }, async () => await fn());
}

async function enqueueWith(db, { tenantId, candidateId, mediaId, force, now }) {
    const candidate = await db.candidate.findFirst({
        where: withTenant(tenantId, { id: candidateId }),
        select: { id: true, parseStatus: true, parsedResume: true },
    });
    if (!candidate) return { queued: false, reason: "CANDIDATE_NOT_FOUND" };
    if (!force && candidate.parseStatus === "COMPLETED" && Number(candidate.parsedResume?.mediaId) === mediaId) {
        return { queued: false, reason: "ALREADY_PARSED" };
    }

    const ledger = db.resumeParseAttempt;
    const key = { tenantId_kind_contentHash: { tenantId, kind: KIND, contentHash: parseTicketHash(candidateId, mediaId) } };
    const ticket = await ledger.findUnique({ where: key });

    if (force) {
        // Reset the content rows of this media (and the ones this candidate
        // owns), so a forced re-queue really buys a fresh ceiling, plus this
        // ticket. Other candidates' tickets are never touched, and a live
        // attempt is left alone.
        const notLive = { NOT: { status: "RUNNING", claimExpiresAt: { gt: now } } };
        await ledger.updateMany({
            where: withTenant(tenantId, {
                kind: KIND,
                OR: [{ mediaId }, { candidateId }],
                AND: [{ NOT: { contentHash: { startsWith: PARSE_TICKET_PREFIX } } }, notLive],
            }),
            data: resetData(now, candidateId),
        });
        if (ticket) {
            await ledger.updateMany({ where: withTenant(tenantId, { id: ticket.id, ...notLive }), data: resetData(now, candidateId) });
        }
    }

    if (ticket && !force) {
        if (isTerminalParseRow(ticket)) return { queued: false, reason: "EXHAUSTED" };
        return markPending(db, { tenantId, candidateId, reason: "ALREADY_QUEUED" });
    }
    if (!ticket) {
        try {
            await ledger.create({
                data: {
                    kind: KIND,
                    contentHash: key.tenantId_kind_contentHash.contentHash,
                    mediaId,
                    candidateId,
                    status: "PENDING",
                    attemptCount: 0,
                    nextAttemptAt: now,
                    tenantId,
                },
            });
        } catch (err) {
            // Two intake calls raced on the same key: the other one queued it.
            if (err?.code !== "P2002") throw err;
            return markPending(db, { tenantId, candidateId, reason: "ALREADY_QUEUED" });
        }
    }
    return markPending(db, { tenantId, candidateId });
}

async function markPending(db, { tenantId, candidateId, reason }) {
    await db.candidate.updateMany({
        where: withTenant(tenantId, { id: candidateId }),
        data: { parseStatus: "PENDING", parseError: null },
    });
    return reason ? { queued: true, reason } : { queued: true };
}

/**
 * Queue a candidate's resume for the parse worker.
 *
 * Idempotent per tenant + candidate + media: a second call while the entry is
 * waiting returns { queued: true, reason: "ALREADY_QUEUED" }; a call after the
 * same media parsed returns { queued: false, reason: "ALREADY_PARSED" }.
 * `force` resets the ceiling for this media (the operator's explicit re-run).
 *
 * Pass `tx` to write inside the caller's transaction (e.g. the application
 * insert, so the candidate row is visible); otherwise the write runs in its
 * own tenant transaction.
 *
 * @param {{ tenantId: string, candidateId: number, mediaId: number, applicationId?: number|null,
 *           force?: boolean, tx?: object|null, now?: Date }} args
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
export async function enqueueCandidateResumeParse({
    tenantId,
    candidateId,
    mediaId,
    applicationId = null,
    force = false,
    tx = null,
    now = new Date(),
} = {}) {
    const candidate = positiveInt(candidateId);
    const media = positiveInt(mediaId);
    if (!tenantId || !candidate || !media) {
        return { queued: false, reason: "MISSING_INPUT" };
    }
    const args = { tenantId, candidateId: candidate, mediaId: media, force: force === true, now: new Date(now) };
    try {
        const result = tx
            ? await enqueueWith(tx, args)
            : await inTenantContext(tenantId, async () =>
                await tenantTransaction(prisma, async (db) => await enqueueWith(db, args), { tenantId }));
        logger.info({ candidateId: candidate, applicationId, ...result }, "resume parse: enqueue");
        return result;
    } catch (err) {
        logger.warn({ errCode: err?.code, errMessage: err?.message, candidateId: candidate, applicationId }, "resume parse: could not queue");
        return { queued: false, reason: "QUEUE_WRITE_FAILED" };
    }
}

// ── the MCP read/write side ──────────────────────────────────────────────────

async function findScopedCandidate({ tenantId, candidateId, scope }) {
    const id = positiveInt(candidateId);
    if (!id) throw fail("candidateId must be a positive integer", 400, "HR-RECRUITMENT-BAD-REQUEST");
    const candidate = await prisma.candidate.findFirst({
        where: withTenant(tenantId, { id, ...candidateScopeWhere(scope) }),
        select: { id: true, resumeMediaId: true, parseStatus: true, parsedAt: true, parsedResume: true },
    });
    if (!candidate) throw fail("Candidate not found", 404, "HR-RECRUITMENT-CANDIDATE-NOT-FOUND");
    return candidate;
}

// The ledger rows that speak for this candidate: its tickets and adopted
// content rows, plus the content row its last parse came from (a cache hit on
// another candidate's row). Newest first.
async function candidateParseRows({ tenantId, candidate }) {
    const contentHash = candidate.parsedResume?.contentHash;
    return prisma.resumeParseAttempt.findMany({
        where: withTenant(tenantId, {
            kind: KIND,
            OR: [{ candidateId: candidate.id }, ...(contentHash ? [{ contentHash: String(contentHash) }] : [])],
        }),
        select: {
            id: true,
            contentHash: true,
            mediaId: true,
            status: true,
            attemptCount: true,
            lastError: true,
            nextAttemptAt: true,
            claimExpiresAt: true,
            updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
    });
}

// The row describing the CURRENT resume: one for its media id when there is
// one, else the newest.
const currentRow = (rows, mediaId) => rows.find((row) => Number(row.mediaId) === Number(mediaId)) ?? rows[0] ?? null;

/**
 * The candidate's resume parse status for recruiters: the candidate-facing
 * state plus the queue's view (attempts, next attempt, last error CODE only:
 * the stored text can quote plane output and is never returned).
 */
export async function getCandidateResumeParseStatus({ tenantId, candidateId, scope, now = new Date() }) {
    const candidate = await findScopedCandidate({ tenantId, candidateId, scope });
    const row = currentRow(await candidateParseRows({ tenantId, candidate }), candidate.resumeMediaId);
    const code = lastErrorCode(row?.lastError);
    return {
        candidateId: candidate.id,
        resumeMediaId: candidate.resumeMediaId ?? null,
        parseStatus: candidate.parseStatus ?? null,
        parsedAt: candidate.parsedAt ?? null,
        workerEnabled: isRecruitmentFlagEnabled("parseWorker") && isRecruitmentFlagEnabled("ai"),
        queue: row
            ? {
                stage: isParseTicket(row) ? "QUEUED" : "CONTENT",
                status: leaseIsLive(row, now) ? "RUNNING" : row.status,
                attempts: row.attemptCount ?? 0,
                maxAttempts: PARSE_MAX_ATTEMPTS,
                nextAttemptAt: row.nextAttemptAt ?? null,
                terminal: isTerminalParseRow(row),
                lastErrorCode: code,
                awaitingLateResult: code === "HR-RESUME-PLANE-PENDING" && !!row.nextAttemptAt,
                updatedAt: row.updatedAt ?? null,
            }
            : null,
    };
}

/**
 * Re-queue the candidate's current resume (recruiters only). Without `force` a
 * resume whose attempts are spent is refused (HR-RECRUITMENT-PARSE-EXHAUSTED);
 * `force` resets the ceiling for that content, as the request-path force does.
 */
export async function requeueCandidateResumeParse({ tenantId, candidateId, scope, force = false, now = new Date() }) {
    if (scope?.unrestricted !== true) {
        throw fail("Only recruiters can re-queue a resume parse", 403, "HR-RECRUITMENT-PARSE-FORBIDDEN");
    }
    const candidate = await findScopedCandidate({ tenantId, candidateId, scope });
    if (!candidate.resumeMediaId) throw fail("Candidate has no resume to parse", 400, "HR-RECRUITMENT-NO-RESUME");

    if (!force) {
        const row = currentRow(await candidateParseRows({ tenantId, candidate }), candidate.resumeMediaId);
        if (row && isTerminalParseRow(row)) {
            throw fail("The resume's parse attempts are spent; re-queue with force to reset them", 409, "HR-RECRUITMENT-PARSE-EXHAUSTED");
        }
    }

    const result = await enqueueCandidateResumeParse({
        tenantId,
        candidateId: candidate.id,
        mediaId: candidate.resumeMediaId,
        force: force === true,
        now,
    });
    if (result.reason === "QUEUE_WRITE_FAILED") {
        throw fail("The resume could not be queued", 503, "HR-RECRUITMENT-PARSE-QUEUE-FAILED");
    }
    if (result.reason === "EXHAUSTED") {
        throw fail("The resume's parse attempts are spent; re-queue with force to reset them", 409, "HR-RECRUITMENT-PARSE-EXHAUSTED");
    }
    return {
        candidateId: candidate.id,
        resumeMediaId: candidate.resumeMediaId,
        ...result,
        workerEnabled: isRecruitmentFlagEnabled("parseWorker") && isRecruitmentFlagEnabled("ai"),
    };
}
