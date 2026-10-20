// Recruitment Phase 6 — the shared fixed-window rate limiter: one budget
// across pods through Redis (a fake here), memory when Redis is not
// configured, fails or hangs (never unlimited), one log line per degradation,
// and no raw IP or email in a store key or a log.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const logged = { info: [], warn: [], error: [] };
const logger = {
    info: (fields, msg) => logged.info.push({ fields, msg }),
    warn: (fields, msg) => logged.warn.push({ fields, msg }),
    error: (fields, msg) => logged.error.push({ fields, msg }),
    debug: () => {},
};
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));

const rl = await import("../../../src/lib/rate-limit.util.js");

/** An ioredis double that runs the fixed-window script's semantics. */
function makeFakeRedis({ clock = () => Date.now() } = {}) {
    const keys = new Map(); // key -> { count, expiresAt }
    const calls = [];
    return {
        status: "ready",
        keys,
        calls,
        failNext: 0,
        hang: false,
        async eval(script, numKeys, key, windowMs) {
            calls.push({ script, numKeys, key, windowMs });
            if (this.hang) return new Promise(() => {});
            if (this.failNext > 0) {
                this.failNext -= 1;
                throw new Error("ECONNRESET");
            }
            const now = clock();
            let entry = keys.get(key);
            if (!entry || entry.expiresAt <= now) {
                entry = { count: 0, expiresAt: now + Number(windowMs) };
                keys.set(key, entry);
            }
            entry.count += 1;
            return [entry.count, entry.expiresAt - now];
        },
    };
}

const appWith = (middleware) => {
    const app = express();
    app.set("trust proxy", true);
    app.get("/x", middleware, (req, res) => res.json({ ok: true }));
    return app;
};

const hits = async (app, n, ip = "203.0.113.9") => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(await request(app).get("/x").set("X-Forwarded-For", ip));
    return out;
};

const allLogs = () => JSON.stringify([...logged.info, ...logged.warn, ...logged.error]);

beforeEach(() => {
    rl.resetRateLimits();
    for (const k of Object.keys(logged)) logged[k].length = 0;
    delete process.env.HR_RATE_LIMIT_REDIS_TIMEOUT_MS;
});

describe("memory store (no Redis configured)", () => {
    it("counts a fixed window per key with the limiter headers", async () => {
        const app = appWith(rl.rateLimit({ routeClass: "t:mem", limit: 3 }));
        const res = await hits(app, 4);
        expect(res.map((r) => r.status)).toEqual([200, 200, 200, 429]);
        expect(res[0].headers["x-ratelimit-limit"]).toBe("3");
        expect(res.map((r) => r.headers["x-ratelimit-remaining"])).toEqual(["2", "1", "0", "0"]);
        expect(Number(res[3].headers["retry-after"])).toBeGreaterThan(0);
        expect(res[3].body).toEqual({ success: false, message: "Too many requests" });
        // Another address has its own window.
        expect((await hits(app, 1, "198.51.100.1"))[0].status).toBe(200);
    });

    it("opens a new window once the old one has passed", async () => {
        const t0 = 1_000_000;
        for (let i = 0; i < 2; i += 1) await rl.consumeRateLimit({ routeClass: "t:win", key: "k", limit: 2, windowMs: 1000, now: t0 });
        expect((await rl.consumeRateLimit({ routeClass: "t:win", key: "k", limit: 2, windowMs: 1000, now: t0 + 10 })).allowed).toBe(false);
        const later = await rl.consumeRateLimit({ routeClass: "t:win", key: "k", limit: 2, windowMs: 1000, now: t0 + 1001 });
        expect(later).toMatchObject({ allowed: true, count: 1, remaining: 1, store: "memory" });
    });

    it("can answer its own 429 and leave the headers off", async () => {
        const app = appWith(rl.rateLimit({
            routeClass: "t:plain",
            limit: 1,
            headers: false,
            onLimited: (req, res) => res.status(429).type("text/plain").send("Too many requests"),
        }));
        const res = await hits(app, 2);
        expect(res[0].headers["x-ratelimit-limit"]).toBeUndefined();
        expect(res[1].status).toBe(429);
        expect(res[1].text).toBe("Too many requests");
        expect(res[1].headers["retry-after"]).toBeDefined();
    });

    it("refuses a limiter without a class or a limit", () => {
        expect(() => rl.rateLimit({ limit: 1 })).toThrow();
        expect(() => rl.rateLimit({ routeClass: "x", limit: 0 })).toThrow();
    });
});

