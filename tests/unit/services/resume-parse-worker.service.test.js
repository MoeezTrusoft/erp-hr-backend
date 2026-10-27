// Phase 2 — the asynchronous resume parse worker, run against an in-memory
// parse ledger (tests/unit/services/helpers/resume-ledger.fake.js) whose
// queries are lazy and tenant-scoped like the real client's.
//
// Pinned here: flag gating, atomic claims (two ticks never work one row twice),
// the per-tenant cache (a hit across two candidates of one tenant, never
// across tenants), retry scheduling through nextAttemptAt and the three-attempt
// ceiling, expired leases reclaimed, late plane answers collected without a
// second task, the projection identical to the request path's, and the
// hr.recruitment.candidate_resume_parsed.v1 event carrying ids only.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { makeFakeDb, seedCandidate, candidateOf } from "./helpers/resume-ledger.fake.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-10-20T10:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);

let clock = T0;
let db = makeFakeDb({ now: () => clock });
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const downloadDamAssetBuffer = jest.fn();
const runAiTask = jest.fn();
const collectAiResult = jest.fn();
const enqueueHrDomainEvent = jest.fn(async () => ({}));
const txContexts = [];

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask, collectAiResult }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: async (client, fn, opts) => {
        txContexts.push(opts?.tenantId ?? null);
        return await fn(client);
    },
}));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const worker = await import("../../../src/services/resume-parse-worker.service.js");
const { enqueueCandidateResumeParse } = await import("../../../src/services/resume-parse-queue.service.js");
const resume = await import("../../../src/services/resume-parsing.service.js");
const { hashResumeContent } = await import("../../../src/lib/parse-retry.util.js");

const CV = "Senior Go engineer, Kubernetes, leadership of a platform team, CKA certified.";
const OTHER_CV = "Accountant with ten years of IFRS reporting and audit experience.";
const contents = new Map();

const planeOk = (taskId = "task-1") => ({
    taskId,
    status: "ok",
    tokensUsed: 500,
    output: {
        provider: "openai",
        model: "gpt-x",
        result: {
            skills: [{ name: "Go", score: 82, level: "Advanced" }, { name: "Kubernetes", score: 70 }],
            competencies: [{ name: "Leadership", score: 60 }],
            certifications: [{ name: "CKA", issuer: "CNCF", issuedDate: "2024" }],
        },
    },
});

const tick = (ms = 0, extra = {}) => {
    clock = at(ms);
    return worker.runResumeParseWorkerTick({ now: clock, workerId: "w-test", ...extra });
};

const enqueue = (tenantId, candidateId, mediaId) =>
    enqueueCandidateResumeParse({ tenantId, candidateId, mediaId, now: clock });

const ledgerRows = () => db.state.attempts;
const contentRow = (tenantId, text) => ledgerRows().find((r) => r.tenantId === tenantId && r.contentHash === hashResumeContent(Buffer.from(text)));
const events = () => enqueueHrDomainEvent.mock.calls.map(([, args]) => args);

beforeEach(() => {
    clock = T0;
    db = makeFakeDb({ now: () => clock });
    jest.clearAllMocks();
    txContexts.length = 0;
    contents.clear();
    process.env.HR_RESUME_PARSE_WORKER_ENABLED = "true";
    process.env.HR_RECRUITMENT_AI = "true";
    downloadDamAssetBuffer.mockImplementation(async (mediaId) =>
        contents.has(Number(mediaId)) ? { buffer: Buffer.from(contents.get(Number(mediaId))), mimeType: "text/plain", fileName: "cv.txt" } : null);
    runAiTask.mockImplementation(async () => planeOk());
    collectAiResult.mockResolvedValue({ status: "pending", pending: true });
});

afterEach(() => {
    delete process.env.HR_RESUME_PARSE_WORKER_ENABLED;
    delete process.env.HR_RECRUITMENT_AI;
});

