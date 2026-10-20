// Recruitment Phase 6 — a candidate merge carries agency ownership: the
// earliest LIVE claim survives, a merge never drops or extends one, and two
// live claims from different agencies keep the target's with an audit note.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(NOW.getTime() + n * DAY);

const rows = new Map();
const updateCalls = [];
const prisma = {
    candidate: {
        findFirst: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }) => {
            updateCalls.push({ id: where.id, data });
            return rows.get(where.id);
        }),
    },
    candidateLegalHold: { findMany: jest.fn(async () => []) },
    application: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateConsent: { updateMany: jest.fn(async () => ({ count: 0 })) },
    talentPool: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateSkill: { updateMany: jest.fn(async () => ({ count: 0 })) },
    aiInferenceRecord: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateEmailVerification: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateTag: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 0 })) },
};
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn((client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const { mergeCandidates, mergedAgencyOwnership } = await import("../../../src/services/candidateMerge.service.js");

const seed = (source = {}, target = {}) => {
    rows.clear();
    updateCalls.length = 0;
    const base = { status: "active", anonymizedAt: null, tenantId: TENANT, version: 0, notes: null, phone: null, resumeMediaId: null, source: null };
    rows.set(1, { id: 1, email: "typo@example.com", ...base, ...source });
    rows.set(2, { id: 2, email: "right@example.com", ...base, ...target });
};
const merge = () => mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, actorId: 9, now: NOW });
const survivorData = () => updateCalls.find((u) => u.id === 2).data;

beforeEach(() => {
    jest.clearAllMocks();
    seed();
});

describe("mergedAgencyOwnership (pure)", () => {
    const owned = (agency, days) => ({ ownerAgencyId: agency, ownershipExpiresAt: inDays(days) });

    it("leaves the target alone when the source has no live claim", () => {
        expect(mergedAgencyOwnership({}, owned(5, 10), NOW)).toEqual({ data: null, conflict: null });
        expect(mergedAgencyOwnership(owned(5, -1), {}, NOW)).toEqual({ data: null, conflict: null });
    });

    it("carries the source's live claim onto a target with none (or an expired one)", () => {
        const out = mergedAgencyOwnership(owned(5, 10), owned(6, -3), NOW);
        expect(out).toEqual({ data: { ownerAgencyId: 5, ownershipExpiresAt: inDays(10) }, conflict: null });
    });

    it("keeps the earliest window when the same agency owns both", () => {
        expect(mergedAgencyOwnership(owned(5, 10), owned(5, 40), NOW).data).toEqual({ ownerAgencyId: 5, ownershipExpiresAt: inDays(10) });
        expect(mergedAgencyOwnership(owned(5, 40), owned(5, 10), NOW).data).toBeNull();
    });

    it("keeps the target's claim on a conflict between two live agencies", () => {
        expect(mergedAgencyOwnership(owned(5, 10), owned(6, 40), NOW)).toEqual({
            data: null,
            conflict: { keptAgencyId: 6, keptUntil: inDays(40), droppedAgencyId: 5, droppedUntil: inDays(10) },
        });
    });
});

describe("mergeCandidates", () => {
    it("moves the source's live ownership onto the survivor", async () => {
        seed({ ownerAgencyId: 5, ownershipExpiresAt: inDays(20) });
        const result = await merge();
        expect(survivorData()).toMatchObject({ ownerAgencyId: 5, ownershipExpiresAt: inDays(20) });
        expect(result.agencyOwnership).toEqual({ ownerAgencyId: 5, ownershipExpiresAt: inDays(20), from: "source" });
        expect(logAction).toHaveBeenCalledTimes(1);
    });

    it("does not touch the survivor's columns when nothing live comes from the source", async () => {
        seed({ ownerAgencyId: 5, ownershipExpiresAt: inDays(-1) }, { ownerAgencyId: 6, ownershipExpiresAt: inDays(5) });
        const result = await merge();
        expect(survivorData()).not.toHaveProperty("ownerAgencyId");
        expect(survivorData()).not.toHaveProperty("ownershipExpiresAt");
        expect(result.agencyOwnership).toBeNull();
    });

    it("keeps the target's claim on a conflict and writes an audit note with ids only", async () => {
        seed({ ownerAgencyId: 5, ownershipExpiresAt: inDays(10) }, { ownerAgencyId: 6, ownershipExpiresAt: inDays(40) });
        const result = await merge();
        expect(survivorData()).not.toHaveProperty("ownerAgencyId");
        expect(result.agencyOwnership).toMatchObject({ ownerAgencyId: 6, from: "target", conflict: true });
        const notes = logAction.mock.calls.map(([entry]) => entry.notes);
        const conflictNote = notes.find((n) => /ownership conflict/.test(n));
        expect(conflictNote).toContain("kept agency 6");
        expect(conflictNote).toContain("dropped agency 5");
        expect(conflictNote).not.toMatch(/example\.com/);
        expect(logAction.mock.calls.every(([entry]) => entry.tenantId === TENANT)).toBe(true);
    });
});
