// src/middlewares/idempotency.middleware.js
// C.2 / T-P2.2 — Idempotency-Key support on HR mutating endpoints, mirroring
// comms/pm. An `Idempotency-Key` header (or body.idempotencyKey) makes a repeat
// of a mutating request REPLAY the first response instead of re-applying the
// side effect. The atomic reserve/commit/release lives in
// src/lib/idempotency-store.js — this file is the express adapter.
//
// The cache key is namespaced by the VERIFIED tenant (req.user.tenantId, set by
// internalServiceGuard from the signed service-JWT claim — T-P2.1/X-02), never a
// spoofable header. So the SAME key under a different tenant is a different
// namespace and can never replay another tenant's response.
//
// Store selection: an injected store (unit tests) wins; otherwise a Redis store
// when HR_REDIS_URL / REDIS_URL is configured (cross-replica SET NX PX), else an
// in-process memory store (dev / single replica). The path FAILS OPEN on any
// store error so a degraded cache never blocks a write.

import Redis from 'ioredis';
import logger from '../lib/logger.js';
import { createMemoryStore, createRedisStore } from '../lib/idempotency-store.js';

// Default TTL: 24h (HR mutations are infrequent; a generous replay window).
const DEFAULT_TTL_MS = Number(process.env.HR_IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;

let _sharedRedis = null;
let _sharedRedisAttempted = false;
const _storeByTtl = new Map();

function getSharedRedis() {
    if (_sharedRedisAttempted) return _sharedRedis;
    _sharedRedisAttempted = true;
    const url = process.env.HR_REDIS_URL || process.env.REDIS_URL;
    if (!url) return null;
    const redis = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    });
    redis.on('error', (err) => logger.warn({ err }, 'idempotency redis client error'));
    _sharedRedis = redis;
    return _sharedRedis;
}

function buildStore(ttl) {
    const redis = getSharedRedis();
    if (redis) {
        logger.info({ ttlMs: ttl }, 'hr idempotency store: redis (SET NX PX)');
        return createRedisStore({ redis, ttlMs: ttl });
    }
    logger.warn({ ttlMs: ttl }, 'hr idempotency store: memory (no HR_REDIS_URL — single-process only)');
    return createMemoryStore({ ttlMs: ttl });
}

function getStore(ttl) {
    const cached = _storeByTtl.get(ttl);
    if (cached) return cached;
    const fresh = buildStore(ttl);
    _storeByTtl.set(ttl, fresh);
    return fresh;
}

// Test seam: reset cached shared client + per-TTL store registry.
export function _resetDefaultStoreForTests() {
    _sharedRedis = null;
    _sharedRedisAttempted = false;
    _storeByTtl.clear();
}

/**
 * MCP adapter for the SAME Redis/memory idempotency store used by the REST
 * middleware. API-3 — side-effectful MCP write TOOLS that are not naturally
 * idempotent (create / run / submit / finalize / generate) accept an optional
 * `idempotencyKey` arg; when present we reserve→commit→replay through this
 * helper so a retried tool call returns its first result instead of re-applying
 * the side effect. Reuses getStore() so the shared Redis client (SET NX PX
 * across replicas) is not duplicated.
 *
 * The cache key is namespaced by the VERIFIED tenant + user + tool name, never a
 * spoofable header — mirrors the REST namespacing so the same key under a
 * different tenant can never replay another tenant's response.
 *
 * FAILS OPEN: any store error runs the operation without caching (a degraded
 * cache never blocks a write). "pending" (a concurrent in-flight call owning the
 * key) throws an HR-nnnn-shaped error the MCP error map surfaces as a JSON-RPC
 * error, matching the REST 409 semantics.
 *
 * @param {object}   args
 * @param {string}   args.toolName        the MCP tool name (namespaces the key).
 * @param {string}   args.idempotencyKey  the caller-supplied key.
 * @param {object}   args.ctx             MCP context ({ user: { tenantId, userId } }).
 * @param {() => Promise<any>} args.run   the side-effectful operation; its
 *                                        resolved value is cached and replayed.
 * @param {object}   [args.store]         inject a custom store (unit tests).
 * @param {number}   [args.ttlMs]         override the TTL for this call.
 * @returns {Promise<{ value:any, replayed:boolean }>}
 */