describe("flag gating", () => {
    it("does nothing unless BOTH parseWorker and ai are on", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        await enqueue(TENANT_A, 1, 10);
        const opsBefore = db.state.ops.length;

        process.env.HR_RESUME_PARSE_WORKER_ENABLED = "false";
        await expect(tick()).resolves.toEqual({ skipped: "FLAG_OFF" });
        process.env.HR_RESUME_PARSE_WORKER_ENABLED = "true";
        process.env.HR_RECRUITMENT_AI = "false";
        await expect(tick()).resolves.toEqual({ skipped: "FLAG_OFF" });

        expect(db.state.ops.length).toBe(opsBefore);
        expect(runAiTask).not.toHaveBeenCalled();
    });
});

describe("ticket to completed parse", () => {
    it("downloads, hashes, parses once, projects and emits the event in the projection transaction", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        await expect(enqueue(TENANT_A, 1, 10)).resolves.toEqual({ queued: true });
        expect(candidateOf(db, 1).parseStatus).toBe("PENDING");

        const summary = await tick();
        expect(summary).toMatchObject({ scanned: 1, claimed: 1, errors: 0, outcomes: { COMPLETED: 1 } });

        // The ticket became the content row: one row, real hash, COMPLETED, claim released.
        expect(ledgerRows()).toHaveLength(1);
        expect(ledgerRows()[0]).toMatchObject({
            contentHash: hashResumeContent(Buffer.from(CV)),
            status: "COMPLETED",
            attemptCount: 1,
            candidateId: 1,
            claimedBy: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
        });
        expect(runAiTask).toHaveBeenCalledTimes(1);
        expect(runAiTask.mock.calls[0][0]).toMatchObject({ tenantId: TENANT_A, promptKey: "hr.resume.parse.v1" });

        const cand = candidateOf(db, 1);
        expect(cand.parseStatus).toBe("COMPLETED");
        expect(cand.parsedResume.skills.map((s) => s.name)).toEqual(["Go", "Kubernetes"]);
        expect(db.state.skills.map((s) => s.name).sort()).toEqual(["Go", "Kubernetes", "Leadership"]);

        const [event] = events();
        expect(event).toMatchObject({
            eventName: "hr.recruitment.candidate_resume_parsed.v1",
            tenantId: TENANT_A,
            aggregateType: "Candidate",
            aggregateId: 1,
            actorType: "automation",
            payload: {
                candidateId: "1",
                mediaId: "10",
                status: "COMPLETED",
                skillCount: 2,
                competencyCount: 1,
                certificationCount: 1,
                fromCache: false,
                attempts: 1,
            },
        });
        // Ids and counts only: no skill names, no resume text.
        expect(JSON.stringify(event.payload)).not.toMatch(/Go|Kubernetes|CKA|engineer/);
        expect(txContexts).toContain(TENANT_A);

        // Every DB op ran inside a context: the due scan as SYSTEM, the rest as the tenant.
        expect(db.state.ops.find((o) => o.op === "findMany" && o.model === "resumeParseAttempt").tenant).toBe("SYSTEM");
        expect(db.state.ops.filter((o) => o.model === "candidate").every((o) => o.tenant === TENANT_A)).toBe(true);
    });

    it("re-enqueueing a parsed media is a no-op", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        await enqueue(TENANT_A, 1, 10);
        await tick();
        await expect(enqueue(TENANT_A, 1, 10)).resolves.toEqual({ queued: false, reason: "ALREADY_PARSED" });
    });
});

