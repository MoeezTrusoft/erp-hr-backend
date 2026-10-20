// src/lib/rate-limit.util.js
//
// Recruitment Phase 6 (plan 14) — one fixed-window rate limiter for every
// public surface (careers portal, privacy portal, job feed, kiosk), shared by
// all pods through Redis.
//
// Why: the earlier limiters each kept their windows in a per-process Map, so a
// deployment with N pods gave an attacker N budgets. With a Redis store every
// pod counts against the same window.
//
//   * STORE — Redis when REDIS_URL is set (the same variable the outbox loop
//     reads), else memory. Under NODE_ENV=test no client is ever opened.
//   * FAIL-OPEN TO MEMORY, NEVER TO UNLIMITED — a Redis error, a timeout or a
//     client that is not ready counts the hit in this process's memory window
//     instead. The degradation is logged once (and the recovery once), never
//     per request.
//   * NO PII IN KEYS OR LOGS — the caller's key (an IP, a workstation id, an
//     email) is HMAC-hashed before it reaches either store; the key is
//     `hr:rl:<routeClass>:<hash>`. Set HR_RATE_LIMIT_HASH_KEY (a secret shared
//     by every pod) in production so the hash cannot be reversed by
//     enumerating the IPv4 space.
//   * WINDOW — fixed, opened by the first hit of a key (memory and Redis
//     alike); the Redis window is one atomic INCR + PEXPIRE script.
//   * HEADERS — X-RateLimit-Limit and X-RateLimit-Remaining on every counted
//     request, Retry-After (seconds) on a 429, as the earlier limiters did.
import crypto from "node:crypto";
import Redis from "ioredis";

import logger from "./logger.js";

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_KEY_PREFIX = "hr:rl:";
const DEFAULT_REDIS_TIMEOUT_MS = 250;
const MEMORY_MAX_KEYS = 10_000;

// INCR the window's counter; the first hit (or a key that somehow lost its
// TTL) starts the window. Returns { count, ttlMs }.
export const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

// ── Stores ──────────────────────────────────────────────────────────────────

/**
 * In-process fixed windows. Expired windows are swept once a window, and a
 * map past MEMORY_MAX_KEYS (a flood of spoofed sources) is cleared outright.
 */
export function createMemoryRateLimitStore({ maxKeys = MEMORY_MAX_KEYS } = {}) {
    const buckets = new Map(); // key -> { count, resetAt }
    let lastSweep = 0;
    return {
        kind: "memory",
        hit(key, windowMs, now = Date.now()) {
            if (now - lastSweep > windowMs || buckets.size > maxKeys) {
                for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
                if (buckets.size > maxKeys) buckets.clear();
                lastSweep = now;
            }
            let bucket = buckets.get(key);
            if (!bucket || bucket.resetAt <= now) {
                bucket = { count: 0, resetAt: now + windowMs };
                buckets.set(key, bucket);
            }
            bucket.count += 1;
            return { count: bucket.count, resetAt: bucket.resetAt };
        },
        reset() {
            buckets.clear();
        },
        size: () => buckets.size,
    };
}

/** Redis fixed windows: one atomic script call per hit. */
export function createRedisRateLimitStore({ redis }) {
    return {
        kind: "redis",
        redis,
        async hit(key, windowMs, now = Date.now()) {
            // A client that is not connected would only reject; go to memory now.
            if (redis.status && redis.status !== "ready") throw new Error(`redis not ready (${redis.status})`);
            const reply = await redis.eval(FIXED_WINDOW_SCRIPT, 1, key, String(windowMs));
            const count = Number(Array.isArray(reply) ? reply[0] : NaN);
            const ttl = Number(Array.isArray(reply) ? reply[1] : NaN);
            if (!Number.isInteger(count) || count <= 0) throw new Error("unexpected rate limit reply");
            return { count, resetAt: now + (Number.isFinite(ttl) && ttl > 0 ? ttl : windowMs) };
        },
    };
}

// ── Store selection ─────────────────────────────────────────────────────────

const memory = createMemoryRateLimitStore();
let primary = null; // the Redis store (or an injected one)
let primaryResolved = false;
let degraded = false;

function defaultRedisStore(env = process.env) {
    if (String(env.NODE_ENV).toLowerCase() === "test") return null;
    const url = env.REDIS_URL;
    if (!url) {
        logger.warn({ component: "rate-limit" }, "rate limit store: memory (REDIS_URL not configured, per-process windows)");
        return null;
    }
    try {
        const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false });
        redis.on("error", () => {
            // The per-hit fallback logs the degradation once; connection noise stays out.
        });
        logger.info({ component: "rate-limit" }, "rate limit store: redis (shared windows)");
        return createRedisRateLimitStore({ redis });
    } catch (err) {
        logger.warn({ component: "rate-limit", errMessage: err?.message }, "rate limit store: memory (redis client could not be created)");
        return null;
    }
}

