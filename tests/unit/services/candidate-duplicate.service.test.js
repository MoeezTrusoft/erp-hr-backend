// tests/unit/services/candidate-duplicate.service.test.js
//
// Recruitment Phase 2 — duplicate candidate detection and resolution. Prisma,
// the merge service and the outbox are mocked; the real tenantTransaction runs
// over the mock client. Pinned: blocking queries are narrow (no tenant scan),
// pairs are stored lower id first, terminal pairs are never reopened,
// anonymized / held rows are skipped, MERGE runs the existing merge with the
// chosen survivor and closes sibling suggestions, conflicts block, ORG only,
// and the flag gates detection but not listing.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const db = {
    candidate: { findMany: jest.fn(), findFirst: jest.fn() },
    candidateLegalHold: { findMany: jest.fn() },
    application: { findMany: jest.fn() },
    candidateDuplicateSuggestion: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (fn) => fn(db)),
    $executeRaw: jest.fn(async () => 1),
};
const mergeCandidates = jest.fn();
const enqueueHrDomainEvent = jest.fn(async () => ({ id: "outbox-1" }));
const silent = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
silent.child = () => silent;

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: silent }));
jest.unstable_mockModule("../../../src/services/candidate-merge.service.js", () => ({ mergeCandidates }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));

const svc = await import("../../../src/services/candidate-duplicate.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORG = resolveRecruitmentScope({ isAdmin: true, roles: [] });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });

const cand = (over = {}) => ({
    id: 10,
    tenantId: TENANT,
    firstName: "Ayesha",
    lastName: "Malik",
    email: "ayesha@example.com",
    phone: "+92 300 1234567",
    status: "active",
    consentStatus: "GRANTED",
    anonymizedAt: null,
    parsedResume: null,
    ...over,
});

const suggestion = (over = {}) => ({
    id: 5,
    tenantId: TENANT,
    candidateAId: 3,
    candidateBId: 10,
    score: 90,
    signals: { emailMatch: true },
    status: "OPEN",
    ...over,
});

const inTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT, employeeId: 7 } }, fn);

let savedFlag;
beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.HR_RECRUITMENT_DUPLICATES;
    process.env.HR_RECRUITMENT_DUPLICATES = "true";
    db.candidateLegalHold.findMany.mockResolvedValue([]);
    db.application.findMany.mockResolvedValue([]);
    db.candidateDuplicateSuggestion.findUnique.mockResolvedValue(null);
    db.candidateDuplicateSuggestion.createMany.mockResolvedValue({ count: 1 });
    db.candidateDuplicateSuggestion.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
    if (savedFlag === undefined) delete process.env.HR_RECRUITMENT_DUPLICATES;
    else process.env.HR_RECRUITMENT_DUPLICATES = savedFlag;
});

describe("blocking queries", () => {
    it("are narrow equality / prefix / suffix predicates, never a tenant scan", () => {
        const clauses = svc.blockingClauses(cand({ email: "Ay.esha+cv@Gmail.com", parsedResume: { contentHash: "h1" } }));
        const flat = JSON.stringify(clauses);
        expect(flat).toContain('"equals":"ayesha@gmail.com"');
        expect(flat).toContain('"equals":"ayesha@googlemail.com"');
        expect(flat).toContain('"startsWith":"ayesha+"');
        expect(flat).toContain('"endsWith":"4567"');
        expect(flat).toContain('"contentHash"');
        // Every clause constrains a column; none is an empty object.
        for (const clause of clauses) expect(Object.keys(clause).length).toBeGreaterThan(0);
    });

    it("emits no clause for a candidate with nothing to match on", () => {
        expect(svc.blockingClauses({ id: 1, email: "bad", phone: "12", firstName: "A", lastName: null })).toEqual([]);
    });

    it("the per-candidate query is tenant-scoped, active-only, excludes self and is capped", async () => {
        db.candidate.findFirst.mockResolvedValue(cand());
        db.candidate.findMany.mockResolvedValue([]);
        await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        const args = db.candidate.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: TENANT, id: { not: 10 }, status: "active", anonymizedAt: null });
        expect(Array.isArray(args.where.OR) && args.where.OR.length).toBeTruthy();
        expect(args.take).toBeLessThanOrEqual(50);
    });
});

