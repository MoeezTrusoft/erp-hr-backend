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
//   * RATE LIMITING — a fixed window per IP, shared by every pod through Redis
//     (lib/rate-limit.util.js; memory when Redis is down); a board crawls a
//     feed a few times an hour.
//   * CACHING — a 200 is public for 15 minutes, which is as fresh as any board
//     reads it and keeps a crawler from re-running the query on every hit.
import express from "express";

import logger from "../lib/logger.js";
import { rateLimit, resetRateLimitMemory } from "../lib/rate-limit.util.js";
import { getJobFeed } from "../services/job-feed.service.js";

const WINDOW_MS = 60_000;
const FEED_LIMIT = 30; // requests per IP per window

// The feed answers plain text and has never sent X-RateLimit-* headers (its
// 200s are publicly cached); only the 429 and its Retry-After are kept.
const feedRateLimit = rateLimit({
    routeClass: "feed",
    limit: FEED_LIMIT,
    windowMs: WINDOW_MS,
    headers: false,
    onLimited: (req, res) => res.status(429).type("text/plain").send("Too many requests"),
});

/** Test seam: forget every in-memory rate-limit window. */
export function resetJobFeedRateLimit() {
    resetRateLimitMemory();
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