describe("the per-tenant cache (D-13)", () => {
    it("serves a second candidate of the SAME tenant from the cache without a plane call", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        seedCandidate(db, { id: 2, tenantId: TENANT_A });
        contents.set(10, CV);
        contents.set(11, CV); // a re-upload of the same bytes under another media id
        await enqueue(TENANT_A, 1, 10);
        await tick();
        await enqueue(TENANT_A, 2, 11);
        const summary = await tick(1000);

        expect(summary.outcomes).toEqual({ CACHE_HIT: 1 });
        expect(runAiTask).toHaveBeenCalledTimes(1);
        expect(candidateOf(db, 2).parseStatus).toBe("COMPLETED");
        expect(candidateOf(db, 2).parsedResume.skills).toEqual(candidateOf(db, 1).parsedResume.skills);
        expect(events()[1].payload).toMatchObject({ candidateId: "2", fromCache: true, status: "COMPLETED" });
        // The ticket is gone; the one content row is the cache.
        expect(ledgerRows()).toHaveLength(1);
    });

    it("does NOT serve another tenant from the cache", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        seedCandidate(db, { id: 2, tenantId: TENANT_B });
        contents.set(10, CV);
        contents.set(20, CV);
        await enqueue(TENANT_A, 1, 10);
        await tick();
        await enqueue(TENANT_B, 2, 20);
        const summary = await tick(1000);

        expect(summary.outcomes).toEqual({ COMPLETED: 1 });
        expect(runAiTask).toHaveBeenCalledTimes(2);
        expect(runAiTask.mock.calls[1][0].tenantId).toBe(TENANT_B);
        expect(contentRow(TENANT_A, CV)).toBeDefined();
        expect(contentRow(TENANT_B, CV)).toBeDefined();
        expect(contentRow(TENANT_A, CV).id).not.toBe(contentRow(TENANT_B, CV).id);
    });

    it("a ticket waits for another candidate's parse of the same bytes, then takes the cache hit", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        seedCandidate(db, { id: 2, tenantId: TENANT_A });
        contents.set(10, CV);
        contents.set(11, CV);
        runAiTask.mockResolvedValueOnce({ taskId: "t-err", status: "error", error: "provider hiccup" });
        await enqueue(TENANT_A, 1, 10);
        await tick(); // candidate 1: attempt 1 fails, retry due in 1s
        await enqueue(TENANT_A, 2, 11);
        const deferred = await tick(100);
        expect(deferred.outcomes).toEqual({ DEFERRED: 1 });

        await tick(1000); // candidate 1 retries and completes
        expect(candidateOf(db, 1).parseStatus).toBe("COMPLETED");
        const later = await tick(100 + 30_000);
        expect(later.outcomes).toEqual({ CACHE_HIT: 1 });
        expect(candidateOf(db, 2).parseStatus).toBe("COMPLETED");
        expect(runAiTask).toHaveBeenCalledTimes(2);
    });
});

describe("retries through nextAttemptAt and the ceiling", () => {
    it("schedules each retry with the backoff and stops at three attempts", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        runAiTask.mockResolvedValue({ taskId: "t", status: "error", error: "provider down" });
        await enqueue(TENANT_A, 1, 10);

        expect((await tick(0)).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
        let row = contentRow(TENANT_A, CV);
        expect(row).toMatchObject({ status: "FAILED", attemptCount: 1, claimedBy: null });
        expect(row.nextAttemptAt).toEqual(at(1000));
        expect(row.lastError).toMatch(/^HR-RESUME-PLANE-FAILED/);
        expect(candidateOf(db, 1)).toMatchObject({ parseStatus: "FAILED", parseError: "HR-RESUME-PLANE-FAILED" });

        expect((await tick(500)).scanned).toBe(0); // not due yet
        expect((await tick(1000)).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
        row = contentRow(TENANT_A, CV);
        expect(row.attemptCount).toBe(2);
        expect(row.nextAttemptAt).toEqual(at(1000 + 4000));

        expect((await tick(5000)).outcomes).toEqual({ EXHAUSTED: 1 });
        row = contentRow(TENANT_A, CV);
        expect(row).toMatchObject({ status: "FAILED", attemptCount: 3, nextAttemptAt: null });
        expect(candidateOf(db, 1).parseStatus).toBe("EXHAUSTED");
        expect(events().at(-1).payload).toMatchObject({ status: "EXHAUSTED", attempts: 3, skillCount: 0 });

        expect((await tick(600_000)).scanned).toBe(0);
        expect(runAiTask).toHaveBeenCalledTimes(3);
    });

    it("a permanent failure is terminal after one attempt", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        runAiTask.mockRejectedValue(Object.assign(new Error("bad task"), { status: 400, code: "HR-AI-PLANE-BAD-REQUEST" }));
        await enqueue(TENANT_A, 1, 10);

        expect((await tick()).outcomes).toEqual({ FAILED: 1 });
        expect(contentRow(TENANT_A, CV)).toMatchObject({ status: "FAILED", attemptCount: 1, nextAttemptAt: null });
        expect(candidateOf(db, 1)).toMatchObject({ parseStatus: "FAILED", parseError: "HR-AI-PLANE-BAD-REQUEST" });
        expect((await tick(3_600_000)).scanned).toBe(0);
    });

    it("a ticket inherits a spent content row and does not buy new attempts", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        db.state.attempts.push({
            id: 900, tenantId: TENANT_A, kind: "CANDIDATE", contentHash: hashResumeContent(Buffer.from(CV)),
            status: "FAILED", attemptCount: 3, lastError: "HR-RESUME-PLANE-FAILED x", nextAttemptAt: null,
            parsedJson: null, candidateId: null, mediaId: 9, claimedBy: null, claimExpiresAt: null,
        });
        await enqueue(TENANT_A, 1, 10);
        expect((await tick()).outcomes).toEqual({ EXHAUSTED: 1 });
        expect(runAiTask).not.toHaveBeenCalled();
        expect(candidateOf(db, 1).parseStatus).toBe("EXHAUSTED");
        expect(ledgerRows().map((r) => r.id)).toEqual([900]);
    });

    it("a DAM download failure is counted on the ticket", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        await enqueue(TENANT_A, 1, 10); // no content for media 10: download fails
        expect((await tick()).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
        expect(ledgerRows()[0]).toMatchObject({ contentHash: "pending:c1:m10", status: "FAILED", attemptCount: 1 });
        expect(ledgerRows()[0].nextAttemptAt).toEqual(at(1000));
    });
});