describe("detection", () => {
    it("stores the pair lower id first with boolean signals", async () => {
        db.candidate.findFirst.mockResolvedValue(cand({ id: 10 }));
        db.candidate.findMany.mockResolvedValue([cand({ id: 3, email: "Ayesha+old@example.com", phone: "03001234567" })]);
        const result = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(result.created).toBe(1);
        const { data } = db.candidateDuplicateSuggestion.createMany.mock.calls[0][0];
        expect(data[0]).toMatchObject({ tenantId: TENANT, candidateAId: 3, candidateBId: 10, status: "OPEN", score: 100 });
        for (const value of Object.values(data[0].signals)) expect(typeof value).toBe("boolean");
        expect(db.candidateDuplicateSuggestion.findUnique.mock.calls[0][0].where).toEqual({
            tenantId_candidateAId_candidateBId: { tenantId: TENANT, candidateAId: 3, candidateBId: 10 },
        });
    });

    it("never reopens a DISMISSED (or MERGED) pair", async () => {
        db.candidate.findFirst.mockResolvedValue(cand());
        db.candidate.findMany.mockResolvedValue([cand({ id: 3 })]);
        for (const status of ["DISMISSED", "MERGED"]) {
            db.candidateDuplicateSuggestion.findUnique.mockResolvedValueOnce(suggestion({ status, score: 10 }));
            const r = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
            expect(r.terminal).toBe(1);
        }
        expect(db.candidateDuplicateSuggestion.createMany).not.toHaveBeenCalled();
        expect(db.candidateDuplicateSuggestion.updateMany).not.toHaveBeenCalled();
    });

    it("updates an OPEN pair only when its score or signals changed", async () => {
        db.candidate.findFirst.mockResolvedValue(cand());
        db.candidate.findMany.mockResolvedValue([cand({ id: 3, email: "x@y.com", phone: "0300 1234567", firstName: "Other" })]);
        db.candidateDuplicateSuggestion.findUnique.mockResolvedValueOnce(
            suggestion({ score: 70, signals: { resumeHashMatch: false, profileUrlMatch: false, nameMatch: false, phoneMatch: true, emailMatch: false } }),
        );
        const same = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(same.unchanged).toBe(1);
        expect(db.candidateDuplicateSuggestion.updateMany).not.toHaveBeenCalled();

        db.candidateDuplicateSuggestion.findUnique.mockResolvedValueOnce(suggestion({ score: 90, signals: { emailMatch: true } }));
        const changed = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(changed.updated).toBe(1);
        expect(db.candidateDuplicateSuggestion.updateMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: TENANT, id: 5, status: "OPEN" },
            data: { score: 70 },
        });
    });

    it("does not create a pair below the threshold (name only)", async () => {
        db.candidate.findFirst.mockResolvedValue(cand({ phone: null }));
        db.candidate.findMany.mockResolvedValue([cand({ id: 3, email: "other@x.com", phone: null })]);
        const r = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(r.below).toBe(1);
        expect(db.candidateDuplicateSuggestion.createMany).not.toHaveBeenCalled();
    });

    it("skips a candidate under legal hold, and a held or anonymized match", async () => {
        db.candidate.findFirst.mockResolvedValue(cand());
        db.candidate.findMany.mockResolvedValue([cand({ id: 3 })]);
        db.candidateLegalHold.findMany.mockResolvedValueOnce([{ candidateId: 10 }]);
        const held = await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(held.skippedLegalHold).toBe(1);

        db.candidate.findMany.mockResolvedValue([cand({ id: 3 }), cand({ id: 4, anonymizedAt: new Date() })]);
        db.candidateLegalHold.findMany.mockResolvedValueOnce([{ candidateId: 3 }]);
        await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(db.candidateDuplicateSuggestion.createMany).not.toHaveBeenCalled();
    });

    it("never examines an anonymized candidate", async () => {
        db.candidate.findFirst.mockResolvedValue(cand({ anonymizedAt: new Date() }));
        await inTenant(() => svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }));
        expect(db.candidate.findMany).not.toHaveBeenCalled();
    });

    it("detect is ORG only and 503 when the flag is off", async () => {
        await expect(svc.detectCandidateDuplicates({ tenantId: TENANT, scope: MANAGER, candidateId: 10 }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-DUPLICATES-ORG-ONLY" });
        process.env.HR_RECRUITMENT_DUPLICATES = "false";
        await expect(svc.detectCandidateDuplicates({ tenantId: TENANT, scope: ORG, candidateId: 10 }))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-DUPLICATES-DISABLED" });
    });
});

