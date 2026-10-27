// tests/unit/parseRetry.test.js
//
// Phase 6 / decision record §4.5/4.5a — the parse retry contract:
//
//   * the pure policy: content-hash keying, SKIP on a completed cache hit,
//     RETRY within the three-attempt ceiling, exponential backoff timing,
//     non-retryable failure classification, EXHAUSTED at the ceiling
//   * the service wrapper: a cache hit returns the stored payload without a
//     second vendor call; force re-parse resets ONE content's row; the loop
//     retries transient failures and stops on permanent ones
//   * the candidate projection: COMPLETED stamps the row; a parse failure
//     stamps FAILED without hiding the original error

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { createHash } from "node:crypto";

const hash = (s) => createHash("sha256").update(s).digest("hex");

// ── pure policy ──────────────────────────────────────────────────────────────
const { PARSE_MAX_ATTEMPTS, backoffDelayMs, hashResumeContent, isRetryableFailure, storedErrorIsRetryable, decideParse } = await import(
    "../../src/lib/parseRetry.js"
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

// The cache wrapper performs one attempt. Durable worker/concurrency coverage
// lives in tests/recruitment/resume-worker.postgres.test.mjs.
const prisma={resumeParseAttempt:{findUnique:jest.fn(),upsert:jest.fn(),updateMany:jest.fn()},$executeRawUnsafe:jest.fn(async()=>[])};
const download=jest.fn(),parseText=jest.fn();
jest.unstable_mockModule('../../src/lib/prisma.js',()=>({default:prisma}));
jest.unstable_mockModule('../../src/lib/logger.js',()=>({default:{info:jest.fn(),warn:jest.fn(),error:jest.fn()}}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js',()=>({tenantTransaction:(_client,fn)=>fn(prisma)}));
jest.unstable_mockModule('../../src/services/candidatePrivacy.service.js',()=>({assertCommunicationsAllowed:jest.fn(async()=>({allowed:true}))}));
const {parseResumeWithRetry}=await import('../../src/services/resumeParsing.service.js');
const content='Fictional resume with editorial skills and experience';
const result={skills:[{name:'Editing',score:90}],competencies:[],certifications:[],model:'fictional-test'};
const deps={download,extract:async()=>content,parseText};
const options={tenantId:'tenant-a',kind:'CANDIDATE'};
beforeEach(()=>{jest.clearAllMocks();download.mockResolvedValue({buffer:Buffer.from(content),mimeType:'text/plain'});parseText.mockResolvedValue(result);prisma.resumeParseAttempt.findUnique.mockResolvedValue(null);prisma.resumeParseAttempt.upsert.mockResolvedValue({id:1});prisma.resumeParseAttempt.updateMany.mockResolvedValue({count:1});});
describe('single-attempt leased resume cache',()=>{
 it('checks tenant before accessing any DAM bytes',async()=>{await expect(parseResumeWithRetry(88,{},deps)).rejects.toMatchObject({status:403});expect(download).not.toHaveBeenCalled();});
 it('returns a tenant-qualified completed cache without a provider call',async()=>{prisma.resumeParseAttempt.findUnique.mockResolvedValue({id:1,status:'COMPLETED',contentHash:hash(content),parsedJson:result});const response=await parseResumeWithRetry(88,options,deps);expect(response.fromCache).toBe(true);expect(response.skills).toEqual(result.skills);expect(parseText).not.toHaveBeenCalled();expect(prisma.resumeParseAttempt.findUnique).toHaveBeenCalledWith({where:{tenantId_kind_contentHash:{tenantId:'tenant-a',kind:'CANDIDATE',contentHash:hash(content)}}});});
 it('changed bytes get a different cache key even when the media id is reused',async()=>{download.mockResolvedValue({buffer:Buffer.from(content+' changed')});await parseResumeWithRetry(88,options,deps);expect(prisma.resumeParseAttempt.upsert.mock.calls[0][0].where.tenantId_kind_contentHash.contentHash).toBe(hash(content+' changed'));expect(parseText).toHaveBeenCalledTimes(1);});
 it('an explicit force replaces completed evidence but does not delete another content row',async()=>{prisma.resumeParseAttempt.findUnique.mockResolvedValue({id:1,status:'COMPLETED',contentHash:hash(content),parsedJson:result});expect((await parseResumeWithRetry(88,{...options,force:true},deps)).fromCache).toBe(false);expect(prisma.resumeParseAttempt.upsert.mock.calls[0][0].update).toMatchObject({status:'RUNNING',attemptCount:1,parsedJson:null});});
 it('a live content lease cannot be taken over, even by force',async()=>{prisma.resumeParseAttempt.findUnique.mockResolvedValue({id:1,status:'RUNNING',contentHash:hash(content),attemptCount:1,leaseUntil:new Date(Date.now()+60000)});await expect(parseResumeWithRetry(88,{...options,force:true},deps)).rejects.toMatchObject({code:'HR-RESUME-BACKOFF'});expect(parseText).not.toHaveBeenCalled();});
 it('exhausted content does not call a provider',async()=>{prisma.resumeParseAttempt.findUnique.mockResolvedValue({id:1,status:'FAILED',contentHash:hash(content),attemptCount:3});await expect(parseResumeWithRetry(88,options,deps)).rejects.toMatchObject({code:'HR-RESUME-ATTEMPTS-EXHAUSTED'});expect(parseText).not.toHaveBeenCalled();});
 it('a transient failure records one failed attempt and returns without a retry loop',async()=>{parseText.mockRejectedValue(Object.assign(new Error('fictional provider failure'),{status:503}));await expect(parseResumeWithRetry(88,options,deps)).rejects.toMatchObject({status:503});expect(parseText).toHaveBeenCalledTimes(1);expect(prisma.resumeParseAttempt.updateMany.mock.calls[0][0].data).toMatchObject({status:'FAILED',leaseToken:null});});
 it('a permanent failure is stored without provider error details and never retried',async()=>{parseText.mockRejectedValue(Object.assign(new Error('private error detail'),{status:400}));await expect(parseResumeWithRetry(88,options,deps)).rejects.toMatchObject({status:400});expect(prisma.resumeParseAttempt.updateMany.mock.calls[0][0].data.lastError).toBe('HR-RESUME-PERMANENT');expect(decideParse({priorAttempt:{status:'FAILED',contentHash:'abc',attemptCount:1,lastError:'HR-RESUME-PERMANENT',updatedAt:new Date(0)},contentHash:'abc'}).action).toBe('EXHAUSTED');});
});
