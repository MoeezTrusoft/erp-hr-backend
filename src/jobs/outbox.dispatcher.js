// src/jobs/outbox.dispatcher.js — A.4 · ARCH-01 §7–§8.
//
// Single-pass, multi-replica claim/lease dispatcher for the HR OutboxEvent
// table. One run claims up to `batchSize` candidate rows under a lease
// (claimedAt / claimedBy / claimExpiresAt), publishes each via XADD to a Redis
// stream, then either marks publishedAt + releases the claim on success, or
// releases the claim + records lastError on failure (retryable next batch).
//
// Concurrency / idempotency:
//   * A row is a candidate when publishedAt IS NULL AND (claimedAt IS NULL OR
//     claimExpiresAt < NOW()).
//   * The per-row claim is a conditional updateMany; count=1 wins, count=0
//     loses the race and is skipped this run.
//   * Two workers cannot hold the same row's claim simultaneously. The only
//     duplicate window is lease-expiry mid-publish; the stream carries
//     eid = EventEnvelope.id so consumers dedupe (at-least-once).
//
// Heartbeat: each batch records a monotonic-ish wall-clock beat so GET
// /compliance (A.6) can assert the dispatcher is alive.
//
// Payload safety: never logs row.payload (the producer bounds it on write).
import crypto from 'node:crypto';
import os from 'node:os';

import defaultPrisma from '../lib/prisma.js';
import defaultLogger from '../lib/logger.js';
import { mcpCtx } from '../mcp/context.js';

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 10 * 60_000;
const LAST_ERROR_MAX_LEN = 512;
const WORKER_ID_MAX_LEN = 128;

// REQ-A.4 — the durable Redis stream the HR outbox drains into.
export const HR_EVENTS_STREAM = 'hr:events';

// Default freshness window for the dispatcher heartbeat (A.6). A dispatcher
// that has not beaten within this window is considered stale/down.
export const DEFAULT_HEARTBEAT_MAX_STALE_MS = 2 * 60_000;

// Process-wide heartbeat store. Mutated by recordDispatcherHeartbeat after each
// batch and read by readDispatcherHeartbeat (wired into /compliance). Kept in a
// plain object so tests can inject their own store.
const heartbeatStore = { lastBeatMs: null };

function truncate(value, max = LAST_ERROR_MAX_LEN) {
    if (value == null) return null;
    const s = typeof value === 'string' ? value : (value?.message ?? String(value));
    return s.length > max ? s.slice(0, max) : s;
}