describe("Redis store", () => {
    it("shares one budget across pods (the count lives in Redis, not in the process)", async () => {
        const redis = makeFakeRedis();
        rl.configureRateLimitStore({ redis });
        const podA = appWith(rl.rateLimit({ routeClass: "t:shared", limit: 3 }));
        const podB = appWith(rl.rateLimit({ routeClass: "t:shared", limit: 3 }));
        expect((await hits(podA, 2)).map((r) => r.status)).toEqual([200, 200]);
        // A pod's memory is empty: forgetting it changes nothing.
        rl.resetRateLimitMemory();
        const b = await hits(podB, 2);
        expect(b.map((r) => r.status)).toEqual([200, 429]);
        expect(b[0].headers["x-ratelimit-remaining"]).toBe("0");
        expect(redis.calls).toHaveLength(4);
        expect(redis.calls[0]).toMatchObject({ script: rl.FIXED_WINDOW_SCRIPT, numKeys: 1, windowMs: "60000" });
    });

    it("never puts the raw IP or email in a key or a log", async () => {
        const redis = makeFakeRedis();
        rl.configureRateLimitStore({ redis });
        const app = appWith(rl.rateLimit({ routeClass: "t:pii", limit: 5, keyFn: (req) => `${req.ip}|ann@example.com` }));
        await hits(app, 1, "203.0.113.77");
        const [key] = [...redis.keys.keys()];
        expect(key).toMatch(/^hr:rl:t:pii:[0-9a-f]{32}$/);
        expect(key).not.toContain("203.0.113.77");
        expect(key).not.toContain("example.com");
        expect(rl.rateLimitKey("t:pii", "203.0.113.77")).toBe(rl.rateLimitKey("t:pii", "203.0.113.77"));
        expect(rl.rateLimitKey("t:pii", "203.0.113.77")).not.toBe(rl.rateLimitKey("t:other", "203.0.113.77"));
        redis.failNext = 1;
        await hits(app, 1, "203.0.113.77");
        expect(allLogs()).not.toMatch(/203\.0\.113\.77|example\.com/);
    });

    it("falls back to memory on a Redis error, still limits, and logs once", async () => {
        const redis = makeFakeRedis();
        redis.failNext = 100;
        rl.configureRateLimitStore({ redis });
        const app = appWith(rl.rateLimit({ routeClass: "t:down", limit: 2 }));
        const res = await hits(app, 4);
        expect(res.map((r) => r.status)).toEqual([200, 200, 429, 429]);
        expect(logged.warn.filter((l) => /counting in memory/.test(l.msg))).toHaveLength(1);
    });

    it("falls back to memory when Redis hangs past the timeout", async () => {
        process.env.HR_RATE_LIMIT_REDIS_TIMEOUT_MS = "20";
        const redis = makeFakeRedis();
        redis.hang = true;
        rl.configureRateLimitStore({ redis });
        const first = await rl.consumeRateLimit({ routeClass: "t:hang", key: "k", limit: 1 });
        const second = await rl.consumeRateLimit({ routeClass: "t:hang", key: "k", limit: 1 });
        expect(first).toMatchObject({ allowed: true, store: "memory" });
        expect(second).toMatchObject({ allowed: false, store: "memory" });
        expect(logged.warn).toHaveLength(1);
    });

    it("goes straight to memory while the client is not ready", async () => {
        const redis = makeFakeRedis();
        redis.status = "connecting";
        rl.configureRateLimitStore({ redis });
        const out = await rl.consumeRateLimit({ routeClass: "t:conn", key: "k", limit: 5 });
        expect(out).toMatchObject({ allowed: true, store: "memory" });
        expect(redis.calls).toHaveLength(0);
    });

    it("logs the recovery once and counts in Redis again", async () => {
        const redis = makeFakeRedis();
        redis.failNext = 2;
        rl.configureRateLimitStore({ redis });
        for (let i = 0; i < 4; i += 1) await rl.consumeRateLimit({ routeClass: "t:flap", key: "k", limit: 10 });
        expect(logged.warn).toHaveLength(1);
        expect(logged.info.filter((l) => /recovered/.test(l.msg))).toHaveLength(1);
        const out = await rl.consumeRateLimit({ routeClass: "t:flap", key: "k", limit: 10 });
        expect(out).toMatchObject({ store: "redis", count: 3 });
    });

    it("treats an unreadable reply as a failure, not as unlimited", async () => {
        const redis = makeFakeRedis();
        redis.eval = async () => "OK";
        rl.configureRateLimitStore({ redis });
        await rl.consumeRateLimit({ routeClass: "t:odd", key: "k", limit: 1 });
        const second = await rl.consumeRateLimit({ routeClass: "t:odd", key: "k", limit: 1 });
        expect(second).toMatchObject({ allowed: false, store: "memory" });
    });
});

describe("memory store bounds", () => {
    it("clears a map flooded past its cap", () => {
        const store = rl.createMemoryRateLimitStore({ maxKeys: 3 });
        for (let i = 0; i < 5; i += 1) store.hit(`k${i}`, 60_000, 1000);
        expect(store.size()).toBeLessThanOrEqual(4);
    });
});
