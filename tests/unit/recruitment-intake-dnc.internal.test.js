// tests/unit/recruitment-intake-dnc.internal.test.js
//
// Recruitment Phase 2 / D-11 — the do-not-contact register on the RECRUITER
// intake paths, and the stage-change hook:
//
//   * createApplication / createCandidate refuse a register hit with 409
//     HR-RECRUITMENT-CANDIDATE-DNC, write nothing, and never echo the address;
//     a talent-pool move goes through createApplication, so it is covered too;
//   * the scope rule: SMS / PHONE / MARKETING entries do not block intake,
//     everything else (and anything unknown) does;
//   * createApplication stamps sourceChannel (RECRUITER, TALENT_POOL for a
//     pool move, or the caller's channel);
//   * a recruiter's manual stage move cancels the pending knockout disposition
//     in the same transaction.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const state = { dnc: null, candidate: { id: 5, email: "Ayesha@Example.com" } };

const requisition = { id: 4, tenantId: TENANT, status: "POSTED", postings: [{ channel: "CAREER_SITE", isActive: true }] };
const prisma = {
    jobRequisition: { findFirst: jest.fn(async () => requisition) },
    candidate: {
        findFirst: jest.fn(async () => state.candidate),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => ({ id: 6, ...data })),
    },
    candidateDncEntry: { findFirst: jest.fn(async () => state.dnc) },
    application: {
        create: jest.fn(async ({ data }) => ({ id: 30, ...data, jobRequisition: requisition, candidate: { id: data.candidateId } })),
        updateMany: jest.fn(async () => ({ count: 1 })),
    },
    applicationStageHistory: { create: jest.fn(async () => ({ id: 1 })) },
    tag: { upsert: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(prisma)),
};
const transitionApplicationStage = jest.fn(async () => ({ success: true, changed: true }));
const cancelPendingDispositionsForApplication = jest.fn(async () => 1);
const upsertTags = jest.fn(async () => []);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((c) => c),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage }));
jest.unstable_mockModule("../../src/services/scheduled-disposition.service.js", () => ({ cancelPendingDispositionsForApplication }));
jest.unstable_mockModule("../../src/services/tagService.js", () => ({ upsertTags }));

const { createApplication, updateApplicationStage, updateApplicationStatus } = await import("../../src/services/applicationService.js");
const { createCandidate } = await import("../../src/services/candidateService.js");
const { dncScopeBlocksIntake, checkIntakeDnc, hashEmailForLog } = await import("../../src/lib/intake-dnc.util.js");

const DNC = { id: 9, reasonCode: "CANDIDATE_REQUEST", scope: "ALL", status: "ACTIVE" };

beforeEach(() => {
    jest.clearAllMocks();
    state.dnc = null;
    state.candidate = { id: 5, email: "Ayesha@Example.com" };
});

describe("the intake DNC helper", () => {
    it("blocks on ALL, EMAIL, RECRUITMENT and unknown scopes; not on SMS / PHONE / MARKETING", () => {
        for (const scope of ["ALL", "EMAIL", "recruitment", "TENANT_CHANNEL", undefined, ""]) expect(dncScopeBlocksIntake(scope)).toBe(true);
        for (const scope of ["SMS", "phone", "MARKETING"]) expect(dncScopeBlocksIntake(scope)).toBe(false);
    });

    it("probes the normalized address and reports the reason code, never the address", async () => {
        state.dnc = DNC;
        const result = await checkIntakeDnc({ tenantId: TENANT, email: " Ayesha@Example.com ", tx: prisma });
        expect(result).toEqual({ blocked: true, reason: "CANDIDATE_REQUEST" });
        expect(prisma.candidateDncEntry.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, email: "ayesha@example.com" });
        expect(await checkIntakeDnc({ tenantId: TENANT, email: "" })).toEqual({ blocked: false, reason: null });
    });

    it("hashes per tenant, case-insensitively", () => {
        expect(hashEmailForLog(TENANT, "A@B.com")).toBe(hashEmailForLog(TENANT, " a@b.com"));
        expect(hashEmailForLog(TENANT, "a@b.com")).not.toBe(hashEmailForLog("other", "a@b.com"));
        expect(hashEmailForLog(TENANT, "a@b.com")).not.toContain("@");
    });
});

describe("createApplication (recruiter and talent-pool intake)", () => {
    it("refuses a candidate on the register with 409, writes nothing, and does not echo the address", async () => {
        state.dnc = DNC;
        const err = await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, createdById: 9 }).catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-CANDIDATE-DNC" });
        expect(err.message.toLowerCase()).not.toContain("ayesha");
        expect(prisma.application.create).not.toHaveBeenCalled();
        expect(prisma.candidate.findFirst.mock.calls[0][0].where).toEqual({ id: 5, tenantId: TENANT });
    });

    it("a talent-pool move is refused the same way", async () => {
        state.dnc = DNC;
        await expect(createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, source: "talent-pool" }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-CANDIDATE-DNC" });
    });

    it("a candidate of another tenant is not found", async () => {
        state.candidate = null;
        await expect(createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT }))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-CANDIDATE-NOT-FOUND" });
    });

    it("stamps the source channel: RECRUITER by default, TALENT_POOL for a pool move, else the caller's", async () => {
        await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT });
        await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, source: "talent-pool" });
        await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, sourceChannel: "referral", sourceDetail: " desk " });
        await createApplication({ candidateId: 5, jobRequisitionId: 4, tenantId: TENANT, sourceChannel: "fax" });
        const channels = prisma.application.create.mock.calls.map((c) => [c[0].data.sourceChannel, c[0].data.sourceDetail]);
        expect(channels).toEqual([["RECRUITER", null], ["TALENT_POOL", null], ["REFERRAL", "desk"], ["OTHER", null]]);
    });
});

describe("createCandidate (recruiter intake)", () => {
    it("refuses an address on the register before any write", async () => {
        state.dnc = DNC;
        const err = await createCandidate({ firstName: "A", email: "ayesha@example.com", tenantId: TENANT, tagNames: ["go"] }).catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-CANDIDATE-DNC" });
        expect(err.message).not.toContain("ayesha@example.com");
        expect(upsertTags).not.toHaveBeenCalled();
        expect(prisma.candidate.create).not.toHaveBeenCalled();
    });
});

describe("the manual stage-change hook", () => {
    it("a recruiter's stage move cancels the pending disposition in the same transaction", async () => {
        await updateApplicationStage({ id: 30, tenantId: TENANT, stage: "screening", updatedById: 7 });
        expect(transitionApplicationStage).toHaveBeenCalledWith(expect.objectContaining({ id: 30, targetStage: "screening", db: prisma }));
        expect(cancelPendingDispositionsForApplication).toHaveBeenCalledWith(prisma, { tenantId: TENANT, applicationId: 30, actorId: 7 });
    });

    it("a no-op move cancels nothing", async () => {
        transitionApplicationStage.mockResolvedValueOnce({ success: true, changed: false });
        await updateApplicationStage({ id: 30, tenantId: TENANT, stage: "applied", updatedById: 7 });
        expect(cancelPendingDispositionsForApplication).not.toHaveBeenCalled();
    });

    it("a status-driven rejection cancels it too", async () => {
        await updateApplicationStatus({ id: 30, tenantId: TENANT, status: "rejected", reason: "fit", updatedById: 7 });
        expect(cancelPendingDispositionsForApplication).toHaveBeenCalledWith(prisma, { tenantId: TENANT, applicationId: 30, actorId: 7 });
    });
});