describe("claims", () => {
    it("two overlapping ticks never work the same row", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        await enqueue(TENANT_A, 1, 10);
        const stale = await mcpCtx.run({ system: true }, async () =>
            await db.resumeParseAttempt.findMany({ where: worker.dueParseRowsWhere(T0), select: { id: true, tenantId: true } }));
        expect(stale).toHaveLength(1);

        // Tick A claims the row and is held inside the plane call.
        let release;
        runAiTask.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(planeOk()); }));
        const tickA = worker.runResumeParseWorkerTick({ now: T0, workerId: "w-a" });
        while (!release) await new Promise((resolve) => setImmediate(resolve));

        // Tick B scanned BEFORE A's claim (the stale list) and now tries to claim.
        const realFindMany = db.resumeParseAttempt.findMany;
        db.resumeParseAttempt.findMany = () => Promise.resolve(stale);
        const b = await worker.runResumeParseWorkerTick({ now: T0, workerId: "w-b" });
        db.resumeParseAttempt.findMany = realFindMany;
        expect(b).toMatchObject({ scanned: 1, claimed: 0, outcomes: { NOT_CLAIMED: 1 } });

        release();
        const a = await tickA;
        expect(a).toMatchObject({ claimed: 1, outcomes: { COMPLETED: 1 } });
        expect(runAiTask).toHaveBeenCalledTimes(1);
        expect(candidateOf(db, 1).parseStatus).toBe("COMPLETED");
    });

    it("a live claim is not due, so a later tick does not even see it", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        await enqueue(TENANT_A, 1, 10);
        let release;
        runAiTask.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(planeOk()); }));
        const tickA = worker.runResumeParseWorkerTick({ now: T0, workerId: "w-a" });
        while (!release) await new Promise((resolve) => setImmediate(resolve));
        await expect(worker.runResumeParseWorkerTick({ now: at(1000), workerId: "w-b" })).resolves.toMatchObject({ scanned: 0 });
        release();
        await tickA;
    });

    it("reclaims a RUNNING row whose lease expired, and leaves a live lease alone", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        seedCandidate(db, { id: 2, tenantId: TENANT_A });
        contents.set(10, CV);
        contents.set(11, OTHER_CV);
        const base = { tenantId: TENANT_A, kind: "CANDIDATE", status: "RUNNING", attemptCount: 1, lastError: null, nextAttemptAt: null, parsedJson: null };
        db.state.attempts.push(
            { ...base, id: 801, contentHash: hashResumeContent(Buffer.from(CV)), candidateId: 1, mediaId: 10, claimedBy: "crashed", claimExpiresAt: at(-1) },
            { ...base, id: 802, contentHash: hashResumeContent(Buffer.from(OTHER_CV)), candidateId: 2, mediaId: 11, claimedBy: "alive", claimExpiresAt: at(60_000) },
        );

        const summary = await tick();
        expect(summary).toMatchObject({ scanned: 1, claimed: 1, outcomes: { COMPLETED: 1 } });
        // The crashed attempt counted: this is attempt 2.
        expect(ledgerRows().find((r) => r.id === 801)).toMatchObject({ status: "COMPLETED", attemptCount: 2 });
        expect(ledgerRows().find((r) => r.id === 802)).toMatchObject({ status: "RUNNING", claimedBy: "alive" });
    });
});

