// Phase 2 — the resume parse queue entry (a ticket row on the parse ledger),
// its never-throws contract, and the recruiter-facing status/re-queue reads
// behind hr_candidate_resume_parse_status / hr_candidate_resume_parse_retry.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import { makeFakeDb, seedCandidate, candidateOf } from "./helpers/resume-ledger.fake.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");

let db = makeFakeDb({ now: () => NOW });
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: async (client, fn) => await fn(client),
}));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const queue = await import("../../../src/services/resume-parse-queue.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { registerResumeParseStatusTools } = await import("../../../src/mcp/tools/resume-parse-status.tools.js");

const ORG = resolveRecruitmentScope({ isAdmin: true, roles: [] });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });
const enqueue = (args) => queue.enqueueCandidateResumeParse({ now: NOW, ...args });
const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, async () => await fn());

beforeEach(() => {
    db = makeFakeDb({ now: () => NOW });
    jest.clearAllMocks();
    seedCandidate(db, { id: 1, tenantId: TENANT_A, resumeMediaId: 10 });
});

describe("enqueueCandidateResumeParse", () => {
    it("writes one PENDING ticket keyed by candidate + media and marks the candidate PENDING", async () => {
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10, applicationId: 5 })).resolves.toEqual({ queued: true });
        expect(db.state.attempts).toHaveLength(1);
        expect(db.state.attempts[0]).toMatchObject({
            tenantId: TENANT_A,
            kind: "CANDIDATE",
            contentHash: "pending:c1:m10",
            status: "PENDING",
            attemptCount: 0,
            candidateId: 1,
            mediaId: 10,
            nextAttemptAt: NOW,
        });
        expect(candidateOf(db, 1).parseStatus).toBe("PENDING");
        // Called with no request context: it ran under the tenant's own.
        expect(db.state.ops.every((o) => o.tenant === TENANT_A)).toBe(true);
    });

    it("is idempotent per candidate + media", async () => {
        await enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10 });
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10 })).resolves.toEqual({ queued: true, reason: "ALREADY_QUEUED" });
        expect(db.state.attempts).toHaveLength(1);
        // A new media for the same candidate is a new entry.
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 11 })).resolves.toEqual({ queued: true });
        expect(db.state.attempts).toHaveLength(2);
    });

    it("never throws: bad input, another tenant's candidate, a failing write", async () => {
        await expect(enqueue({ tenantId: TENANT_A, candidateId: null, mediaId: 10 })).resolves.toEqual({ queued: false, reason: "MISSING_INPUT" });
        await expect(enqueue({ tenantId: null, candidateId: 1, mediaId: 10 })).resolves.toEqual({ queued: false, reason: "MISSING_INPUT" });
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 0 })).resolves.toEqual({ queued: false, reason: "MISSING_INPUT" });
        await expect(enqueue({ tenantId: TENANT_B, candidateId: 1, mediaId: 10 })).resolves.toEqual({ queued: false, reason: "CANDIDATE_NOT_FOUND" });

        db.candidate.findFirst = () => Promise.reject(new Error("connection reset"));
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10 })).resolves.toEqual({ queued: false, reason: "QUEUE_WRITE_FAILED" });
        expect(db.state.attempts).toHaveLength(0);
    });

    it("refuses a caller whose context holds a different tenant (as a failed queue, not a throw)", async () => {
        const result = await asTenant(TENANT_B, () => enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10 }));
        expect(result).toEqual({ queued: false, reason: "QUEUE_WRITE_FAILED" });
        expect(db.state.attempts).toHaveLength(0);
    });

    it("writes inside the caller's transaction when given one", async () => {
        const result = await asTenant(TENANT_A, () => enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10, tx: db }));
        expect(result).toEqual({ queued: true });
        expect(db.state.attempts).toHaveLength(1);
    });

    it("skips a media that already parsed, unless forced", async () => {
        Object.assign(candidateOf(db, 1), { parseStatus: "COMPLETED", parsedResume: { mediaId: 10 } });
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10 })).resolves.toEqual({ queued: false, reason: "ALREADY_PARSED" });
        await expect(enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10, force: true })).resolves.toEqual({ queued: true });
    });

    it("force resets the content rows of that media but never another candidate's ticket", async () => {
        db.state.attempts.push(
            { id: 50, tenantId: TENANT_A, kind: "CANDIDATE", contentHash: "a".repeat(64), status: "FAILED", attemptCount: 3, lastError: "x", nextAttemptAt: null, mediaId: 10, candidateId: null, parsedJson: null, claimedBy: null, claimExpiresAt: null },
            { id: 51, tenantId: TENANT_A, kind: "CANDIDATE", contentHash: "pending:c2:m10", status: "PENDING", attemptCount: 0, lastError: null, nextAttemptAt: NOW, mediaId: 10, candidateId: 2, parsedJson: null, claimedBy: null, claimExpiresAt: null },
        );
        await enqueue({ tenantId: TENANT_A, candidateId: 1, mediaId: 10, force: true });
        expect(db.state.attempts.find((r) => r.id === 50)).toMatchObject({ status: "PENDING", attemptCount: 0, nextAttemptAt: NOW, candidateId: 1 });
        expect(db.state.attempts.find((r) => r.id === 51)).toMatchObject({ candidateId: 2 });
    });
});

