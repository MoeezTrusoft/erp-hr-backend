// Phase 2 job feed route: XML with caching on success, one identical 404 for
// every not-found reason, and a per-IP rate limit.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const getJobFeed = jest.fn();
jest.unstable_mockModule("../../../src/services/job-feed.service.js", () => ({ getJobFeed }));

const { jobFeedRouter, resetJobFeedRateLimit } = await import("../../../src/routes/job-feed.routes.js");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const XML = '<?xml version="1.0" encoding="utf-8"?>\n<source></source>\n';

const app = express();
app.use("/public/feeds", jobFeedRouter);

beforeEach(() => {
    jest.clearAllMocks();
    resetJobFeedRateLimit();
    getJobFeed.mockResolvedValue({ xml: XML, tenantId: "t", channel: "INDEED", jobCount: 0 });
});

describe("GET /public/feeds/:token/:channel.xml", () => {
    it("serves the feed as XML with a 15 minute public cache", async () => {
        const res = await request(app).get(`/public/feeds/${TOKEN}/indeed.xml`);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("application/xml; charset=utf-8");
        expect(res.headers["cache-control"]).toBe("public, max-age=900");
        expect(res.text).toBe(XML);
        expect(getJobFeed).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, channel: "indeed" }));
    });

    it("answers every not-found reason with the same plain 404", async () => {
        getJobFeed.mockResolvedValue(null);
        const responses = [
            await request(app).get(`/public/feeds/${TOKEN}/indeed.xml`),
            await request(app).get(`/public/feeds/unknown-token-unknown-token/linkedin.xml`),
            await request(app).get(`/public/feeds/${TOKEN}/INDEED.xml`),
            await request(app).get(`/public/feeds/${TOKEN}/career_site.xml`),
        ];
        for (const res of responses) {
            expect(res.status).toBe(404);
            expect(res.text).toBe("Not found");
            expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
            expect(res.headers["cache-control"]).toBeUndefined();
        }
    });

    it("returns 500 without detail when the service fails", async () => {
        getJobFeed.mockRejectedValueOnce(new Error("db down"));
        const res = await request(app).get(`/public/feeds/${TOKEN}/indeed.xml`);
        expect(res.status).toBe(500);
        expect(res.text).not.toContain("db down");
    });

    it("rate limits one address", async () => {
        let last;
        for (let i = 0; i < 31; i += 1) last = await request(app).get(`/public/feeds/${TOKEN}/indeed.xml`);
        expect(last.status).toBe(429);
        expect(last.headers["retry-after"]).toBeDefined();
    });
});
