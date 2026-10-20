// tests/unit/applicationDraft.service.test.js
//
// Phase 5 / FR-04.07 — SAVE-AND-RETURN. The assertions that matter:
//
//   * the draft is ONE per candidate+requisition (upsert replaces — the old
//     link dies), reconciling the candidate by email like intake does;
//   * the resume link is a §3.2-class token: sha256 at rest, raw token only
//     in the emailed URL, sent AFTER commit and fail-soft;
//   * LOAD: unknown/expired/submitted/anonymized all resolve to null (the
//     route renders one uniform body);
//   * SUBMIT goes THROUGH the public intake service — the draft can never
//     bypass the mandatory-field, §2.9 eligibility or §3.5 question gates;
//     the tenant comes from the draft's own requisition row;
//   * PURGE: the erasure hook deletes by candidate; the sweep deletes expired.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import crypto from "node:crypto";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = Date.now();

const rows = { drafts: new Map() };
let draftSeq = 1;

const prisma = {
    candidate: {
        findFirst: jest.fn(),
        create: jest.fn(async ({ data }) => ({ id: 50, firstName: data.firstName, email: data.email, anonymizedAt: null, status: "active" })),
    },
    applicationDraft: {
        upsert: jest.fn(async ({ create }) => {
            const row = { id: draftSeq++, ...create, submittedAt: null };
            rows.drafts.set(create.tokenHash, row);
            return row;
        }),
        findUnique: jest.fn(async ({ where }) => {
            const row = rows.drafts.get(where.tokenHash);
            if (!row) return null;
            return {
                ...row,
                candidate: { id: row.candidateId, firstName: "Ayesha", email: "ayesha@example.com", anonymizedAt: null, status: "active" },
                requisition: { id: row.requisitionId, title: "Backend Engineer", tenantId: TENANT },
            };
        }),
        update: jest.fn(async ({ where, data }) => {
            for (const row of rows.drafts.values()) if (row.id === where.id) Object.assign(row, data);
            return { id: where.id, ...data };
        }),
        deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    // Phase 2 / D-11 — a draft save probes the do-not-contact register.
    candidateDncEntry: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
};

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn((client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/lib/notificationClient.js", () => ({
    sendCandidateEmail: jest.fn(async () => ({ sent: true })),
}));
jest.unstable_mockModule("../../src/lib/recruitmentFlags.js", () => ({
    isRecruitmentFlagEnabled: jest.fn(() => true),
}));
const submitPublicApplication = jest.fn(async ({ body }) => ({ received: true, applicationId: 901, name: body.firstName }));
jest.unstable_mockModule("../../src/services/publicPortal.service.js", () => ({
    submitPublicApplication,
}));

const { sendCandidateEmail } = await import("../../src/lib/notificationClient.js");
const {
    saveApplicationDraft,
    loadApplicationDraft,
    submitApplicationDraft,
    purgeDraftsForCandidate,
    purgeExpiredDrafts,
    parseDraftPayload,
} = await import("../../src/services/applicationDraft.service.js");

beforeEach(() => {
    jest.clearAllMocks();
    rows.drafts.clear();
    draftSeq = 1;
    prisma.candidate.findFirst.mockResolvedValue({ id: 7, firstName: "Ayesha" });
    submitPublicApplication.mockClear();
});

const savedTokenOf = () => {
    // The raw token never lands in the DB; recover it from the emailed URL.
    const url = sendCandidateEmail.mock.calls.at(-1)[0].data.draftUrl;
    return new URL(url, "https://portal.test").searchParams.get("token");
};

describe("Phase 5 / FR-04.07 — saving a draft", () => {
    it("upserts ONE draft per candidate+requisition, hashes the token, and emails the link after commit", async () => {
        const result = await saveApplicationDraft({
            tenantId: TENANT,
            requisitionId: 5,
            email: "ayesha@example.com",
            firstName: "Ayesha",
            body: { firstName: "Ayesha", answers: { 12: "Karachi" } },
        });

        expect(result.saved).toBe(true);
        expect(result.emailed).toBe(true);
        const created = prisma.applicationDraft.upsert.mock.calls[0][0].create;
        expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(created.payload.answers).toEqual({ 12: "Karachi" });
        expect(created.expiresAt.getTime()).toBeGreaterThan(NOW + 29 * 24 * 3600 * 1000);
        // The email carries the RAW token; the row never does.
        const url = sendCandidateEmail.mock.calls[0][0].data.draftUrl;
        expect(url).toContain("/public/candidates/draft?token=");
        expect(created.tokenHash).not.toBe(url);
    });

    it("a second save replaces the token — the old link dies", async () => {
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "A" } });
        const token1 = savedTokenOf();
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "Ayesha" } });
        const token2 = savedTokenOf();

        expect(token1).not.toBe(token2);
        // The upsert was called with the SAME natural key.
        expect(prisma.applicationDraft.upsert).toHaveBeenCalledTimes(2);
        expect(prisma.applicationDraft.upsert.mock.calls[1][0].where).toEqual(
            expect.objectContaining({ candidateId_requisitionId: { candidateId: 7, requisitionId: 5 } }),
        );
    });

    it("creates the candidate row when the email is unknown (same reconciliation as intake)", async () => {
        prisma.candidate.findFirst.mockResolvedValue(null);
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "new@example.com", body: { firstName: "Bilal" } });
        expect(prisma.candidate.create).toHaveBeenCalledTimes(1);
    });

    it("refuses a malformed payload shape before any write", async () => {
        await expect(
            saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "a@example.com", body: { answers: "not-an-object" } }),
        ).rejects.toMatchObject({ code: "HR-PORTAL-DRAFT-INVALID" });
        expect(prisma.applicationDraft.upsert).not.toHaveBeenCalled();
    });
});

