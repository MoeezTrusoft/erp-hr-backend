// tests/unit/parseRetry.test.js
//
// Phase 6 / decision record §4.5/4.5a — the parse retry contract:
//
//   * the pure policy: content-hash keying, SKIP on a completed cache hit,
//     RETRY within the three-attempt ceiling, exponential backoff timing,
//     non-retryable failure classification, EXHAUSTED at the ceiling
//   * the service wrapper: a cache hit returns the stored payload without a
//     second vendor call; force re-parse resets ONE content's row; (Phase 2)
//     one attempt per call, the retry is scheduled, not slept
//   * the candidate projection: COMPLETED stamps the row; a parse failure
//     stamps FAILED without hiding the original error

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { createHash } from "node:crypto";

const hash = (s) => createHash("sha256").update(s).digest("hex");

// ── pure policy ──────────────────────────────────────────────────────────────
const { PARSE_MAX_ATTEMPTS, backoffDelayMs, hashResumeContent, isRetryableFailure, storedErrorIsRetryable, decideParse } = await import(
    "../../src/lib/parse-retry.util.js"
);

describe("parseRetry pure policy (§4.5a)", () => {
    it("keys the cache on the CONTENT hash — identical bytes hash identically", () => {
        expect(hashResumeContent(Buffer.from("resume v1"))).toBe(hash("resume v1"));
        expect(hashResumeContent(Buffer.from("resume v1"))).not.toBe(hashResumeContent(Buffer.from("resume v2")));
    });

    it("backs off exponentially (1s, 4s, 9s)", () => {
        expect(backoffDelayMs(1)).toBe(1000);
        expect(backoffDelayMs(2)).toBe(4000);
        expect(backoffDelayMs(3)).toBe(9000);
        expect(PARSE_MAX_ATTEMPTS).toBe(3);
    });

    it("treats a missing ledger row as a first parse", () => {
        const d = decideParse({ priorAttempt: null, contentHash: "abc" });
        expect(d).toMatchObject({ action: "PARSE", attempt: 1 });
    });

    it("hits the cache when the same content already COMPLETED", () => {
        const d = decideParse({
            priorAttempt: { contentHash: "abc", status: "COMPLETED", attemptCount: 1, updatedAt: new Date() },
            contentHash: "abc",
        });
        expect(d).toMatchObject({ action: "SKIP", reason: "CACHE_HIT" });
    });

    it("re-parses fresh when the content changed (the old cache is for another document)", () => {
        const d = decideParse({
            priorAttempt: { contentHash: "old", status: "COMPLETED", attemptCount: 1, updatedAt: new Date() },
            contentHash: "new",
        });
        expect(d).toMatchObject({ action: "PARSE", attempt: 1, reason: "CONTENT_CHANGED" });
    });

    it("retries a retryable failure after the backoff elapses", () => {
        const updated = new Date(Date.now() - 5000); // 5s ago; wait for attempt 1 is 1s
        const d = decideParse({
            priorAttempt: { contentHash: "abc", status: "FAILED", attemptCount: 1, lastError: "HR-RESUME-BAD-JSON 502", updatedAt: updated },
            contentHash: "abc",
        });
        expect(d).toMatchObject({ action: "RETRY", attempt: 2 });
    });

    it("throttles a retry that arrives before the backoff elapses", () => {
        const updated = new Date(); // just now
        const d = decideParse({
            priorAttempt: { contentHash: "abc", status: "FAILED", attemptCount: 1, lastError: "HR-RESUME-BAD-JSON 502", updatedAt: updated },
            contentHash: "abc",
        });
        expect(d).toMatchObject({ action: "RETRY_LATER", reason: "BACKOFF" });
        expect(d.waitMs).toBeGreaterThan(0);
    });

    it("exhausts at the three-attempt ceiling", () => {
        const updated = new Date(Date.now() - 60000);
        const d = decideParse({
            priorAttempt: { contentHash: "abc", status: "FAILED", attemptCount: 3, lastError: "502", updatedAt: updated },
            contentHash: "abc",
        });
        expect(d).toMatchObject({ action: "EXHAUSTED", reason: "MAX_ATTEMPTS" });
    });

    it("classifies failures: vendor 5xx/timeouts retry, our 4xx and missing deps do not", () => {
        expect(isRetryableFailure({ status: 502, message: "bad gateway" })).toBe(true);
        expect(isRetryableFailure({ status: 503, message: "provider down" })).toBe(true);
        expect(isRetryableFailure({ message: "socket hang up" })).toBe(true);
        expect(isRetryableFailure({ status: 429, message: "rate limited" })).toBe(true);
        expect(isRetryableFailure({ status: 408, message: "request timeout" })).toBe(true);

        expect(isRetryableFailure({ status: 400, message: "bad request" })).toBe(false);
        expect(isRetryableFailure({ status: 401, message: "unauthorized" })).toBe(false);
        expect(isRetryableFailure({ code: "HR-RESUME-DEP-MISSING", message: "no openai" })).toBe(false);
        expect(isRetryableFailure({ code: "HR-RESUME-NO-KEY", message: "no key" })).toBe(false);
        expect(isRetryableFailure(null)).toBe(false);
    });

    it("waits for a RUNNING row whose lease is live (an attempt in flight)", () => {
        const now = new Date("2026-10-20T10:00:00Z");
        const d = decideParse({
            priorAttempt: { contentHash: "abc", status: "RUNNING", attemptCount: 1, claimExpiresAt: new Date("2026-10-20T10:01:00Z"), updatedAt: now },
            contentHash: "abc",
            now,
        });
        expect(d).toMatchObject({ action: "RETRY_LATER", reason: "IN_PROGRESS", waitMs: 60000 });
    });

    it("uses a scheduled nextAttemptAt as the authority on when a retry is due", () => {
        const now = new Date("2026-10-20T10:00:00Z");
        const base = { contentHash: "abc", status: "FAILED", attemptCount: 1, lastError: "502", updatedAt: new Date("2026-10-20T09:00:00Z") };
        expect(decideParse({ priorAttempt: { ...base, nextAttemptAt: new Date("2026-10-20T10:00:05Z") }, contentHash: "abc", now }))
            .toMatchObject({ action: "RETRY_LATER", waitMs: 5000 });
        expect(decideParse({ priorAttempt: { ...base, nextAttemptAt: new Date("2026-10-20T09:59:59Z") }, contentHash: "abc", now }))
            .toMatchObject({ action: "RETRY", attempt: 2 });
    });

    it("schedules the next attempt with the backoff, and none at the ceiling or for a permanent failure", async () => {
        const { nextAttemptAfterFailure, lastErrorCode, parseTicketHash, isParseTicket } = await import("../../src/lib/parse-retry.util.js");
        const now = new Date("2026-10-20T10:00:00Z");
        expect(nextAttemptAfterFailure({ attempt: 1, retryable: true, now })).toEqual(new Date("2026-10-20T10:00:01Z"));
        expect(nextAttemptAfterFailure({ attempt: 2, retryable: true, now })).toEqual(new Date("2026-10-20T10:00:04Z"));
        expect(nextAttemptAfterFailure({ attempt: 3, retryable: true, now })).toBeNull();
        expect(nextAttemptAfterFailure({ attempt: 1, retryable: false, now })).toBeNull();
        expect(lastErrorCode("HR-RESUME-PLANE-FAILED AI plane parse failed: x")).toBe("HR-RESUME-PLANE-FAILED");
        expect(lastErrorCode("502 bad gateway")).toBeNull();
        expect(parseTicketHash(7, 9)).toBe("pending:c7:m9");
        expect(isParseTicket({ contentHash: "pending:c7:m9" })).toBe(true);
        expect(isParseTicket({ contentHash: hash("x") })).toBe(false);
    });

    it("treats a stuck RUNNING row as retryable only if its last error was", () => {
        expect(storedErrorIsRetryable("HR-RESUME-NO-KEY not configured")).toBe(false);
        expect(storedErrorIsRetryable("502 bad gateway")).toBe(true);
        expect(storedErrorIsRetryable("")).toBe(true);

        const stale = { contentHash: "abc", status: "RUNNING", attemptCount: 1, lastError: "HR-RESUME-NO-KEY x", updatedAt: new Date(Date.now() - 60000) };
        expect(decideParse({ priorAttempt: stale, contentHash: "abc" }).action).toBe("EXHAUSTED");

        const staleRetryable = { ...stale, lastError: "502 bad gateway" };
        expect(decideParse({ priorAttempt: staleRetryable, contentHash: "abc" })).toMatchObject({
            action: "RETRY",
            reason: "STALE_LEASE",
        });
    });
});

