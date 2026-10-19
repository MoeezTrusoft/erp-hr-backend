// tests/unit/staleVersionGuard.test.js
//
// Phase 14 — the plan's named "stale versions" negative path.
//
// The optimistic-concurrency guard (API-2) is opt-in: absent expectedVersion ⇒
// no reject (legacy callers keep working). When SUPPLIED, a writer whose view
// has gone stale must be refused with HR-4120 and the row's CURRENT version
// attached, so the client can re-read and retry instead of silently clobbering
// a concurrent editor's change.
//
// Covered writers: offers (the payroll-facing compensation edit) and
// candidates (the recruitment master record). Both share the same
// compare-and-set shape; testing both proves the pattern, not one copy.
//
// What "stale" means here, precisely: updateMany WHERE ... version = expected
// matched 0 rows AND a re-read found the row alive at a different version.
// (0 rows because the row is GONE must surface as the caller's 404/not-found —
// assertOfferInTenant / the caller's existence check — not as a 412.)

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    $transaction: (fn) => fn(prisma), // tenantTransaction just runs the callback with the same client in tests
    offer: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
    },
    candidate: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { updateOffer } = await import("../../src/services/offer.service.js");
const { updateCandidate } = await import("../../src/services/candidateService.js");

const TENANT = "t-1";

beforeEach(() => {
    jest.clearAllMocks();
});

describe("offer update — stale version guard (Phase 14)", () => {
    it("a stale expectedVersion is refused with 412 / HR-4120 and the CURRENT version", async () => {
        // The guard: WHERE version = 3 matches nothing (row is at 7 now).
        prisma.offer.updateMany.mockResolvedValue({ count: 0 });
        // The re-read for the error body: the row is alive at version 7.
        prisma.offer.findFirst
            .mockResolvedValueOnce({ id: 5, version: 7 }) // assertOfferInTenant existence check
            .mockResolvedValueOnce({ version: 7 }); // the 412 body's fresh read

        await expect(updateOffer(5, { notes: "bump", expectedVersion: 3 }, TENANT)).rejects.toMatchObject({
            status: 412,
            code: "HR-4120",
            currentVersion: 7,
        });

        // The compare-and-set actually gated on the caller's version.
        expect(prisma.offer.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ version: 3, tenantId: TENANT }),
                data: expect.objectContaining({ version: { increment: 1 } }),
            }),
        );
    });

    it("a matching expectedVersion applies the write and bumps the version", async () => {
        prisma.offer.updateMany.mockResolvedValue({ count: 1 });
        prisma.offer.findFirst
            .mockResolvedValueOnce({ id: 5, version: 3 }) // existence check
            .mockResolvedValueOnce({ id: 5, version: 4, notes: "bump" }); // the return read

        const updated = await updateOffer(5, { notes: "bump", expectedVersion: 3 }, TENANT);
        expect(updated.version).toBe(4);
        expect(prisma.offer.updateMany.mock.calls[0][0].where.version).toBe(3);
    });

    it("absent expectedVersion keeps the legacy no-guard behaviour (opt-in)", async () => {
        prisma.offer.updateMany.mockResolvedValue({ count: 1 });
        prisma.offer.findFirst
            .mockResolvedValueOnce({ id: 5, version: 3 })
            .mockResolvedValueOnce({ id: 5, version: 4 });

        await updateOffer(5, { notes: "no guard" }, TENANT);
        // No version clause in the WHERE — the write is unconditional.
        expect(prisma.offer.updateMany.mock.calls[0][0].where.version).toBeUndefined();
    });
});

describe("candidate update — stale version guard (Phase 14)", () => {
    it("a stale expectedVersion is refused with 412 / HR-4120 and the CURRENT version", async () => {
        prisma.candidate.updateMany.mockResolvedValue({ count: 0 });
        prisma.candidate.findFirst.mockResolvedValueOnce({ version: 9 });

        await expect(
            updateCandidate({ id: 11, tenantId: TENANT, data: { notes: "stale" }, expectedVersion: 4 }),
        ).rejects.toMatchObject({
            status: 412,
            code: "HR-4120",
            currentVersion: 9,
        });

        expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 11, tenantId: TENANT, version: 4 }),
            }),
        );
    });

    it("a matching expectedVersion applies the write inside the tenant transaction", async () => {
        prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
        prisma.candidate.findFirst.mockResolvedValue({ id: 11, version: 9 }); // the post-write read

        await updateCandidate({ id: 11, tenantId: TENANT, data: { notes: "fresh" }, expectedVersion: 8 });
        expect(prisma.candidate.updateMany.mock.calls[0][0].where.version).toBe(8);
    });

    it("a non-numeric expectedVersion is treated as absent (no guard), never as 0", async () => {
        prisma.candidate.updateMany.mockResolvedValue({ count: 1 });

        await updateCandidate({ id: 11, tenantId: TENANT, data: {}, expectedVersion: "garbage" });
        expect(prisma.candidate.updateMany.mock.calls[0][0].where.version).toBeUndefined();
    });
});
