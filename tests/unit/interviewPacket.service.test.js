// tests/unit/interviewPacket.service.test.js
//
// Phase 6 / decision record §4.4 — the interview packet service:
//
//   * only matrix-PERMITTED classes can be packeted; everything else refuses
//     at the write boundary (HR-RECRUITMENT-PACKET-CLASS-NOT-PACKETABLE)
//   * re-adding the same media to the same interview is idempotent
//     (label refresh, alreadyListed flag)
//   * remove is tenant-conditioned; unknown or cross-tenant ids are clean 404s
//   * the interviewer view is FAIL-CLOSED on the assignment: no
//     InterviewInterviewer row → empty view; an assigned interviewer gets the
//     resume from the candidate record plus packeted portfolio/docs
//   * denials are audit-logged by CLASS only, never content
//   * unknown interview → 404 (indistinguishable from another tenant's)

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    interview: { findFirst: jest.fn() },
    interviewInterviewer: { findFirst: jest.fn() },
    interviewPacketItem: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: (client, fn) => fn(client),
}));

const service = await import("../../src/services/interviewPacket.service.js");

const tenant = "t-1";

const interviewRow = (overrides = {}) => ({
    id: 500,
    tenantId: tenant,
    applicationId: 900,
    application: {
        id: 900,
        candidateId: 77,
        candidate: { id: 77, resumeMediaId: 4040 },
    },
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    logAction.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
});

// ── packet writes ────────────────────────────────────────────────────────────

describe("interviewPacket.addPacketItem", () => {
    it("adds a packetable document and audits the write", async () => {
        prisma.interview.findFirst.mockResolvedValue({ id: 500 });
        prisma.interviewPacketItem.findUnique.mockResolvedValue(null);
        prisma.interviewPacketItem.create.mockResolvedValue({ id: 9, docClass: "PORTFOLIO", mediaId: 11 });

        const { item, alreadyListed } = await service.addPacketItem({
            interviewId: 500,
            docClass: "PORTFOLIO",
            mediaId: 11,
            label: "Design portfolio",
            tenantId: tenant,
            actorId: 12,
        });

        expect(alreadyListed).toBe(false);
        expect(item.id).toBe(9);
        expect(prisma.interviewPacketItem.create).toHaveBeenCalledTimes(1);
        expect(logAction).toHaveBeenCalledTimes(1);
        expect(logAction.mock.calls[0][0].module).toBe("Interview Packet");
    });

    it("REFUSES a class the matrix never permits in a packet — screening notes", async () => {
        await expect(
            service.addPacketItem({ interviewId: 500, docClass: "SCREENING_NOTES", mediaId: 11, tenantId: tenant }),
        ).rejects.toMatchObject({
            status: 400,
            details: { code: "HR-RECRUITMENT-PACKET-CLASS-NOT-PACKETABLE" },
        });
        expect(prisma.interviewPacketItem.create).not.toHaveBeenCalled();
    });

    it.each(["INTERVIEW_FEEDBACK", "BUDGET_APPROVAL", "OFFER_APPROVAL", "OFFER_LETTER", "MADE_UP"])(
        "refuses %s at the write boundary",
        async (cls) => {
            await expect(
                service.addPacketItem({ interviewId: 500, docClass: cls, mediaId: 11, tenantId: tenant }),
            ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-PACKET-CLASS-NOT-PACKETABLE" } });
        },
    );

    it("is idempotent per (interview, media): refreshes the label and reports alreadyListed", async () => {
        prisma.interview.findFirst.mockResolvedValue({ id: 500 });
        prisma.interviewPacketItem.findUnique.mockResolvedValue({ id: 9, label: "old", docClass: "PORTFOLIO" });
        prisma.interviewPacketItem.update.mockResolvedValue({ id: 9, label: "new" });

        const { alreadyListed } = await service.addPacketItem({
            interviewId: 500,
            docClass: "PORTFOLIO",
            mediaId: 11,
            label: "new",
            tenantId: tenant,
        });

        expect(alreadyListed).toBe(true);
        expect(prisma.interviewPacketItem.create).not.toHaveBeenCalled();
        expect(prisma.interviewPacketItem.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 9 } }),
        );
    });

    it("404s for an unknown interview without touching the item tables", async () => {
        prisma.interview.findFirst.mockResolvedValue(null);
        await expect(
            service.addPacketItem({ interviewId: 9999, docClass: "PORTFOLIO", mediaId: 11, tenantId: tenant }),
        ).rejects.toMatchObject({ status: 404, details: "HR-RECRUITMENT-PACKET-NOT-FOUND" });
        expect(prisma.interviewPacketItem.findUnique).not.toHaveBeenCalled();
    });

    it("requires a positive integer mediaId", async () => {
        await expect(
            service.addPacketItem({ interviewId: 500, docClass: "PORTFOLIO", mediaId: "abc", tenantId: tenant }),
        ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-PACKET-MEDIA-REQUIRED" } });
    });
});

