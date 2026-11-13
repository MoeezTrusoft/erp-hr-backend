// src/services/attendanceRealtime.publisher.js — X-13 retirement of socket.io.
//
// ARCH-01 §7.7/§13 + BE-audit §7.2 (X-13): the HR service must NOT run its own
// realtime transport (the self-hosted socket.io server). Attendance realtime
// (live punches, listener status, health) is published onto the fleet Redis
// Streams fabric instead — `hr:attendance` — exactly like the outbox publishes
// to `hr:events`. The gateway SSE spine (the single delivery pipe) consumes the
// stream and fans it to browsers; HR owns the PRODUCER, never the socket.
//
// SEAM
//   * createAttendanceStreamPublisher({ redis }) → a thunk that XADDs one
//     message onto the stream (kind=event|status|health|bootstrap + json).
//   * bindAttendanceRealtimeTransport(publisher) → install the active publisher
//     (called from server boot with the Redis-backed one; unbound in tests).
//   * publishAttendance{Event,Status,Health,Bootstrap}(payload) → the realtime
//     service calls these instead of socketServer.emit(...). No-op + fail-soft
//     when nothing is bound or the publisher rejects — a transport hiccup must
//     never break the attendance INGEST/persist path (the DB is the source of
//     truth; realtime is a best-effort projection).
//
// pino only; never logs PII bodies — the payload is bounded by the realtime
// service (ids + action + timestamps), and we log only counts/kind on failure.
import logger from '../lib/logger.js';

// The durable Redis stream attendance realtime is projected onto. Mirrors the
// `hr:events` outbox stream naming.
export const HR_ATTENDANCE_STREAM = 'hr:attendance';

const realtimeLog = logger.child({ component: 'attendance-realtime-publisher' });

// The single active transport publisher. null ⇒ unbound ⇒ every publish is a
// no-op (tests, or boot when REDIS_URL is unset). A function ⇒ Redis-backed.
let boundPublisher = null;

/**
 * Build a publisher that XADDs one realtime message onto the HR attendance
 * stream. `kind` discriminates the message (event|status|health|bootstrap);
 * `payload` is JSON-encoded verbatim.
 *
 *   XADD hr:attendance * kind=<kind> payload=<json> ts=<iso>
 *
 * @param {object} args
 * @param {object} args.redis        ioredis-like client exposing xadd().
 * @param {string} [args.stream]     override the stream key.
 * @returns {(msg: {kind: string, payload: any}) => Promise<any>}
 */
export function createAttendanceStreamPublisher({ redis, stream = HR_ATTENDANCE_STREAM } = {}) {
    if (!redis || typeof redis.xadd !== 'function') {
        throw new Error('createAttendanceStreamPublisher: redis.xadd is required');
    }
    return async function attendanceStreamPublisher({ kind, payload }) {
        return redis.xadd(
            stream,
            '*',
            'kind', String(kind || 'event'),
            'payload', JSON.stringify(payload ?? null),
            'ts', new Date().toISOString(),
        );
    };
}

/**
 * Install the active realtime publisher. Pass the Redis-backed publisher at
 * server boot; pass null (or call __resetAttendanceTransportForTests) to unbind.
 */
export function bindAttendanceRealtimeTransport(publisher) {
    boundPublisher = typeof publisher === 'function' ? publisher : null;
    realtimeLog.info(
        { bound: !!boundPublisher, stream: HR_ATTENDANCE_STREAM },
        'attendance realtime transport bound'
    );
}

/** True when a transport is currently bound (server has Redis wired). */
export function isAttendanceRealtimeBound() {
    return !!boundPublisher;
}

// Fail-soft dispatch: no-op when unbound; swallow a publisher rejection so the
// ingest path never throws on a transport hiccup.
async function dispatch(kind, payload) {
    if (!boundPublisher) return undefined;
    try {
        await boundPublisher({ kind, payload });
    } catch (err) {
        realtimeLog.warn(
            { kind, err: { message: err?.message } },
            'attendance realtime publish failed (fail-soft)'
        );
    }
    return undefined;
}

export const publishAttendanceEvent = (payload) => dispatch('event', payload);
export const publishAttendanceStatus = (payload) => dispatch('status', payload);
export const publishAttendanceHealth = (payload) => dispatch('health', payload);
export const publishAttendanceBootstrap = (payload) => dispatch('bootstrap', payload);

/** Test helper: hard-reset the bound transport between cases. */
export function __resetAttendanceTransportForTests() {
    boundPublisher = null;
}