// ── the service wrapper ──────────────────────────────────────────────────────
const prisma = {
    resumeParseAttempt: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        delete: jest.fn(),
    },
    candidate: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    candidateSkill: { upsert: jest.fn(async () => ({})) },
    outboxEvent: { create: jest.fn(async () => ({})) },
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const downloadDamAssetBuffer = jest.fn();

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({ tenantTransaction: async (client, fn) => await fn(client) }));
const enqueueHrDomainEvent = jest.fn(async () => ({}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));

const resumeService = await import("../../src/services/resume-parsing.service.js");

const damPayload = (content) => ({
    // text/plain: extractResumeText takes the utf8 fast path — no pdf-parse
    // dynamic import, which Jest cannot satisfy after teardown in this suite.
    buffer: Buffer.from(content),
    mimeType: "text/plain",
    fileName: "resume.txt",
});

const completedRow = (content, extra = {}) => ({
    id: 1,
    kind: "CANDIDATE",
    contentHash: hash(content),
    status: "COMPLETED",
    attemptCount: 1,
    parsedJson: { skills: [{ name: "TypeScript", category: "skill", score: 90, level: "Expert" }], competencies: [], certifications: [], model: "gpt-x" },
    updatedAt: new Date(),
    ...extra,
});

describe("parseResumeWithRetry (§4.5a wrapper)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Real timers by default; the cache-hit tests never sleep.
    });

    it("returns the cached parse on a content-hash hit WITHOUT a vendor call", async () => {
        const content = "identical resume bytes";
        downloadDamAssetBuffer.mockResolvedValue(damPayload(content));
        prisma.resumeParseAttempt.findUnique.mockResolvedValue(completedRow(content));

        const result = await resumeService.parseResumeWithRetry(88, { kind: "CANDIDATE", tenantId: "t-1" });

        expect(result.fromCache).toBe(true);
        expect(result.skills[0].name).toBe("TypeScript");
        expect(prisma.resumeParseAttempt.upsert).not.toHaveBeenCalled();
        expect(prisma.resumeParseAttempt.update).not.toHaveBeenCalled();
    });

    it("does not confuse two different files with the same media id", async () => {
        const contentA = "resume A";
        const contentB = "resume B (edited)";
        downloadDamAssetBuffer.mockResolvedValue(damPayload(contentB));
        // The ledger holds a row for content A; content B must PARSE fresh.
        prisma.resumeParseAttempt.findUnique.mockImplementation(({ where }) => {
            const requested = where.tenantId_kind_contentHash.contentHash;
            return Promise.resolve(requested === hash(contentA) ? completedRow(contentA) : null);
        });
        prisma.resumeParseAttempt.upsert.mockResolvedValue({ id: 2, attemptCount: 1 });
        prisma.resumeParseAttempt.update.mockResolvedValue({});
        // The vendor path would be called; make it fail fast and permanently.
        jest.unstable_mockModule("../../src/services/resume-parsing.service.js", () => ({}));

        // Use a fresh import with an extracted-text stub: simplest is to verify
        // the DECISION only — the row lookup used content B's hash.
        const { decideParse: decide } = await import("../../src/lib/parse-retry.util.js");
        const d = decide({
            priorAttempt: { contentHash: hash(contentA), status: "COMPLETED", attemptCount: 1, updatedAt: new Date() },
            contentHash: hash(contentB),
        });
        expect(d.action).toBe("PARSE");
        expect(prisma.resumeParseAttempt.upsert).not.toHaveBeenCalled(); // we only proved the decision here
    });

    it("force re-parse resets a COMPLETED row for that content only", async () => {
        const content = "forced content";
        downloadDamAssetBuffer.mockResolvedValue(damPayload(content));
        prisma.resumeParseAttempt.findUnique
            .mockResolvedValueOnce(completedRow(content)) // the force probe
            .mockResolvedValue(null); // after reset: no prior row
        prisma.resumeParseAttempt.delete.mockResolvedValue({});
        prisma.resumeParseAttempt.upsert.mockResolvedValue({ id: 3, attemptCount: 0, status: "RUNNING" });

        // Extract + vendor parse are the slow parts; stub the whole parse by
        // giving text that is too short → parseResumeText returns an empty-but-
        // successful result without ever touching a vendor client.
        const result = await resumeService.parseResumeWithRetry(88, { kind: "CANDIDATE", tenantId: "t-1", force: true });

        expect(prisma.resumeParseAttempt.delete).toHaveBeenCalledWith({ where: { id: 1 } });
        expect(result.fromCache).toBe(false);
        expect(result.warning).toMatch(/empty or too short/);
        // RUNNING (attempt 1) then COMPLETED, both guarded by this request's claim.
        const writes = prisma.resumeParseAttempt.updateMany.mock.calls.map(([args]) => args);
        expect(writes.map((w) => w.data.status)).toEqual(["RUNNING", "COMPLETED"]);
        expect(writes[0].data.attemptCount).toBe(1);
        expect(writes[0].where.claimedBy).toMatch(/^request:/);
    });

    it("throws EXHAUSTED (429) when the ceiling is already spent", async () => {
        const content = "doomed content";
        downloadDamAssetBuffer.mockResolvedValue(damPayload(content));
        prisma.resumeParseAttempt.findUnique.mockResolvedValue(
            completedRow(content, { status: "FAILED", attemptCount: 3, lastError: "502" }),
        );

        await expect(resumeService.parseResumeWithRetry(88, { kind: "CANDIDATE", tenantId: "t-1" })).rejects.toMatchObject({
            status: 429,
            code: "HR-RESUME-ATTEMPTS-EXHAUSTED",
        });
    });
});