describe("interviewPacket.removePacketItem", () => {
    it("removes an existing item conditioned on tenant + interview", async () => {
        prisma.interviewPacketItem.findFirst.mockResolvedValue({ id: 9 });
        prisma.interviewPacketItem.deleteMany.mockResolvedValue({ count: 1 });

        const row = await service.removePacketItem({ interviewId: 500, itemId: 9, tenantId: tenant, actorId: 12 });
        expect(row).toEqual({ id: 9, deleted: true });
        expect(prisma.interviewPacketItem.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: 9, interviewId: 500 }),
        });
    });

    it("404s cleanly on an unknown or cross-tenant id", async () => {
        prisma.interviewPacketItem.findFirst.mockResolvedValue(null);
        await expect(
            service.removePacketItem({ interviewId: 500, itemId: 404, tenantId: tenant }),
        ).rejects.toMatchObject({ status: 404, details: "HR-RECRUITMENT-PACKET-NOT-FOUND" });
        expect(prisma.interviewPacketItem.deleteMany).not.toHaveBeenCalled();
    });
});

// ── the §4.4 interviewer view ────────────────────────────────────────────────

describe("interviewPacket.getPacketForViewer (§4.4)", () => {
    const packetRows = [
        { id: 1, docClass: "PORTFOLIO", mediaId: 11, label: "Portfolio" },
        { id: 2, docClass: "GENERAL_APPLICATION_DOC", mediaId: 12, label: "Transcript" },
    ];

    it("gives an ASSIGNED interviewer the resume plus the full packet", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interviewInterviewer.findFirst.mockResolvedValue({ employeeId: 12 });
        prisma.interviewPacketItem.findMany.mockResolvedValue(packetRows);

        const view = await service.getPacketForViewer({ interviewId: 500, tenantId: tenant, viewerEmployeeId: 12 });

        expect(view.viewer).toEqual({ employeeId: 12, isAssignedInterviewer: true });
        // The resume composes from the candidate record — no packet row needed.
        const resume = view.items.find((i) => i.docClass === "RESUME");
        expect(resume).toMatchObject({ mediaId: 4040, source: "CANDIDATE_RECORD" });
        expect(view.items.filter((i) => i.source === "PACKET")).toHaveLength(2);
        expect(view.deniedClasses).toEqual([]);
    });

    it("gives an UNASSIGNED interviewer an EMPTY view — fail closed", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interviewInterviewer.findFirst.mockResolvedValue(null);
        prisma.interviewPacketItem.findMany.mockResolvedValue(packetRows);

        const view = await service.getPacketForViewer({ interviewId: 500, tenantId: tenant, viewerEmployeeId: 13 });

        expect(view.viewer.isAssignedInterviewer).toBe(false);
        expect(view.items).toEqual([]);
        expect(view.deniedClasses).toEqual(["GENERAL_APPLICATION_DOC", "PORTFOLIO"]);
        expect(logAction).not.toHaveBeenCalled(); // no denial audit for an empty assignment anyway
    });

    it("404s for an unknown or cross-tenant interview", async () => {
        prisma.interview.findFirst.mockResolvedValue(null);
        await expect(
            service.getPacketForViewer({ interviewId: 404, tenantId: tenant, viewerEmployeeId: 12 }),
        ).rejects.toMatchObject({ status: 404, details: "HR-RECRUITMENT-PACKET-NOT-FOUND" });
    });

    it("omits the resume when the candidate record has none", async () => {
        prisma.interview.findFirst.mockResolvedValue(
            interviewRow({ application: { id: 900, candidateId: 77, candidate: { id: 77, resumeMediaId: null } } }),
        );
        prisma.interviewInterviewer.findFirst.mockResolvedValue({ employeeId: 12 });
        prisma.interviewPacketItem.findMany.mockResolvedValue([]);

        const view = await service.getPacketForViewer({ interviewId: 500, tenantId: tenant, viewerEmployeeId: 12 });
        expect(view.items.some((i) => i.docClass === "RESUME")).toBe(false);
    });
});
