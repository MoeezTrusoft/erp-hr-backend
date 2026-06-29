// src/jobs/outbox.loop.js — A.4 boot loop (WBS worker-wiring / T-P3.x).
//
// WHY THIS EXISTS
//   src/jobs/outbox.dispatcher.js is the durable, idempotent PRODUCER step: one
//   call to runOutboxDispatch() claims a batch of unpublished OutboxEvent rows
//   under a lease and XADDs each conformant EventEnvelope onto the `hr:events`
//   Redis stream (createStreamPublisher). scripts/outbox-dispatch.js wraps it
//   for one-shot / cron invocation.
//
//   What was MISSING was an in-process driver: nothing made the dispatcher run
//   on its own when the HR service boots, so hr.employee.lifecycle.v1 events
//   sat in the outbox until an external cron fired. This module is that driver
//   — a periodic, best-effort drain loop wired into server boot, mirroring how
//   comms wires startRealtimeBridge and the gateway wires startNotifyConsumer:
//     * recursive setTimeout (env-tunable interval, default ~3s),
//     * best-effort — a drain failure logs via pino and backs off; it NEVER
//       takes down the HTTP server,
//     * owns its OWN ioredis client (a long-lived publisher must not share the
//       request-path client) + a stable workerId for claim ownership,
//     * a stop() wired to SIGINT/SIGTERM graceful shutdown,
//     * guarded for tests/dev so the suite never spawns a real timer
//       (NODE_ENV=test => disabled no-op; REDIS_URL absent => disabled).
//
//   The dispatcher is already idempotent (claim/lease/dedup via eid). We are
//   only WIRING it to run, not rewriting it.
//
// SAFETY: pino only; never logs payload bodies/tenant ids (the dispatcher
// already enforces this). Bounded counts + worker id only.
import Redis from 'ioredis';

import defaultPrisma from '../lib/prisma.js';
import defaultLogger from '../lib/logger.js';
import {
    runOutboxDispatch,
    createStreamPublisher,
    sanitiseWorkerId,
    generateWorkerId,
} from './outbox.dispatcher.js';

// Default cadence for the in-process drain. Env-tunable via
// HR_OUTBOX_DISPATCH_INTERVAL_MS. Kept in the 2–5s band the boot-loop pattern
// uses fleet-wide so a freshly-written outbox row relays live within seconds.
export const DEFAULT_DISPATCH_INTERVAL_MS = 3000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 5 * 60_000;

// After a drain THROWS we wait this long before the next attempt so a flapping
// Redis/PG does not hot-loop. Mirrors the comms/gateway 1s back-off.
const ERROR_BACKOFF_MS = 1000;

