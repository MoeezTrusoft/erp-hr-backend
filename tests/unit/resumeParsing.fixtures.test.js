// Deterministic fictional PDF resumes exercise extraction, cache hashing and taxonomy reconciliation.
// Regenerate with tests/fixtures/resumes/generate.py; the AI plane is mocked.
import { describe, it, expect, beforeAll, afterEach, jest } from "@jest/globals";

// pdf-parse's dynamic import inside extractResumeText is slow the first time
// (wasm/pdfjs init); the default 5s test timeout trips it and the teardown
// then kills the late import. Warm it in beforeAll under a generous timeout.
jest.setTimeout(60_000);
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(THIS_DIR, "../fixtures/resumes");
const RESUME_FIXTURES = ["backend.pdf", "quality.pdf", "network.pdf", "operations.pdf"];

const prisma = {
    $executeRaw: jest.fn(async () => 1),
    $executeRawUnsafe: jest.fn(async () => 1),
    $queryRawUnsafe: jest.fn(async () => []),
    candidate: { findFirst: jest.fn(async () => ({ id: 1, status: "active", consentStatus: "GRANTED", email: null, anonymizedAt: null })) },
    candidateConsent: { findFirst: jest.fn(async () => ({ status: "GRANTED" })) },
    $transaction: (fn) => fn(prisma),
    resumeParseAttempt: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => null), // first parse, no ledger history
        upsert: jest.fn(async ({ where, create }) => ({ id: 1, ...create })),
        update: jest.fn(async ({ data }) => ({ id: 1, ...data })),
        delete: jest.fn(async () => ({})),
    },
    aiInferenceRecord: { create: jest.fn(async (args) => ({ id: 1, ...args.data ?? args })) },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const downloadDamAssetBuffer = jest.fn();
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer, deleteDamAsset: jest.fn(), getDamAssetById: jest.fn(), normalizeDamAssetResponse: (p) => p }));

// The plane answers with a realistic extract over a mid-size resume.
const runAiTask = jest.fn(async ({ input }) => ({
    taskId: "t-fixture",
    status: "ok",
    tokensUsed: 900,
    output: {
        provider: "openai",
        model: "gpt-4.1-mini",
        promptKey: "hr.resume.parse.v1",
        redactionCounts: { EMAIL: 1, PHONE: 1 },
        result: {
            skills: [
                { name: "JavaScript", score: 85, level: "Advanced" },
                { name: "Laravel", score: 80, level: "Advanced" },
                { name: "MySQL", score: 75, level: "Intermediate" },
            ],
            competencies: [{ name: "Team Leadership", score: 70, level: "Intermediate" }],
            certifications: [],
        },
    },
}));

jest.unstable_mockModule("../../src/lib/aiPlaneClient.js", () => ({ runAiTask }));

const { parseResumeWithRetry } = await import("../../src/services/resumeParsing.service.js");
const { hashResumeContent } = await import("../../src/lib/parseRetry.js");
const { buildAliasIndex, reconcileParsedSkills } = await import("../../src/lib/skillNormalization.js");

const fixtures = new Map(); // name → { buffer }
let pdfParseWarm = null;

afterEach(() => {
    delete process.env.HR_RECRUITMENT_AI; // each test sets its own posture
});

beforeAll(async () => {
    // Warm the lazy vendor import so the first test does not pay its cost.
    pdfParseWarm = await import("pdf-parse").catch(() => null);
    for (const name of RESUME_FIXTURES) {
        const p = path.join(FIXTURE_DIR, name);
        if (!fs.existsSync(p)) throw new Error(`Fixture missing: ${p}`);
        const buffer = fs.readFileSync(p);
        fixtures.set(name, { buffer });
    }
});

describe("fictional PDF resume corpus — extraction", () => {
    it("a disabled AI flag refuses the parse BEFORE any plane call (Phase 15 gate)", async () => {
        process.env.HR_RECRUITMENT_AI = "false";
        downloadDamAssetBuffer.mockResolvedValue({
            buffer: fixtures.get("operations.pdf").buffer,
            mimeType: "application/pdf",
            fileName: "operations.pdf",
        });
        prisma.resumeParseAttempt.upsert.mockClear();
        prisma.resumeParseAttempt.updateMany.mockClear();
        await expect(parseResumeWithRetry(9002, { kind: "CANDIDATE", tenantId: "t-fix", candidateId: 1 }))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-AI-DISABLED" });
        // A PERMANENT classification: no backoff sleeps, no wasted retry cycle.
        expect(prisma.resumeParseAttempt.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.resumeParseAttempt.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.resumeParseAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED", lastError: "HR-RESUME-PERMANENT", leaseToken: null }),
        }));
        // Nothing reached the plane and no §7.4 provenance row was written —
        // the gate fires before any AI-side effect (the parse-attempt ledger
        // row is the only trace, marked FAILED by the wrapper's catch).
        expect(runAiTask).not.toHaveBeenCalled();
        expect(prisma.aiInferenceRecord.create).not.toHaveBeenCalled();
    });

    it("extracts meaningful text from every fixture PDF", async () => {
        for (const [name, { buffer }] of fixtures) {
        process.env.HR_RECRUITMENT_AI = "true"; // exercise the full pipeline
        downloadDamAssetBuffer.mockResolvedValue({ buffer, mimeType: "application/pdf", fileName: name });
        const out = await parseResumeWithRetry(9001, { kind: "CANDIDATE", tenantId: "t-fix", candidateId: 1 });
            expect(out.skills.length).toBeGreaterThan(0);
            expect(out.charsAnalyzed).toBeGreaterThan(1000);
            // The §7.4 provenance travelled with the result.
            expect(out.aiProvenance.provider).toBe("openai");
            expect(out.aiProvenance.promptKey).toBe("hr.resume.parse.v1");
            expect(out.redactedNote ?? null).toBeNull(); // no PII echoes in the normalized output
        }
    });

    it("hashes each fixture distinctly — the §4.5a cache keys real documents apart", () => {
        const hashes = new Set([...fixtures.values()].map(({ buffer }) => hashResumeContent(buffer)));
        expect(hashes.size).toBe(fixtures.size);
    });

    it("reconciliation maps the plane's skills onto the canonical taxonomy without inventing matches", () => {
        const index = buildAliasIndex(
            [{ alias: "js", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null }],
            [
                { id: 1, name: "JavaScript", tenantId: null },
                { id: 2, name: "MySQL", tenantId: null },
            ],
            null,
        );
        const { mapped, unmapped } = reconcileParsedSkills(index, [
            { name: "JavaScript", score: 85, level: "Advanced" }, // canonical name
            { name: "js", score: 80, level: "Advanced" },         // platform alias
            { name: "MySQL", score: 75, level: "Intermediate" },  // canonical name
            { name: "Administrative reference field", score: null, level: null }, // NOT a skill — must stay unmapped
        ]);
        expect(mapped.map((m) => m.skillId).sort()).toEqual([1, 1, 2]);
        expect(unmapped.map((u) => u.raw)).toEqual(["Administrative reference field"]);
    });

    it("the fixture corpus is present and non-trivial (guards against silent fixture loss)", () => {
        expect(pdfParseWarm).not.toBeNull(); // the vendor dep this suite exercises
        expect(fixtures.size).toBe(4);
        for (const { buffer } of fixtures.values()) {
            expect(buffer.length).toBeGreaterThan(10_000);
            expect(buffer.slice(0, 5).toString()).toBe("%PDF-");
        }
    });
});