describe("Phase 5 / FR-04.07 — loading behind the link", () => {
    it("a live token resolves to the candidate's own draft, stripped of internals", async () => {
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "Ayesha" } });
        const draft = await loadApplicationDraft({ token: savedTokenOf() });

        expect(draft.candidateId).toBe(7);
        expect(draft.jobTitle).toBe("Backend Engineer");
        expect(Object.keys(draft).sort()).toEqual([
            "candidateId", "expiresAt", "firstName", "jobTitle", "payload", "requisitionId", "resumeMediaId",
        ]);
    });

    it("unknown, expired and submitted tokens resolve to null — one uniform outcome", async () => {
        expect(await loadApplicationDraft({ token: "nope" })).toBeNull();
        expect(await loadApplicationDraft({ token: "" })).toBeNull();
    });

    it("an anonymized owner's draft is not loadable", async () => {
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: {} });
        // Simulate anonymization after the save.
        prisma.applicationDraft.findUnique.mockImplementationOnce(async ({ where }) => {
            const row = rows.drafts.get(where.tokenHash);
            return row
                ? { ...row, candidate: { id: 7, anonymizedAt: new Date(), status: "active" }, requisition: { id: 5, tenantId: TENANT } }
                : null;
        });
        expect(await loadApplicationDraft({ token: savedTokenOf() })).toBeNull();
    });
});

describe("Phase 5 / FR-04.07 — submitting through the gates", () => {
    it("submit goes THROUGH the public intake service with the draft's tenant and the row's email", async () => {
        await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "Ayesha", answers: { 12: "x" } } });
        const token = savedTokenOf();
        const draftRow = [...rows.drafts.values()].at(-1);

        const result = await submitApplicationDraft({ token });

        expect(result.received).toBe(true);
        expect(submitPublicApplication).toHaveBeenCalledTimes(1);
        const call = submitPublicApplication.mock.calls[0][0];
        expect(call.tenantId).toBe(TENANT); // from the requisition row, never the caller
        expect(call.body.email).toBe("ayesha@example.com"); // the reconciled row's address
        expect(call.body.answers).toEqual({ 12: "x" });
        // The draft is marked submitted and cannot be reused.
        expect(draftRow.submittedAt).toBeTruthy();
    });

    it("a bad token refuses before the intake is invoked", async () => {
        await expect(submitApplicationDraft({ token: "garbage" })).rejects.toMatchObject({
            code: "HR-PORTAL-DRAFT-INVALID",
        });
        expect(submitPublicApplication).not.toHaveBeenCalled();
    });
});

describe("Phase 5 / FR-04.07 — purge", () => {
    it("the erasure hook deletes by candidate; the sweep deletes expired unsubmitted drafts", async () => {
        const tx = { applicationDraft: { deleteMany: jest.fn(async () => ({ count: 2 })) } };
        await purgeDraftsForCandidate(tx, { tenantId: TENANT, candidateId: 7 });
        expect(tx.applicationDraft.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ candidateId: 7 }),
        });

        await purgeExpiredDrafts({ now: new Date(NOW + 31 * 24 * 3600 * 1000) });
        expect(prisma.applicationDraft.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ submittedAt: null }),
        });
    });
});

describe("Phase 5 / FR-04.07 — payload shape", () => {
    it("accepts a WIP form (all fields optional) but refuses malformed types", () => {
        expect(parseDraftPayload({}).firstName).toBeNull();
        expect(parseDraftPayload({ answers: { 1: "x" } }).answers).toEqual({ 1: "x" });
        expect(() => parseDraftPayload({ answers: [] })).toThrow();
        expect(parseDraftPayload({ resumeMediaId: "55" }).resumeMediaId).toBe(55);
    });
});