describe("runCandidateDuplicateDetectionJob", () => {
    it("returns FLAG_OFF without touching the DB when the flag is off", async () => {
        process.env.HR_RECRUITMENT_DUPLICATES = "false";
        expect(await svc.runCandidateDuplicateDetectionJob()).toEqual({ skipped: "FLAG_OFF" });
        expect(db.candidate.findMany).not.toHaveBeenCalled();
    });

    it("scans only candidates changed in the window, per tenant, and isolates tenant failures", async () => {
        const now = new Date("2026-10-20T12:00:00Z");
        const OTHER = "22222222-2222-4222-8222-222222222222";
        db.candidate.findMany
            .mockResolvedValueOnce([{ tenantId: TENANT }, { tenantId: OTHER }]) // tenant discovery
            .mockRejectedValueOnce(new Error("boom")) // TENANT's changed rows
            .mockResolvedValueOnce([]); // OTHER's changed rows
        const result = await svc.runCandidateDuplicateDetectionJob({ now, lookbackHours: 2 });
        expect(result.tenants).toBe(2);
        expect(result.perTenant[0]).toMatchObject({ tenantId: TENANT, error: "boom" });
        expect(result.perTenant[1]).toMatchObject({ tenantId: OTHER, examined: 0 });
        const since = new Date("2026-10-20T10:00:00Z");
        expect(db.candidate.findMany.mock.calls[0][0]).toMatchObject({ where: { updatedAt: { gte: since } }, distinct: ["tenantId"] });
        expect(db.candidate.findMany.mock.calls[2][0].where).toMatchObject({ tenantId: OTHER, status: "active", anonymizedAt: null, updatedAt: { gte: since } });
    });

    it("every query runs under the right context at await time (Prisma queries are lazy)", async () => {
        // A Prisma query only executes when awaited, so the mock is a lazy
        // thenable that records the context at THAT moment. A callback that
        // returned the query unawaited would record no context here.
        const seen = [];
        const lazy = (label, value) => ({
            then: (resolve, reject) => {
                const store = mcpCtx.getStore();
                seen.push({ label, system: store?.system === true, tenantId: store?.user?.tenantId ?? null, tx: store?.tenantTransactionActive === true });
                return Promise.resolve(value).then(resolve, reject);
            },
        });
        db.candidate.findMany
            .mockImplementationOnce(() => lazy("discover", [{ tenantId: TENANT }]))
            .mockImplementationOnce(() => lazy("changed", []));
        await svc.runCandidateDuplicateDetectionJob({});
        expect(seen).toEqual([
            { label: "discover", system: true, tenantId: null, tx: false },
            { label: "changed", system: false, tenantId: TENANT, tx: false },
        ]);

        // The claim and the sibling close run inside tenantTransaction's context.
        seen.length = 0;
        db.candidateDuplicateSuggestion.findFirst.mockResolvedValue(suggestion());
        db.candidate.findMany.mockResolvedValue([
            { id: 3, status: "active", anonymizedAt: null },
            { id: 10, status: "active", anonymizedAt: null },
        ]);
        mergeCandidates.mockResolvedValue({ merged: true });
        db.candidateDuplicateSuggestion.updateMany.mockImplementation(() => lazy("update", { count: 1 }));
        await svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3 });
        expect(seen.map((s) => [s.label, s.tx])).toEqual([["update", true], ["update", true]]);
        expect(db.$transaction).toHaveBeenCalled();
        db.candidateDuplicateSuggestion.updateMany.mockReset();
    });

    it("one bad candidate never stops the tenant", async () => {
        db.candidate.findMany
            .mockResolvedValueOnce([{ tenantId: TENANT }])
            .mockResolvedValueOnce([cand({ id: 10 }), cand({ id: 11, email: "b@x.com", phone: null, firstName: "B" })])
            .mockRejectedValueOnce(new Error("row failed"))
            .mockResolvedValueOnce([]);
        const result = await svc.runCandidateDuplicateDetectionJob({});
        expect(result).toMatchObject({ examined: 2, failed: 1 });
    });
});