describe("status and re-queue", () => {
    const content = (extra) => ({
        id: 60, tenantId: TENANT_A, kind: "CANDIDATE", contentHash: "b".repeat(64), mediaId: 10, candidateId: 1,
        parsedJson: null, claimedBy: null, claimExpiresAt: null, updatedAt: NOW, ...extra,
    });

    it("reports attempts, the next attempt and the error CODE only", async () => {
        db.state.attempts.push(content({ status: "FAILED", attemptCount: 1, nextAttemptAt: new Date("2026-10-20T10:00:01Z"), lastError: "HR-RESUME-PLANE-FAILED AI plane parse failed: quoted resume text" }));
        candidateOf(db, 1).parseStatus = "FAILED";
        const status = await asTenant(TENANT_A, () => queue.getCandidateResumeParseStatus({ tenantId: TENANT_A, candidateId: 1, scope: ORG, now: NOW }));
        expect(status).toMatchObject({
            candidateId: 1,
            resumeMediaId: 10,
            parseStatus: "FAILED",
            queue: { stage: "CONTENT", status: "FAILED", attempts: 1, maxAttempts: 3, terminal: false, lastErrorCode: "HR-RESUME-PLANE-FAILED" },
        });
        expect(JSON.stringify(status)).not.toMatch(/quoted resume text/);
    });

    it("is cut to the caller's candidate scope", async () => {
        await expect(asTenant(TENANT_A, () => queue.getCandidateResumeParseStatus({ tenantId: TENANT_A, candidateId: 1, scope: FINANCE })))
            .rejects.toMatchObject({ status: 404 });
    });

    it("re-queue is recruiters only, refuses a spent resume without force, and resets it with force", async () => {
        db.state.attempts.push(content({ status: "FAILED", attemptCount: 3, nextAttemptAt: null, lastError: "HR-RESUME-PLANE-FAILED x" }));
        const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
        await expect(asTenant(TENANT_A, () => queue.requeueCandidateResumeParse({ tenantId: TENANT_A, candidateId: 1, scope: MANAGER })))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-PARSE-FORBIDDEN" });
        await expect(asTenant(TENANT_A, () => queue.requeueCandidateResumeParse({ tenantId: TENANT_A, candidateId: 1, scope: ORG })))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-PARSE-EXHAUSTED" });

        const result = await asTenant(TENANT_A, () => queue.requeueCandidateResumeParse({ tenantId: TENANT_A, candidateId: 1, scope: ORG, force: true, now: NOW }));
        expect(result).toMatchObject({ candidateId: 1, resumeMediaId: 10, queued: true });
        expect(db.state.attempts.find((r) => r.id === 60)).toMatchObject({ status: "PENDING", attemptCount: 0 });
        expect(db.state.attempts.some((r) => r.contentHash === "pending:c1:m10")).toBe(true);
    });
});

describe("MCP registrar", () => {
    const handlers = new Map();
    registerResumeParseStatusTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });
    const call = (name, args, permissions) =>
        mcpCtx.run({ user: { tenantId: TENANT_A, isAdmin: false, roles: [] }, permissions }, async () => await handlers.get(name)(args));

    it("registers the two tools under recruitment names", () => {
        expect([...handlers.keys()].sort()).toEqual(["hr_candidate_resume_parse_retry", "hr_candidate_resume_parse_status"]);
        for (const name of handlers.keys()) expect(name).toMatch(/^hr_(requisition|candidate|interview|offer|talent|recruitment|application|pipeline)/);
    });

    it("denies a caller without the hr:recruitment permission", async () => {
        const res = await call("hr_candidate_resume_parse_status", { candidateId: 1 }, {});
        expect(res.isError).toBe(true);
    });
});
