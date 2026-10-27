// tests/unit/services/offer-decline.service.test.js
//
// Recruitment Phase 3a — decline capture on respondOffer.
//
// Pinned: a legacy decline with no reason still succeeds and reports the reason
// as not recorded; a note alone is OTHER; bad input is refused before any
// write; acceptance ignores the decline fields entirely; the declined event
// carries the code and never the note; the talent pool opt-in adds the
// candidate (idempotently) only when consent and do-not-contact allow it, and a
// failed add never undoes the decline.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const sentOffer = { id: 9, status: "SENT", applicationId: 3, candidateId: 5, jobRequisitionId: 4, createdById: 12, version: 2, tenantId: TENANT };

const OUTBOX = [];
const prisma = {
    offer: { findFirst: jest.fn(), update: jest.fn() },
    candidate: { findFirst: jest.fn() },
    candidateConsent: { findFirst: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    businessUnit: { findFirst: jest.fn() },
    talentPool: { findFirst: jest.fn() },
    outboxEvent: { create: jest.fn(async ({ data }) => { OUTBOX.push(data); return data; }) },
    $queryRaw: jest.fn(async () => [{ id: 9 }]),
};
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
const addToPool = jest.fn(async ({ candidateId, poolName }) => ({ id: 77, candidateId, poolName }));
const mockRunOfferHandoff = jest.fn(async () => ({ handoff: { id: 1, status: "COMPLETED" } }));
const mockTransition = jest.fn(async () => ({ success: true }));

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (_client, fn) => await fn(prisma)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM: jest.fn(), deleteDamAsset: jest.fn() }));
jest.unstable_mockModule("../../../src/services/application-workflow.service.js", () => ({
    transitionApplicationStageInTransaction: mockTransition,
    transitionApplicationStage: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/recruitment-handoff.service.js", () => ({
    runOfferHandoff: mockRunOfferHandoff,
    getOfferHandoff: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/services/talent-pool.service.js", () => ({ addToPool }));

const { respondOffer, OFFER_DECLINED_EVENT } = await import("../../../src/services/offer.service.js");

const updateData = () => prisma.offer.update.mock.calls[0][0].data;
const declinedEvents = () => OUTBOX.filter((o) => o.eventName === OFFER_DECLINED_EVENT);

beforeEach(() => {
    jest.clearAllMocks();
    OUTBOX.length = 0;
    prisma.offer.findFirst.mockResolvedValue({ ...sentOffer });
    prisma.offer.update.mockImplementation(async ({ data }) => ({ ...sentOffer, ...data }));
    prisma.candidate.findFirst.mockResolvedValue({ id: 5, anonymizedAt: null });
    prisma.candidateConsent.findFirst.mockResolvedValue(null);
    prisma.jobRequisition.findFirst.mockResolvedValue({ title: "Backend Engineer", departmentId: 40 });
    prisma.businessUnit.findFirst.mockResolvedValue({ name: "Engineering" });
    prisma.talentPool.findFirst.mockResolvedValue(null);
    assertCommunicationsAllowed.mockResolvedValue({ allowed: true });
});

describe("respondOffer decline — existing callers", () => {
    it("declines with no reason, records nothing and reports NOT_RECORDED", async () => {
        const result = await respondOffer(9, false, TENANT);
        expect(result).toMatchObject({ handoff: null, replayed: false, declineReason: "NOT_RECORDED", talentPool: null });
        expect(updateData()).toMatchObject({ status: "DECLINED", declineReasonCode: null, declineNote: null, talentPoolOptIn: null });
        expect(mockTransition).not.toHaveBeenCalled();
        expect(mockRunOfferHandoff).not.toHaveBeenCalled();
        expect(addToPool).not.toHaveBeenCalled();
    });

    it("emits the declined event with the code and the recruiter, never the note", async () => {
        await respondOffer(9, false, TENANT, { actorId: 12, declineReasonCode: "COMPENSATION", declineNote: "wants 20% more, private detail" });
        const [evt] = declinedEvents();
        expect(evt.payload.payload).toEqual({
            offerId: "9",
            applicationId: "3",
            candidateId: "5",
            jobRequisitionId: "4",
            status: "DECLINED",
            version: 2,
            declineReasonCode: "COMPENSATION",
            createdById: "12",
        });
        expect(JSON.stringify(evt)).not.toContain("private detail");
    });

    it("stores a note without a code as OTHER", async () => {
        const result = await respondOffer(9, false, TENANT, { declineNote: "Relocating" });
        expect(updateData()).toMatchObject({ declineReasonCode: "OTHER", declineNote: "Relocating" });
        expect(result.declineReason).toBe("OTHER");
    });

    it("refuses bad decline input before any write", async () => {
        for (const ctx of [
            { declineReasonCode: "BORED" },
            { declineReasonCode: "OTHER" },
            { declineReasonCode: "TIMING", declineNote: "x".repeat(1001) },
            { talentPoolOptIn: "yes" },
            { requireDeclineReason: true },
        ]) {
            await expect(respondOffer(9, false, TENANT, ctx)).rejects.toMatchObject({ status: 400 });
        }
        expect(prisma.offer.update).not.toHaveBeenCalled();
        expect(OUTBOX).toHaveLength(0);
    });

    it("leaves acceptance untouched: decline fields are ignored, not validated", async () => {
        prisma.offer.update.mockImplementation(async ({ data }) => ({ ...sentOffer, ...data }));
        const result = await respondOffer(9, true, TENANT, { employeeCategory: "EMPLOYEE", declineReasonCode: "BORED", talentPoolOptIn: true });
        expect(updateData()).toEqual(expect.objectContaining({ status: "ACCEPTED", employeeCategory: "EMPLOYEE" }));
        expect(updateData()).not.toHaveProperty("declineReasonCode");
        expect(result).not.toHaveProperty("declineReason");
        expect(result).not.toHaveProperty("talentPool");
        expect(mockRunOfferHandoff).toHaveBeenCalledTimes(1);
        expect(declinedEvents()).toHaveLength(0);
        expect(addToPool).not.toHaveBeenCalled();
    });

    it("replays a repeated decline without a second event or pool add", async () => {
        prisma.offer.findFirst.mockResolvedValue({ ...sentOffer, status: "DECLINED", declineReasonCode: "TIMING", talentPoolOptIn: true });
        const result = await respondOffer(9, false, TENANT, { declineReasonCode: "LOCATION", talentPoolOptIn: true });
        expect(result).toMatchObject({ replayed: true, declineReason: "TIMING", talentPool: null });
        expect(prisma.offer.update).not.toHaveBeenCalled();
        expect(declinedEvents()).toHaveLength(0);
        expect(addToPool).not.toHaveBeenCalled();
    });
});

describe("respondOffer decline — talent pool opt-in", () => {
    const decline = (ctx = {}) => respondOffer(9, false, TENANT, { actorId: 12, declineReasonCode: "TIMING", talentPoolOptIn: true, ...ctx });

    it("adds the candidate to the department's pool with source offer_declined", async () => {
        const result = await decline();
        expect(addToPool).toHaveBeenCalledWith({
            candidateId: 5,
            poolName: "Engineering",
            notes: "Source: offer_declined (offer #9)",
            addedById: 12,
            tenantId: TENANT,
        });
        expect(result.talentPool).toEqual({ added: true, poolName: "Engineering", entryId: 77, source: "offer_declined" });
        expect(assertCommunicationsAllowed).toHaveBeenCalledWith({ tenantId: TENANT, candidateId: 5, purpose: "TALENT_POOL" });
    });

    it("falls back to the requisition title when it has no department", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ title: "Backend Engineer", departmentId: null });
        expect((await decline()).talentPool.poolName).toBe("Backend Engineer");
    });

    it("does not add when the candidate did not opt in", async () => {
        const result = await decline({ talentPoolOptIn: false });
        expect(result.talentPool).toBeNull();
        expect(updateData().talentPoolOptIn).toBe(false);
        expect(addToPool).not.toHaveBeenCalled();
    });

    it("never adds while a do-not-contact entry is active or consent is withdrawn", async () => {
        assertCommunicationsAllowed.mockRejectedValueOnce(Object.assign(new Error("dnc"), { code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        expect((await decline()).talentPool).toEqual({ added: false, reason: "DNC_ACTIVE" });

        assertCommunicationsAllowed.mockRejectedValueOnce(Object.assign(new Error("consent"), { code: "HR-RECRUITMENT-CONSENT-WITHDRAWN" }));
        prisma.offer.update.mockClear();
        expect((await decline()).talentPool).toEqual({ added: false, reason: "CONSENT_WITHDRAWN" });

        prisma.candidateConsent.findFirst.mockResolvedValueOnce({ status: "WITHDRAWN" });
        expect((await decline()).talentPool).toEqual({ added: false, reason: "TALENT_POOL_CONSENT_WITHDRAWN" });

        prisma.candidate.findFirst.mockResolvedValueOnce({ id: 5, anonymizedAt: new Date() });
        expect((await decline()).talentPool).toEqual({ added: false, reason: "CANDIDATE_UNAVAILABLE" });
        expect(addToPool).not.toHaveBeenCalled();
    });

    it("is idempotent: an existing membership or a lost unique race is reported, not duplicated", async () => {
        prisma.talentPool.findFirst.mockResolvedValueOnce({ id: 55 });
        expect((await decline()).talentPool).toEqual({ added: false, reason: "ALREADY_IN_POOL", poolName: "Engineering", entryId: 55 });
        expect(addToPool).not.toHaveBeenCalled();

        addToPool.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
        expect((await decline()).talentPool).toEqual({ added: false, reason: "ALREADY_IN_POOL", poolName: "Engineering" });
    });

    it("keeps the decline when the pool add fails", async () => {
        addToPool.mockRejectedValueOnce(new Error("db down"));
        const result = await decline();
        expect(result.offer.status).toBe("DECLINED");
        expect(result.talentPool).toEqual({ added: false, reason: "FAILED", poolName: "Engineering" });
        expect(declinedEvents()).toHaveLength(1);
    });
});