function clampBatch(size) {
    const n = Number.isFinite(size) ? Math.floor(size) : DEFAULT_BATCH_SIZE;
    if (n <= 0) return DEFAULT_BATCH_SIZE;
    if (n > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
    return n;
}

function clampLease(ms) {
    const n = Number.isFinite(ms) ? Math.floor(ms) : DEFAULT_LEASE_MS;
    if (n < MIN_LEASE_MS) return MIN_LEASE_MS;
    if (n > MAX_LEASE_MS) return MAX_LEASE_MS;
    return n;
}

/**
 * Sanitise an externally-supplied worker id to [A-Za-z0-9._:-], capped at 128
 * chars. Returns null if nothing survives.
 */
export function sanitiseWorkerId(raw) {
    if (raw == null) return null;
    const cleaned = String(raw).split('').filter((c) => /[A-Za-z0-9._:-]/.test(c)).join('');
    const trimmed = cleaned.slice(0, WORKER_ID_MAX_LEN);
    return trimmed.length > 0 ? trimmed : null;
}

/** Generate a host:pid:rand worker id for claim ownership in logs. */
export function generateWorkerId() {
    const host = sanitiseWorkerId(os.hostname()) || 'host';
    const pid = String(process.pid || 0);
    const suffix = crypto.randomBytes(4).toString('hex');
    return sanitiseWorkerId(`${host}:${pid}:${suffix}`);
}

/**
 * Build a publisher that XADDs each event onto the HR Redis stream. The
 * `payload` IS the conformant EventEnvelope persisted on the outbox row; the
 * stream carries it verbatim. `eid` mirrors EventEnvelope.id and is the
 * consumer-side dedup key (at-least-once delivery).
 *
 *   XADD hr:events * event=<name> envelope=<json> eid=<envelope.id> srcId=<aggregateId>
 */
export function createStreamPublisher({ redis, stream = HR_EVENTS_STREAM } = {}) {
    if (!redis || typeof redis.xadd !== 'function') {
        throw new Error('createStreamPublisher: redis.xadd is required');
    }
    return async function streamPublisher({ eventName, payload, aggregateId }) {
        const eid = payload?.id ?? '';
        const srcId = aggregateId != null ? String(aggregateId) : '';
        return redis.xadd(
            stream,
            '*',
            'event', String(eventName),
            'envelope', JSON.stringify(payload),
            'eid', String(eid),
            'srcId', srcId,
        );
    };
}

/** Record a dispatcher heartbeat (called after each batch). */
export function recordDispatcherHeartbeat({ store = heartbeatStore, now = Date.now } = {}) {
    store.lastBeatMs = typeof now === 'function' ? now() : now;
    return store.lastBeatMs;
}

/**
 * Read the dispatcher heartbeat for /compliance (A.6). ok=true when a beat has
 * been recorded within maxStaleMs.
 */
export function readDispatcherHeartbeat({
    store = heartbeatStore,
    now = Date.now,
    maxStaleMs = DEFAULT_HEARTBEAT_MAX_STALE_MS,
} = {}) {
    const nowMs = typeof now === 'function' ? now() : now;
    const lastBeatMs = store.lastBeatMs ?? null;
    if (lastBeatMs == null) {
        return { ok: false, lastBeatMs: null, staleMs: null, maxStaleMs };
    }
    const staleMs = nowMs - lastBeatMs;
    return { ok: staleMs <= maxStaleMs, lastBeatMs, staleMs, maxStaleMs };
}

const emptyCounts = () => ({
    scanned: 0,
    claimed: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    claimRaceLost: 0,
    claimExpiredMidPublish: 0,
    bookkeepingFailed: 0,
});

/**
 * Run ONE batch of outbox dispatch under a claim lease.
 *
 * @param {object} args
 * @param {(event: object) => Promise<any>} args.publisher  must throw on failure.
 * @param {string} args.workerId   ≤128 chars, [A-Za-z0-9._:-].
 * @param {number} [args.batchSize=50]
 * @param {number} [args.leaseMs=60000]
 * @param {object} [args.prisma]
 * @param {object} [args.logger]
 * @param {object} [args.heartbeat]  injectable { store, now } for the beat.
 * @returns {Promise<object>} counts.
 */
// Cross-tenant outbox drain runs as SYSTEM (the tenant-scope extension denies
// tenant-model queries with no context). Each outbox row carries its own tenant;
// the dispatcher spans all tenants.
export async function runOutboxDispatch(opts = {}) {
    return mcpCtx.run({ system: true }, async () => _runOutboxDispatch(opts));
}

async function _runOutboxDispatch({
    publisher,
    workerId,
    batchSize = DEFAULT_BATCH_SIZE,
    leaseMs = DEFAULT_LEASE_MS,
    prisma = defaultPrisma,
    logger = defaultLogger,
    heartbeat = {},
} = {}) {
    if (typeof publisher !== 'function') {
        throw new Error('runOutboxDispatch: publisher must be a function');
    }
    const safeWorker = sanitiseWorkerId(workerId);
    if (!safeWorker) {
        throw new Error('runOutboxDispatch: workerId is required (≤128 chars, [A-Za-z0-9._:-])');
    }

    const oxbox = prisma?.outboxEvent;
    if (!oxbox?.findMany || !oxbox?.updateMany) {
        logger.warn?.(
            { eventName: 'hr.outbox.dispatch' },
            'OutboxEvent model unavailable on prisma client — skipping dispatch'
        );
        return emptyCounts();
    }

    const take = clampBatch(batchSize);
    const lease = clampLease(leaseMs);
    const startedAt = new Date();
    const claimDeadline = new Date(startedAt.getTime() + lease);

    // 1) Candidate scan.
    const candidates = await oxbox.findMany({
        where: {
            publishedAt: null,
            OR: [{ claimedAt: null }, { claimExpiresAt: { lt: startedAt } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
    });

    // 2) Per-row conditional claim.
    const claimedRows = [];
    let claimRaceLost = 0;
    for (const row of candidates) {
        const claim = await oxbox.updateMany({
            where: {
                id: row.id,
                publishedAt: null,
                OR: [{ claimedAt: null }, { claimExpiresAt: { lt: startedAt } }],
            },
            data: { claimedAt: startedAt, claimedBy: safeWorker, claimExpiresAt: claimDeadline },
        });
        if (claim.count === 1) claimedRows.push(row);
        else claimRaceLost += 1;
    }

    // 3) Publish each claimed row.
    let published = 0;
    let failed = 0;
    let claimExpiredMidPublish = 0;
    let bookkeepingFailed = 0;

    for (const row of claimedRows) {
        try {
            await publisher({
                id: row.id,
                eventName: row.eventName,
                aggregateType: row.aggregateType,
                aggregateId: row.aggregateId,
                tenantId: row.tenantId,
                payload: row.payload,
                attempts: row.attempts,
            });

            const mark = await oxbox.updateMany({
                where: { id: row.id, claimedBy: safeWorker, publishedAt: null },
                data: {
                    publishedAt: new Date(),
                    lastError: null,
                    attempts: { increment: 1 },
                    claimedAt: null,
                    claimedBy: null,
                    claimExpiresAt: null,
                },
            });

            if (mark.count === 1) {
                published += 1;
            } else {
                claimExpiredMidPublish += 1;
                logger.warn?.(
                    { id: row.id, eventName: row.eventName, workerId: safeWorker },
                    'outbox dispatcher: lease expired between publish and mark — at-least-once delivery'
                );
            }
        } catch (err) {
            failed += 1;
            try {
                await oxbox.updateMany({
                    where: { id: row.id, claimedBy: safeWorker },
                    data: {
                        attempts: { increment: 1 },
                        lastError: truncate(err?.message ?? err),
                        claimedAt: null,
                        claimedBy: null,
                        claimExpiresAt: null,
                    },
                });
            } catch (updErr) {
                bookkeepingFailed += 1;
                logger.warn?.(
                    { id: row.id, workerId: safeWorker },
                    'outbox dispatcher: failed to record dispatch error'
                );
            }
            logger.warn?.(
                {
                    id: row.id,
                    eventName: row.eventName,
                    aggregateType: row.aggregateType,
                    aggregateId: row.aggregateId,
                    attempts: row.attempts + 1,
                    workerId: safeWorker,
                    errMessage: truncate(err?.message ?? err, 200),
                },
                'outbox dispatcher: publish failed'
            );
        }
    }

    const counts = {
        scanned: candidates.length,
        claimed: claimedRows.length,
        published,
        failed,
        skipped: claimRaceLost + claimExpiredMidPublish,
        claimRaceLost,
        claimExpiredMidPublish,
        bookkeepingFailed,
    };

    // Heartbeat after a completed batch (liveness signal for /compliance).
    recordDispatcherHeartbeat(heartbeat);

    logger.info?.(
        { ...counts, workerId: safeWorker, batchSize: take, leaseMs: lease },
        'outbox dispatcher: batch complete'
    );

    return counts;
}

export default runOutboxDispatch;