function clampInterval(ms, fallback = DEFAULT_DISPATCH_INTERVAL_MS) {
    const n = Number.isFinite(ms) ? Math.floor(ms) : Number.parseInt(ms, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
    if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
    return n;
}

/**
 * Drive an injected, idempotent drain `run()` on a recursive-setTimeout cadence.
 *
 * This is the pure loop mechanism — no Redis/prisma here so it is trivially and
 * deterministically testable with an injected clock. `run` is expected to be a
 * thunk that performs ONE batch (see startHrOutboxDispatcher for the real one).
 *
 * Best-effort contract: a `run()` rejection is caught, logged, and the loop
 * backs off and reschedules — it never propagates out of the loop.
 *
 * @param {object}   args
 * @param {() => Promise<any>} args.run     one idempotent drain batch.
 * @param {number}  [args.intervalMs]       cadence between batches.
 * @param {number}  [args.errorBackoffMs]   delay after a throwing batch.
 * @param {object}  [args.logger]           pino logger.
 * @param {Function}[args.setTimeoutFn]     injectable timer (tests).
 * @param {Function}[args.clearTimeoutFn]   injectable timer (tests).
 * @returns {{ stop: () => Promise<void>, whenIdle: () => Promise<void> }}
 */
export function startOutboxDispatchLoop({
    run,
    intervalMs = DEFAULT_DISPATCH_INTERVAL_MS,
    errorBackoffMs = ERROR_BACKOFF_MS,
    logger = defaultLogger,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
} = {}) {
    if (typeof run !== 'function') {
        throw new Error('startOutboxDispatchLoop: run must be a function');
    }
    const interval = clampInterval(intervalMs);

    let running = true;
    let timer = null;
    // The promise of the in-flight tick, so stop()/tests can await quiescence.
    let inflight = Promise.resolve();

    const schedule = (delay) => {
        if (!running) return;
        timer = setTimeoutFn(tick, delay);
        // A background drain must never keep the event loop (process) alive on
        // its own — the HTTP server is what holds the process open. unref() is
        // present on real Node timers; injected test timers won't have it.
        if (timer && typeof timer.unref === 'function') timer.unref();
    };

    function tick() {
        timer = null;
        if (!running) return;
        inflight = (async () => {
            let nextDelay = interval;
            try {
                await run();
            } catch (err) {
                nextDelay = errorBackoffMs;
                logger.warn?.(
                    { err: { message: err?.message } },
                    'hr outbox loop: drain failed — backing off'
                );
            }
            schedule(nextDelay);
        })();
    }

    // Kick immediately so a row already waiting at boot relays without waiting
    // a full interval first (mirrors comms/gateway booting the drain at once).
    tick();

    return {
        async stop() {
            if (!running) {
                // Idempotent: still await any tail tick already in flight.
                try { await inflight; } catch { /* best effort */ }
                return;
            }
            running = false;
            if (timer != null) {
                clearTimeoutFn(timer);
                timer = null;
            }
            try { await inflight; } catch { /* loop already unwinding */ }
        },
        // Test/observability helper: resolves once the current tick settles.
        async whenIdle() {
            try { await inflight; } catch { /* surfaced via logger inside tick */ }
        },
    };
}

function isEnabledFlag(raw, defaultWhenUnset = true) {
    if (raw === undefined || raw === null || raw === '') return defaultWhenUnset;
    return String(raw).toLowerCase() !== 'false';
}

/**
 * Server-boot entrypoint. Decides whether to run the loop, owns the Redis
 * client + stream publisher, and binds a stable workerId, then delegates the
 * cadence to startOutboxDispatchLoop.
 *
 * DISABLED (returns a no-op handle, enabled:false) when:
 *   * NODE_ENV === 'test'                       — never spawn timers in the suite,
 *   * HR_OUTBOX_DISPATCH_ENABLED === 'false'    — explicit ops kill-switch,
 *   * REDIS_URL is not configured               — nothing to XADD to.
 *
 * Best-effort: any boot error is caught and downgraded to a disabled handle so
 * a Redis hiccup at startup can NEVER take down the HTTP server. The returned
 * handle always exposes an async stop() safe to call from graceful shutdown.
 *
 * @returns {{ enabled: boolean, stop: () => Promise<void>, workerId?: string }}
 */
export function startHrOutboxDispatcher({
    env = process.env,
    prisma = defaultPrisma,
    logger = defaultLogger,
    redisFactory = (url) => new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    }),
} = {}) {
    const noop = { enabled: false, stop: async () => {} };

    if (String(env.NODE_ENV).toLowerCase() === 'test') {
        return noop;
    }
    if (!isEnabledFlag(env.HR_OUTBOX_DISPATCH_ENABLED)) {
        logger.info?.('hr outbox loop: disabled via HR_OUTBOX_DISPATCH_ENABLED=false');
        return noop;
    }
    const redisUrl = env.REDIS_URL;
    if (!redisUrl) {
        logger.warn?.('hr outbox loop: REDIS_URL not configured — dispatcher loop disabled');
        return noop;
    }

    try {
        const redis = redisFactory(redisUrl);
        redis.on?.('error', (err) =>
            logger.warn?.({ err: { message: err?.message } }, 'hr outbox loop: redis error'));

        const publisher = createStreamPublisher({ redis });
        const workerId = sanitiseWorkerId(env.HR_OUTBOX_WORKER_ID) || generateWorkerId();
        const intervalMs = clampInterval(
            Number.parseInt(env.HR_OUTBOX_DISPATCH_INTERVAL_MS ?? '', 10)
        );
        const batchSize = Number.parseInt(env.HR_OUTBOX_DISPATCH_BATCH ?? '', 10) || undefined;
        const leaseMs = Number.parseInt(env.HR_OUTBOX_DISPATCH_LEASE_MS ?? '', 10) || undefined;

        const loop = startOutboxDispatchLoop({
            intervalMs,
            logger,
            run: () => runOutboxDispatch({
                publisher,
                workerId,
                batchSize,
                leaseMs,
                prisma,
                logger,
            }),
        });

        logger.info?.(
            { stream: 'hr:events', workerId, intervalMs },
            'hr outbox loop: dispatcher started'
        );

        return {
            enabled: true,
            workerId,
            async stop() {
                await loop.stop();
                try { await redis.quit(); } catch { /* best effort */ }
            },
        };
    } catch (err) {
        // Boot failure is best-effort: log and hand back a safe disabled handle.
        logger.error?.(
            { err: { message: err?.message } },
            'hr outbox loop: failed to start — continuing without in-process dispatch'
        );
        return noop;
    }
}

export default startHrOutboxDispatcher;