describe("late plane answers", () => {
    it("stores the task id when the wait expires and collects the answer later without a second task", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        runAiTask.mockResolvedValueOnce({ taskId: "t-late", status: "pending", pending: true, sinceId: "1700-0" });
        await enqueue(TENANT_A, 1, 10);

        expect((await tick()).outcomes).toEqual({ PENDING: 1 });
        let row = contentRow(TENANT_A, CV);
        expect(row.parsedJson.pendingAiTask).toMatchObject({ taskId: "t-late", sinceId: "1700-0" });
        expect(row.nextAttemptAt).toEqual(at(30_000));
        expect(candidateOf(db, 1).parseStatus).toBe("PENDING");

        // Still not there: poll again, no attempt spent.
        expect((await tick(30_000)).outcomes).toEqual({ PENDING: 1 });
        expect(contentRow(TENANT_A, CV).attemptCount).toBe(1);

        collectAiResult.mockResolvedValueOnce(planeOk("t-late"));
        expect((await tick(60_000)).outcomes).toEqual({ COMPLETED: 1 });
        row = contentRow(TENANT_A, CV);
        expect(row).toMatchObject({ status: "COMPLETED", attemptCount: 1 });
        expect(row.parsedJson.pendingAiTask).toBeUndefined();
        expect(collectAiResult).toHaveBeenCalledWith({ taskId: "t-late", sinceId: "1700-0" });
        expect(runAiTask).toHaveBeenCalledTimes(1);
        expect(candidateOf(db, 1).parseStatus).toBe("COMPLETED");
    });

    it("gives up on a late answer after the window and runs a fresh attempt", async () => {
        seedCandidate(db, { id: 1, tenantId: TENANT_A });
        contents.set(10, CV);
        runAiTask.mockResolvedValueOnce({ taskId: "t-lost", status: "pending", pending: true, sinceId: "-" });
        await enqueue(TENANT_A, 1, 10);
        await tick();
        clock = at(16 * 60_000);
        db.state.attempts[0].nextAttemptAt = clock;
        expect((await tick(16 * 60_000)).outcomes).toEqual({ COMPLETED: 1 });
        expect(runAiTask).toHaveBeenCalledTimes(2);
        expect(contentRow(TENANT_A, CV).attemptCount).toBe(2);
    });
});

describe("projection parity with the request path", () => {
    it("writes the same CandidateSkill rows and parsedResume as ingestCandidateResume", async () => {
        // Request path, tenant A candidate 1.
        seedCandidate(db, { id: 1, tenantId: TENANT_A, resumeMediaId: 10 });
        contents.set(10, CV);
        await mcpCtx.run({ user: { tenantId: TENANT_A } }, async () =>
            await resume.ingestCandidateResume({ candidateId: 1, tenantId: TENANT_A }));

        // Worker path, tenant B candidate 2, same bytes (its own cache).
        seedCandidate(db, { id: 2, tenantId: TENANT_B });
        contents.set(20, CV);
        await enqueue(TENANT_B, 2, 20);
        await tick(1000);

        const strip = (rows, candidateId) =>
            rows.filter((s) => s.candidateId === candidateId).map(({ name, category, score, level, source }) => ({ name, category, score, level, source }));
        expect(strip(db.state.skills, 2)).toEqual(strip(db.state.skills, 1));
        expect(strip(db.state.skills, 1)).toHaveLength(3);

        const snapshot = (id) => ({ ...candidateOf(db, id).parsedResume, mediaId: undefined });
        expect(snapshot(2)).toEqual(snapshot(1));
        expect(candidateOf(db, 1).parseStatus).toBe("COMPLETED");
        expect(candidateOf(db, 2).parseStatus).toBe("COMPLETED");
        // Both paths emit the parsed event.
        expect(events().map((e) => e.payload.candidateId)).toEqual(["1", "2"]);
    });
});