describe("listDuplicateSuggestions", () => {
    const row = () => ({
        ...suggestion({ signals: { emailMatch: true, phoneMatch: "0300", raw: "x@y.com" } }),
        detectedAt: new Date(),
        candidateA: { id: 3, firstName: "Ayesha", email: "a@x.com", status: "active", consentStatus: "GRANTED", anonymizedAt: null },
        candidateB: { id: 10, firstName: "Ayesha", email: "a+1@x.com", status: "active", consentStatus: "UNKNOWN", anonymizedAt: null },
    });

    it("is an empty page for a non-ORG scope", async () => {
        const r = await svc.listDuplicateSuggestions({ tenantId: TENANT, scope: MANAGER });
        expect(r).toMatchObject({ items: [], total: 0 });
        expect(db.candidateDuplicateSuggestion.findMany).not.toHaveBeenCalled();
    });

    it("works with the flag off and returns boolean signals with fresh conflicts", async () => {
        process.env.HR_RECRUITMENT_DUPLICATES = "false";
        db.candidateDuplicateSuggestion.findMany.mockResolvedValue([row()]);
        db.candidateDuplicateSuggestion.count.mockResolvedValue(1);
        db.application.findMany.mockResolvedValue([
            { candidateId: 3, jobRequisitionId: 9, stage: "interview" },
            { candidateId: 10, jobRequisitionId: 9, stage: "applied" },
        ]);
        db.candidateLegalHold.findMany.mockResolvedValue([{ candidateId: 10 }]);
        const r = await svc.listDuplicateSuggestions({ tenantId: TENANT, scope: ORG, candidateId: 10 });
        expect(r.total).toBe(1);
        const [item] = r.items;
        expect(item.signals).toEqual({ emailMatch: true, phoneMatch: false, raw: false });
        expect(item.conflicts.map((c) => c.code).sort()).toEqual(["CONSENT_MISMATCH", "LEGAL_HOLD", "SHARED_ACTIVE_REQUISITION"]);
        expect(item.candidateB.legalHold).toBe(true);
        expect(db.candidateDuplicateSuggestion.findMany.mock.calls[0][0].where).toEqual({
            tenantId: TENANT,
            status: "OPEN",
            OR: [{ candidateAId: 10 }, { candidateBId: 10 }],
        });
    });
});

