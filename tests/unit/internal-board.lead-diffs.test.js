// Recruitment Phase 5 stream B — the hooks in files stream B does not own:
// the careers portal ignores INTERNAL postings, an anonymous applicant cannot
// claim the INTERNAL channel, and createApplicationInTx composes into the
// caller's transaction with applicantEmployeeId.
import { jest, describe, it, expect } from "@jest/globals";

const assertIntakeAllowed = jest.fn(async () => ({ blocked: false }));
const enqueueHrDomainEvent = jest.fn(async () => null);
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../src/services/intake-dnc.service.js", () => ({
    assertIntakeAllowed,
    normalizeSourceChannel: (v, f) => (v ? String(v).toUpperCase() : f),
    normalizeSourceDetail: (v) => v ?? null,
    checkIntakeDnc: jest.fn(),
    logIntakeSuppressed: jest.fn(),
}));

const { toPublicJob, PUBLIC_JOB_SELECT } = await import("../../src/lib/public-portal.util.js");
const { createApplicationInTx } = await import("../../src/services/application.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T09:00:00Z");
const posting = (channel) => ({ channel, externalUrl: null, isActive: true, closedAt: null });

describe("careers portal", () => {
    it("selects only public postings and treats an INTERNAL-only job as closed", () => {
        expect(PUBLIC_JOB_SELECT.postings.where.channel.in).not.toContain("INTERNAL");
        const internalOnly = toPublicJob({ id: 1, title: "T", status: "POSTED", postings: [posting("INTERNAL")] }, { now: NOW });
        expect(internalOnly.eligible).toBe(false);
        expect(internalOnly.channels).toEqual([]);
        const both = toPublicJob({ id: 2, title: "T", status: "POSTED", postings: [posting("INTERNAL"), posting("CAREER_SITE")] }, { now: NOW });
        expect(both.eligible).toBe(true);
        expect(both.channels.map((c) => c.channel)).toEqual(["CAREER_SITE"]);
    });

    it("does not let an anonymous applicant claim the INTERNAL channel", async () => {
        const { parseSourceAttribution } = await import("../../src/services/public-portal.service.js");
        expect(parseSourceAttribution({ sourceChannel: "INTERNAL" }).sourceChannel).toBe("CAREER_SITE");
        expect(parseSourceAttribution({ sourceChannel: "INDEED" }).sourceChannel).toBe("INDEED");
    });
});

describe("createApplicationInTx", () => {
    it("writes on the caller's client with applicantEmployeeId and the posting", async () => {
        const created = [];
        const tx = {
            jobRequisition: { findFirst: async () => ({ id: 5, status: "POSTED", tenantId: TENANT, postings: [posting("INTERNAL")] }) },
            candidate: { findFirst: async () => ({ id: 9, email: "a@b.test" }) },
            application: { create: async ({ data }) => { created.push(data); return { id: 77, tenantId: TENANT, ...data }; } },
            applicationStageHistory: { create: async () => ({}) },
        };
        const app = await createApplicationInTx(tx, { candidateId: 9, jobRequisitionId: 5, tenantId: TENANT, createdById: 3, source: "internal-board", sourceChannel: "INTERNAL", sourcePostingId: 12, applicantEmployeeId: 3 });
        expect(app.id).toBe(77);
        expect(created[0]).toMatchObject({ sourceChannel: "INTERNAL", applicantEmployeeId: 3, sourcePostingId: 12, stage: "applied" });
        expect(enqueueHrDomainEvent).toHaveBeenCalledWith(tx, expect.objectContaining({ eventName: "hr.recruitment.application_created.v1" }));
        await expect(createApplicationInTx(tx, { candidateId: 9, jobRequisitionId: 5 })).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    });
});
