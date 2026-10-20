// src/routes/job-feed.routes.js
//
// Phase 2 — the PUBLIC per-tenant job feed for job boards.
//
//     GET /public/feeds/<feedToken>/indeed.xml
//     GET /public/feeds/<feedToken>/linkedin.xml
//
// Mounted by app.js under /public/feeds, OUTSIDE the /api internal-service
// guard: a job board crawler presents no service-JWT. The secret token in the
// path is the only credential and the only tenant resolution
// (services/job-feed.service.js).
//
// Guards, as for the careers portal:
//   * UNIFORM 404 — unknown token, disabled feed, flag off, unknown channel and
//     an upper-case channel segment all answer the same bodyless-detail 404,
//     so the endpoint is not an oracle for which tokens exist.
//   * RATE LIMITING — an in-memory fixed window per IP. The portal's limiter in
//     publicPortal.routes.js is not exported, so this router carries a copy of
//     the same idiom; a board crawls a feed a few times an hour.
//   * CACHING — a 200 is public for 15 minutes, which is as fresh as any board
//     reads it and keeps a crawler from re-running the query on every hit.
import express from "express";

import logger from "../lib/logger.js";
import { getJobFeed } from "../services/job-feed.service.js";

const WINDOW_MS = 60_000;
const FEED_LIMIT = 30; // requests per IP per window
const MAX_BUCKETS = 10_000;

const buckets = new Map(); // ip -> { count, resetAt }
let lastSweep = Date.now();

function feedRateLimit(req, res, next) {
    const now = Date.now();
    // Sweep expired windows so spoofed source addresses cannot grow the map
    // without bound; a full map under a distributed flood is cleared outright.
    if (now - lastSweep > WINDOW_MS || buckets.size > MAX_BUCKETS) {
        for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
        if (buckets.size > MAX_BUCKETS) buckets.clear();
        lastSweep = now;
    }
    const key = req.ip ?? "unknown";
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return next();
    }
    bucket.count += 1;
    if (bucket.count > FEED_LIMIT) {
        res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
        return res.status(429).type("text/plain").send("Too many requests");
    }
    return next();
}

/** Test seam: forget every rate-limit window. */
export function resetJobFeedRateLimit() {
    buckets.clear();
}

const notFound = (res) => res.status(404).type("text/plain").send("Not found");

export const jobFeedRouter = express.Router();

jobFeedRouter.get("/:token/:channel.xml", feedRateLimit, async (req, res) => {
    const { token, channel } = req.params;
    // The URL carries the channel in lower case; anything else is not a feed.
    if (!/^[a-z]+$/.test(String(channel ?? ""))) return notFound(res);
    try {
        const feed = await getJobFeed({ token, channel, now: new Date() });
        if (!feed) return notFound(res);
        res.setHeader("Cache-Control", "public, max-age=900");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).type("application/xml; charset=utf-8").send(feed.xml);
    } catch (err) {
        // The token never goes to the log: it is the feed's only credential.
        logger.error({ err: err?.message, channel }, "job feed route failed");
        return res.status(500).type("text/plain").send("Something went wrong");
    }
});

export default jobFeedRouter;