describe("resolveDuplicateSuggestion", () => {
    const pairRows = (over = {}) => [
        { id: 3, status: "active", anonymizedAt: null, ...(over[3] ?? {}) },
        { id: 10, status: "active", anonymizedAt: null, ...(over[10] ?? {}) },
    ];

    beforeEach(() => {
        db.candidateDuplicateSuggestion.findFirst.mockResolvedValue(suggestion());
        db.candidate.findMany.mockResolvedValue(pairRows());
        mergeCandidates.mockResolvedValue({ merged: true, sourceId: 10, targetId: 3 });
    });

    it("is ORG only", async () => {
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: MANAGER, id: 5, action: "DISMISS" }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-DUPLICATES-ORG-ONLY" });
        expect(db.candidateDuplicateSuggestion.findFirst).not.toHaveBeenCalled();
    });

    it("MERGE claims the suggestion, merges with the chosen survivor, closes siblings and emits", async () => {
        db.candidateDuplicateSuggestion.updateMany
            .mockResolvedValueOnce({ count: 1 }) // claim
            .mockResolvedValueOnce({ count: 2 }); // siblings
        const r = await inTenant(() =>
            svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3, actorId: 7, note: "same person" }),
        );
        expect(r).toMatchObject({ status: "MERGED", survivorId: 3, mergedId: 10, siblingsClosed: 2 });
        expect(mergeCandidates).toHaveBeenCalledWith({ tenantId: TENANT, sourceId: 10, targetId: 3, actorId: 7, keepTargetOnConflict: false });

        const [claim, siblings] = db.candidateDuplicateSuggestion.updateMany.mock.calls.map((c) => c[0]);
        expect(claim).toMatchObject({ where: { tenantId: TENANT, id: 5, status: "OPEN" }, data: { status: "MERGED", resolvedById: 7, resolutionNote: "same person" } });
        expect(siblings).toMatchObject({
            where: { tenantId: TENANT, id: { not: 5 }, status: "OPEN", OR: [{ candidateAId: 10 }, { candidateBId: 10 }] },
            data: { status: "DISMISSED", resolutionNote: "MERGED_ELSEWHERE" },
        });
        expect(mergeCandidates.mock.invocationCallOrder[0]).toBeGreaterThan(db.candidateDuplicateSuggestion.updateMany.mock.invocationCallOrder[0]);

        const event = enqueueHrDomainEvent.mock.calls[0][1];
        expect(event).toMatchObject({
            eventName: "hr.recruitment.candidate_duplicate_resolved.v1",
            tenantId: TENANT,
            aggregateType: "CandidateDuplicateSuggestion",
            aggregateId: 5,
            payload: { suggestionId: "5", action: "MERGE", survivorId: "3", mergedId: "10" },
        });
    });

    it("passes the recruiter's keep-survivor confirmation to the merge", async () => {
        await inTenant(() => svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 10, keepSurvivorOnConflict: true }));
        expect(mergeCandidates).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 3, targetId: 10, keepTargetOnConflict: true }));
    });

    it("rejects a survivor outside the pair", async () => {
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 99 }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-DUPLICATE-SURVIVOR-INVALID" });
        expect(mergeCandidates).not.toHaveBeenCalled();
    });

    it("blocks a merge on legal hold, anonymization or an inactive merged-away row", async () => {
        db.candidateLegalHold.findMany.mockResolvedValueOnce([{ candidateId: 10 }]);
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3 }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-LEGAL-HOLD" });

        db.candidate.findMany.mockResolvedValueOnce(pairRows({ 3: { anonymizedAt: new Date() } }));
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 10 }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-ANONYMIZED" });

        db.candidate.findMany.mockResolvedValueOnce(pairRows({ 10: { status: "archived" } }));
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3 }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-SOURCE-INACTIVE" });

        expect(mergeCandidates).not.toHaveBeenCalled();
        expect(db.candidateDuplicateSuggestion.updateMany).not.toHaveBeenCalled();
    });

    it("a failed merge releases the claim back to OPEN and rethrows", async () => {
        mergeCandidates.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409, code: "HR-RECRUITMENT-MERGE-APPLICATION-CONFLICT" }));
        await expect(inTenant(() => svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3 })))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-APPLICATION-CONFLICT" });
        const release = db.candidateDuplicateSuggestion.updateMany.mock.calls[1][0];
        expect(release).toMatchObject({ where: { id: 5, status: "MERGED" }, data: { status: "OPEN", resolvedAt: null } });
        expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
    });

    it("a lost claim race is a 409 and never merges", async () => {
        db.candidateDuplicateSuggestion.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(inTenant(() => svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "MERGE", survivorId: 3 })))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT" });
        expect(mergeCandidates).not.toHaveBeenCalled();
    });

    it("DISMISS records who/when/why and emits, without merging", async () => {
        const r = await inTenant(() => svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "DISMISS", actorId: 7, note: "siblings" }));
        expect(r).toMatchObject({ status: "DISMISSED" });
        expect(db.candidateDuplicateSuggestion.updateMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: TENANT, id: 5, status: "OPEN" },
            data: { status: "DISMISSED", resolvedById: 7, resolutionNote: "siblings", resolvedAt: expect.any(Date) },
        });
        expect(enqueueHrDomainEvent.mock.calls[0][1].payload).toEqual({ suggestionId: "5", action: "DISMISS", survivorId: null, mergedId: null });
        expect(mergeCandidates).not.toHaveBeenCalled();
    });

    it("refuses an already-resolved suggestion or a stale expectedStatus", async () => {
        db.candidateDuplicateSuggestion.findFirst.mockResolvedValueOnce(suggestion({ status: "DISMISSED" }));
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "DISMISS" }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT" });
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "DISMISS", expectedStatus: "MERGED" }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT" });
    });

    it("404s an unknown suggestion", async () => {
        db.candidateDuplicateSuggestion.findFirst.mockResolvedValueOnce(null);
        await expect(svc.resolveDuplicateSuggestion({ tenantId: TENANT, scope: ORG, id: 5, action: "DISMISS" }))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-DUPLICATE-NOT-FOUND" });
    });
});
