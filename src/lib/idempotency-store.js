// src/lib/idempotency-store.js — idempotency cache for erp-hr-backend.
//
// C.2 / T-P2.2 — HR mirrors the comms/pm idempotency contract so a retried
// mutating request replays its first response. The store is owned by THIS repo
// (the comms implementation lives in a foreign repo and is not importable); the
// contract is intentionally identical so behavior matches across services.
//
// Contract:
//   reserve(key)
//     → { state: 'reserved' }           — the caller now owns the key
//     → { state: 'pending' }            — another request is in-flight
//     → { state: 'completed', value }   — replay this cached response
//   commit(key, value)                  — record a successful response
//   release(key)                        — abandon the reservation
//
// The redis backend uses SET key value PX <ttl> NX for the reserve step so
// concurrent requests across replicas observe a single owner. The memory
// backend is single-process (dev / single-replica) and is the default when no
// HR_REDIS_URL is configured.

const STATE_PENDING = 'pending';
const STATE_COMPLETED = 'completed';

// Minimal TTL map (no external dep — the installed lru-cache is a legacy major
// without the named export, and bumping a transitive dep is out of charter). It
// expires entries lazily on read and caps size with FIFO eviction. Single-
// process only; the redis store is the cross-replica path.
export function createMemoryStore({ ttlMs, max = 5000 } = {}) {
    const cache = new Map(); // key -> { state, value?, expiresAt }

    const live = (key) => {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return undefined;
        }
        return entry;
    };
    const put = (key, entry) => {
        if (!cache.has(key) && cache.size >= max) {
            // FIFO: drop the oldest insertion.
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { ...entry, expiresAt: Date.now() + ttlMs });
    };

    return {
        name: 'memory',
        reserve(key) {
            const existing = live(key);
            if (existing) {
                return existing.state === STATE_COMPLETED
                    ? { state: STATE_COMPLETED, value: existing.value }
                    : { state: STATE_PENDING };
            }
            put(key, { state: STATE_PENDING });
            return { state: 'reserved' };
        },
        commit(key, value) {
            put(key, { state: STATE_COMPLETED, value });
        },
        release(key) {
            cache.delete(key);
        },
        // Test seam — not part of the public contract.
        _peek(key) { return live(key); },
    };
}

export function createRedisStore({ redis, ttlMs }) {
    if (!redis) throw new Error('createRedisStore: redis client required');
    if (!ttlMs || ttlMs <= 0) throw new Error('createRedisStore: ttlMs must be > 0');
    return {
        name: 'redis',
        async reserve(key) {
            // SET NX PX is the atomic primitive: returns 'OK' iff this caller
            // is the first to claim the key within the TTL window.
            const ok = await redis.set(
                key,
                JSON.stringify({ state: STATE_PENDING }),
                'PX', ttlMs, 'NX',
            );
            if (ok === 'OK') return { state: 'reserved' };
            const raw = await redis.get(key);
            if (raw == null) return { state: 'reserved' };
            let parsed;
            try { parsed = JSON.parse(raw); } catch { return { state: STATE_PENDING }; }
            return parsed.state === STATE_COMPLETED
                ? { state: STATE_COMPLETED, value: parsed.value }
                : { state: STATE_PENDING };
        },
        async commit(key, value) {
            await redis.set(
                key,
                JSON.stringify({ state: STATE_COMPLETED, value }),
                'PX', ttlMs,
            );
        },
        async release(key) {
            await redis.del(key);
        },
    };
}