export async function runMcpIdempotent({ toolName, idempotencyKey, ctx, run, store, ttlMs } = {}) {
    if (!idempotencyKey) {
        // No key → no dedupe; run normally.
        return { value: await run(), replayed: false };
    }
    const effectiveTtl = ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    const activeStore = store || getStore(effectiveTtl);
    const tenantId = ctx?.user?.tenantId || 'unknown';
    const userId = ctx?.user?.userId || ctx?.user?.id || 'anon';
    const key = `hr:idempotency:mcp:${tenantId}:${userId}:${toolName}:${idempotencyKey}`;

    let reserved;
    try {
        reserved = await activeStore.reserve(key);
    } catch (err) {
        // Fail open — never block a write because the cache is degraded.
        logger.warn({ err, key }, 'mcp idempotency reserve failed — proceeding without cache');
        return { value: await run(), replayed: false };
    }

    if (reserved.state === 'completed') {
        return { value: reserved.value, replayed: true };
    }
    if (reserved.state === 'pending') {
        // Another call owns this key and is still running — mirror the REST 409.
        throw Object.assign(new Error('Idempotent request in flight'), {
            status: 409,
            code: 'HR-IDEMPOTENCY-IN-PROGRESS',
        });
    }

    // state === 'reserved' — we own the key.
    try {
        const value = await run();
        try {
            await activeStore.commit(key, value);
        } catch (err) {
            logger.warn({ err, key }, 'mcp idempotency commit failed');
        }
        return { value, replayed: false };
    } catch (err) {
        // The operation failed — release so a later retry can re-attempt.
        try {
            await activeStore.release(key);
        } catch (releaseErr) {
            logger.warn({ err: releaseErr, key }, 'mcp idempotency release failed');
        }
        throw err;
    }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.store]  inject a custom store (memory in unit tests).
 * @param {number} [opts.ttlMs]  override the TTL for this route only.
 */
export function idempotency({ store, ttlMs } = {}) {
    const effectiveTtl = ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    return (req, res, next) => {
        // Namespace by the VERIFIED tenant (never the spoofable x-tenant-id).
        const tenantId = req.user?.tenantId || 'unknown';
        const userId = req.user?.userId || req.headers['x-user-id'] || 'anon';
        const userKey = req.body?.idempotencyKey || req.headers['idempotency-key'];

        if (!userKey) return next();

        const key = `hr:idempotency:${tenantId}:${userId}:${req.method}:${req.path}:${userKey}`;
        const activeStore = store || getStore(effectiveTtl);

        function dispatch(outcome) {
            if (outcome.state === 'completed') {
                const { status, body } = outcome.value;
                return res.status(status).json(body);
            }
            if (outcome.state === 'pending') {
                // Another request owns this key and is still running. 409 is the
                // conventional "idempotent retry in flight" response.
                return res.status(409).json({
                    success: false,
                    error: 'Idempotent request in flight',
                    code: 'HR-IDEMPOTENCY-IN-PROGRESS',
                    idempotencyKey: userKey,
                });
            }
            // outcome.state === 'reserved' — we own the key. Wrap res.json so a
            // 2xx response commits the cache; anything else releases it.
            const json = res.json.bind(res);
            res.json = (payload) => {
                const result = json(payload);
                const status = res.statusCode;
                try {
                    if (status >= 200 && status < 300) {
                        Promise.resolve(activeStore.commit(key, { status, body: payload }))
                            .catch((err) => logger.warn({ err, key }, 'idempotency commit failed'));
                    } else {
                        Promise.resolve(activeStore.release(key))
                            .catch((err) => logger.warn({ err, key }, 'idempotency release failed'));
                    }
                } catch (err) {
                    logger.warn({ err, key }, 'idempotency post-response handling threw');
                }
                return result;
            };
            next();
        }

        let reserveResult;
        try {
            reserveResult = activeStore.reserve(key);
        } catch (err) {
            // Synchronous store error — fail open to keep the write path available.
            logger.warn({ err, key }, 'idempotency reserve threw — proceeding without cache');
            return next();
        }

        if (reserveResult && typeof reserveResult.then === 'function') {
            reserveResult.then(dispatch).catch((err) => {
                logger.warn({ err, key }, 'idempotency reserve rejected — proceeding without cache');
                next();
            });
        } else {
            dispatch(reserveResult);
        }
    };
}