// ── the candidate projection ─────────────────────────────────────────────────
describe("ingestCandidateResume parse-state projection (§4.5a)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("stamps COMPLETED + parsedAt on a successful parse", async () => {
        const content = "enough resume text to matter for the projection test";
        prisma.candidate.findFirst.mockResolvedValue({ id: 5, tenantId: "t-1", resumeMediaId: 88 });
        downloadDamAssetBuffer.mockResolvedValue(damPayload(content));
        prisma.resumeParseAttempt.findUnique.mockResolvedValue(completedRow(content));

        await resumeService.ingestCandidateResume({ candidateId: 5, tenantId: "t-1" });

        expect(prisma.candidate.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 5, tenantId: "t-1" } }));
        expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 5, tenantId: "t-1" },
                data: expect.objectContaining({ parseStatus: "COMPLETED", parseError: null }),
            }),
        );
    });

    it("stamps FAILED without swallowing the error when attempts exhaust", async () => {
        const content = "exhausted content";
        prisma.candidate.findFirst.mockResolvedValue({ id: 5, tenantId: "t-1", resumeMediaId: 88 });
        downloadDamAssetBuffer.mockResolvedValue(damPayload(content));
        prisma.resumeParseAttempt.findUnique.mockResolvedValue(
            completedRow(content, { status: "FAILED", attemptCount: 3, lastError: "502" }),
        );

        await expect(
            resumeService.ingestCandidateResume({ candidateId: 5, tenantId: "t-1" }),
        ).rejects.toMatchObject({ code: "HR-RESUME-ATTEMPTS-EXHAUSTED" });

        // Phase 2 — the ceiling is its own candidate-facing state.
        expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 5, tenantId: "t-1" },
                data: expect.objectContaining({ parseStatus: "EXHAUSTED", parseError: expect.stringContaining("attempts") }),
            }),
        );
    });
});

describe("D-13 — the parse cache is per tenant", () => {
    it("refuses a parse without a tenant before any download", async () => {
        downloadDamAssetBuffer.mockClear();
        await expect(resumeService.parseResumeWithRetry(88, { kind: "CANDIDATE" }))
            .rejects.toMatchObject({ status: 400, code: "HR-TENANT-REQUIRED" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });
});
