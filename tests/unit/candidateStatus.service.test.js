// tests/unit/candidateStatus.service.test.js
//
// Phase 5 / §3.5a — the self-service status service. The assertions that
// matter are the ones the internet will find:
//
//   * the LINK REQUEST is uniform — a known address and an unknown address
//     return the SAME body, and only the real candidate's mailbox gets a link;
//   * the link is a live, NON-consuming STATUS_LINK row (a §3.2-style token
//     with its own purpose), re-issuable, 180d;
//   * the READ returns the candidate-visible projection only, and the route's
//     empty-body contract means null-vs-empty never differ on the wire;
//   * every send is fail-soft — a hub outage never fails a link request.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";

const prisma = {
    candidate: { findFirst: jest.fn() },
    // Phase 2 / D-11 — a link request probes the do-not-contact register.
    candidateDncEntry: { findFirst: jest.fn(async () => null) },
    application: { findMany: jest.fn(async () => []) },
    candidateEmailVerification: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    },
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

const { sendCandidateEmail } = await import("../../src/lib/notificationClient.js");
const { requestStatusLink, readStatusViaLink } = await import("../../src/services/candidateStatus.service.js");
const { projectCandidateStatusList } = await import("../../src/lib/candidateStatusView.js");

beforeEach(() => {
    jest.clearAllMocks();
    prisma.candidate.findFirst.mockResolvedValue(null);
});

describe("Phase 5 / §3.5a — the status-link request", () => {
    it("issues a STATUS_LINK token for a real candidate and mails it", async () => {
        prisma.candidate.findFirst.mockResolvedValue({ id: 7, firstName: "Ayesha", email: "ayesha@example.com" });

        const result = await requestStatusLink({ tenantId: TENANT, email: "ayesha@example.com" });

        expect(result).toEqual({ accepted: true });
        const created = prisma.candidateEmailVerification.create.mock.calls[0][0].data;
        expect(created.purpose).toBe("STATUS_LINK");
        expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        // 180 days, not the 24h verification window.
        expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now() + 1000 * 60 * 60 * 24 * 170);
        // The previous live link was replaced.
        expect(prisma.candidateEmailVerification.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ purpose: "STATUS_LINK", consumedAt: null }),
            }),
        );
        expect(sendCandidateEmail).toHaveBeenCalledTimes(1);
        expect(sendCandidateEmail.mock.calls[0][0].templateId).toBe("hr.recruitment.portal_status_link");
    });

    it("an unknown address gets the SAME response and NO email — no oracle", async () => {
        const result = await requestStatusLink({ tenantId: TENANT, email: "nobody@example.com" });

        expect(result).toEqual({ accepted: true });
        expect(prisma.candidateEmailVerification.create).not.toHaveBeenCalled();
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("a hub outage never fails the request (fail-soft)", async () => {
        prisma.candidate.findFirst.mockResolvedValue({ id: 7, firstName: "A", email: "a@example.com" });
        sendCandidateEmail.mockResolvedValueOnce({ sent: false, reason: "hub-unreachable" });

        const result = await requestStatusLink({ tenantId: TENANT, email: "a@example.com" });
        expect(result).toEqual({ accepted: true });
    });

    it("refuses a malformed address before any lookup", async () => {
        await expect(requestStatusLink({ tenantId: TENANT, email: "not-an-email" })).rejects.toMatchObject({
            status: 400,
            code: "HR-PORTAL-STATUS-EMAIL-INVALID",
        });
        expect(prisma.candidate.findFirst).not.toHaveBeenCalled();
    });
});

describe("Phase 5 / §3.5a — reading statuses behind the link", () => {
    it("a live link returns the candidate-visible projection", async () => {
        // resolveStatusLink reads the token row through the verification service.
        const crypto = await import("node:crypto");
        const raw = "status-link-token";
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        prisma.candidateEmailVerification.findUnique = jest.fn(async ({ where }) =>
            where.tokenHash === hash
                ? { id: 5, candidateId: 7, purpose: "STATUS_LINK", consumedAt: null, expiresAt: new Date(Date.now() + 60_000), email: "a@example.com" }
                : null,
        );
        prisma.application.findMany.mockResolvedValue([
            {
                stage: "interview",
                updatedAt: new Date("2026-09-10T10:00:00Z"),
                jobRequisition: { title: "Backend Engineer" },
                offer: null,
            },
        ]);

        const result = await readStatusViaLink({ token: raw });

        expect(result.candidateId).toBe(7);
        expect(result.view.applications).toHaveLength(1);
        expect(result.view.applications[0]).toEqual({
            jobTitle: "Backend Engineer",
            status: "INTERVIEW",
            label: "Interview",
            updatedAt: "2026-09-10T10:00:00.000Z",
        });
    });

    it("a wrong/expired/consumed link resolves to null (route renders the empty body)", async () => {
        expect(await readStatusViaLink({ token: "wrong" })).toBeNull();
        expect(await readStatusViaLink({ token: "" })).toBeNull();
        expect(await readStatusViaLink({})).toBeNull();
    });

    it("an APPLY_VERIFICATION token cannot be used as a status link (purpose-pinned)", async () => {
        const crypto = await import("node:crypto");
        const raw = "verify-token";
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        prisma.candidateEmailVerification.findUnique = jest.fn(async () => ({
            id: 6,
            candidateId: 7,
            purpose: "APPLY_VERIFICATION", // wrong purpose
            consumedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
        }));

        expect(await readStatusViaLink({ token: raw })).toBeNull();
        expect(prisma.application.findMany).not.toHaveBeenCalled();
    });
});