function primaryStore() {
    if (!primaryResolved) {
        primary = defaultRedisStore();
        primaryResolved = true;
    }
    return primary;
}

/**
 * Test and wiring seam: use `store` (or a store over `redis`) as the shared
 * store; null forces memory. Resets the degradation state.
 */
export function configureRateLimitStore({ store, redis } = {}) {
    primary = store ?? (redis ? createRedisRateLimitStore({ redis }) : null);
    primaryResolved = true;
    degraded = false;
}

/** Tests only: forget every in-memory window and the store choice. */
export function resetRateLimits() {
    memory.reset();
    primary = null;
    primaryResolved = false;
    degraded = false;
}

/** Forget the in-memory windows only (route test seams). */
export function resetRateLimitMemory() {
    memory.reset();
}

const redisTimeoutMs = () => Number(process.env.HR_RATE_LIMIT_REDIS_TIMEOUT_MS) || DEFAULT_REDIS_TIMEOUT_MS;

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`rate limit store timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Keys ────────────────────────────────────────────────────────────────────

const hashSecret = () => process.env.HR_RATE_LIMIT_HASH_KEY || "hr-rate-limit-v1";

/** `hr:rl:<routeClass>:<hmac>` — the raw key never leaves this function. */
export function rateLimitKey(routeClass, rawKey) {
    const digest = crypto
        .createHmac("sha256", hashSecret())
        .update(String(rawKey ?? "unknown"))
        .digest("hex")
        .slice(0, 32);
    return `${RATE_LIMIT_KEY_PREFIX}${String(routeClass)}:${digest}`;
}

// ── Counting ────────────────────────────────────────────────────────────────

/**
 * Count one hit of `key` in `routeClass`'s window. Never throws.
 * @returns {Promise<{ allowed: boolean, count: number, limit: number, remaining: number, resetAt: number, retryAfterSec: number, store: string }>}
 */
export async function consumeRateLimit({ routeClass, key, limit, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS, now = Date.now() } = {}) {
    const storeKey = rateLimitKey(routeClass, key);
    const store = primaryStore();
    let hit = null;
    let used = "memory";
    if (store) {
        try {
            hit = await withTimeout(Promise.resolve(store.hit(storeKey, windowMs, now)), redisTimeoutMs());
            used = store.kind ?? "redis";
            if (degraded) {
                degraded = false;
                logger.info({ component: "rate-limit" }, "rate limit store: redis recovered");
            }
        } catch (err) {
            if (!degraded) {
                degraded = true;
                logger.warn({ component: "rate-limit", errMessage: err?.message }, "rate limit store: redis failed, counting in memory");
            }
            hit = null;
        }
    }
    if (!hit) hit = memory.hit(storeKey, windowMs, now);
    const max = Number(limit);
    return {
        allowed: hit.count <= max,
        count: hit.count,
        limit: max,
        remaining: Math.max(0, max - hit.count),
        resetAt: hit.resetAt,
        retryAfterSec: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)),
        store: used,
    };
}

const tooManyJson = (req, res) => res.status(429).json({ success: false, message: "Too many requests" });

/**
 * Express middleware: a fixed window of `limit` requests per `windowMs` per
 * keyFn(req) (the client IP by default) in `routeClass`.
 *
 * @param {object} opts
 * @param {string} opts.routeClass  the window's namespace (a static name, never PII)
 * @param {number} opts.limit
 * @param {number} [opts.windowMs]
 * @param {(req) => string} [opts.keyFn]
 * @param {boolean} [opts.headers]  set X-RateLimit-* (default true)
 * @param {(req, res) => any} [opts.onLimited]  the 429 answer (default the JSON body)
 */
export function rateLimit({
    routeClass,
    limit,
    windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
    keyFn = (req) => req.ip ?? "unknown",
    headers = true,
    onLimited = tooManyJson,
} = {}) {
    if (!routeClass) throw new Error("rateLimit needs a routeClass");
    if (!Number.isInteger(Number(limit)) || Number(limit) <= 0) throw new Error("rateLimit needs a positive limit");
    return async (req, res, next) => {
        let key;
        try {
            key = keyFn(req);
        } catch {
            key = "unknown";
        }
        const result = await consumeRateLimit({ routeClass, key, limit, windowMs });
        if (headers) {
            res.setHeader("X-RateLimit-Limit", String(result.limit));
            res.setHeader("X-RateLimit-Remaining", String(result.remaining));
        }
        if (!result.allowed) {
            res.setHeader("Retry-After", String(result.retryAfterSec));
            return onLimited(req, res);
        }
        return next();
    };
}
