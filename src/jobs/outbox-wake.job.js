// src/jobs/outbox-wake.job.js: LISTEN hr_outbox wake for the outbox loop.
//
// The hr_outbox_immediate statement trigger (migration
// 20261015130000_pm_availability_events) runs pg_notify('hr_outbox') on every
// outbox insert; the notification is delivered at commit. This job holds one
// dedicated LISTEN connection and calls wake() so a committed event relays at
// once instead of waiting for the next poll.
//
// LISTEN is only a wake signal. Durable outbox rows and the dispatcher claim
// lease stay authoritative, and the loop's interval poll keeps draining when
// this connection is down (reconnects every reconnectMs). It needs a session
// connection, so it prefers DIRECT_DATABASE_URL (PgBouncer transaction pooling
// drops LISTEN registrations).
import pg from 'pg';

import defaultLogger from '../lib/logger.js';

export const HR_OUTBOX_CHANNEL = 'hr_outbox';
const DEFAULT_RECONNECT_MS = 5000;

/**
 * @param {() => void} wake  called on every notification and after (re)connect.
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {object} [opts.logger]
 * @param {(config: object) => object} [opts.clientFactory]  injectable (tests).
 * @param {number} [opts.reconnectMs]
 * @returns {() => Promise<void>} stop
 */
export function startOutboxWake(wake, {
    env = process.env,
    logger = defaultLogger,
    clientFactory = (config) => new pg.Client(config),
    reconnectMs = DEFAULT_RECONNECT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
} = {}) {
    if (typeof wake !== 'function') throw new Error('startOutboxWake: wake must be a function');
    const connectionString = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
    if (!connectionString) {
        logger.warn?.('hr outbox wake: no database URL; interval polling only');
        return async () => {};
    }

    let client = null;
    let connecting = false;
    let stopped = false;
    let warned = false;

    async function connect() {
        if (client || connecting || stopped) return;
        connecting = true;
        const next = clientFactory({ connectionString, connectionTimeoutMillis: 10_000 });
        const drop = () => {
            if (client === next) client = null;
        };
        next.on('error', () => {
            drop();
            next.end().catch(() => {});
        });
        next.on('end', drop);
        try {
            await next.connect();
            await next.query(`LISTEN ${HR_OUTBOX_CHANNEL}`);
            next.on('notification', (msg) => {
                if (msg?.channel === HR_OUTBOX_CHANNEL) wake();
            });
            if (stopped) {
                await next.end().catch(() => {});
                return;
            }
            client = next;
            warned = false;
            wake();
        } catch (err) {
            await next.end().catch(() => {});
            if (!warned) {
                logger.warn?.({ err: { message: err?.message } }, 'hr outbox wake unavailable; interval polling only');
                warned = true;
            }
        } finally {
            connecting = false;
        }
    }

    const timer = setIntervalFn(connect, reconnectMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const first = connect();

    return async function stop() {
        stopped = true;
        clearIntervalFn(timer);
        await first.catch(() => {});
        const current = client;
        client = null;
        if (current) await current.end().catch(() => {});
    };
}

export default startOutboxWake;
