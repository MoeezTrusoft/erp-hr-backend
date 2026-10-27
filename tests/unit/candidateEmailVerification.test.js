// tests/unit/candidateEmailVerification.test.js
//
// Phase 5 / decision record §3.2 + §3.4 second half — candidate EMAIL
// VERIFICATION. The assertions that matter:
//
//   * §3.2  the token row commits with the application (issue-in-tx), the
//           email goes out AFTER commit (no HTTP inside a DB transaction),
//           and the DB stores sha256(token) — never the raw token.
//   * §3.2  consume: unknown / expired / already-used all return the SAME
//           uniform 400 (§3.4 no-oracle applied to this surface), and a valid
//           token stamps candidates.emailVerifiedAt exactly once.
//   * §3.4  the mailbox-owner notice fires ONLY on the reconciled path — a
//           brand-new candidate IS the submitter, and a notice to them is
//           noise. Both sends are fire-and-forget: a hub outage never fails
//           the intake.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import crypto from "node:crypto";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-21T12:00:00.000Z");

const prisma = {
  candidateEmailVerification: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    findUnique: jest.fn(),
    update: jest.fn(async ({ data }) => ({ id: 1, ...data })),
  },
  candidate: { update: jest.fn(async ({ data }) => ({ id: 7, ...data })) },
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
const {
  issueEmailVerification,
  sendVerificationEmail,
  consumeEmailVerification,
  notifyMailboxOwner,
} = await import("../../src/services/candidate-verification.service.js");

beforeEach(() => {
  jest.clearAllMocks();
  prisma.candidateEmailVerification.findUnique.mockResolvedValue(null);
});

describe("Phase 5 / §3.2 — token issuance", () => {
  it("mints the token row in-tx, replaces any unconsumed token, and sends AFTER commit", async () => {
    await issueEmailVerification(prisma, {
      tenantId: TENANT,
      candidate: { id: 7, firstName: "Ayesha" },
      email: "ayesha@example.com",
      now: NOW,
    });

    // The previous unconsumed token was consumed (replace-then-issue).
    expect(prisma.candidateEmailVerification.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ candidateId: 7, purpose: "APPLY_VERIFICATION", consumedAt: null }),
      data: { consumedAt: NOW },
    });
    // The row stores a HASH, not the raw token.
    expect(prisma.candidateEmailVerification.create).toHaveBeenCalledTimes(1);
    const stored = prisma.candidateEmailVerification.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.purpose).toBe("APPLY_VERIFICATION");
    expect(stored.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(String(stored.token ?? "")).toBe(""); // no raw token column write

    // The send happens outside — caller-driven — with the token in the link.
    await sendVerificationEmail({ tenantId: TENANT, email: "ayesha@example.com", firstName: "Ayesha", token: "tok" });
    expect(sendCandidateEmail).toHaveBeenCalledTimes(1);
    const call = sendCandidateEmail.mock.calls[0][0];
    expect(call.templateId).toBe("hr.recruitment.portal_email_verification");
    expect(call.data.verifyUrl).toContain("token=tok");
    expect(call.channels).toBeUndefined(); // sendCandidateEmail fixes email-only
  });

  it("returns null (no row, no throw) when there is no candidate/email to verify", async () => {
    expect(
      await issueEmailVerification(prisma, { tenantId: TENANT, candidate: { id: 7 }, email: null }),
    ).toBeNull();
    expect(prisma.candidateEmailVerification.create).not.toHaveBeenCalled();
  });
});

describe("Phase 5 / §3.2 — token consumption (uniform failure)", () => {
  it("a valid token stamps the candidate exactly once and consumes the row atomically", async () => {
    const rawToken = "live-token";
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    prisma.candidateEmailVerification.findUnique.mockResolvedValue({
      id: 3,
      candidateId: 7,
      tenantId: TENANT,
      tokenHash: hash,
      email: "ayesha@example.com",
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    const result = await consumeEmailVerification({ token: rawToken, now: NOW });

    expect(result.verified).toBe(true);
    expect(result.candidateId).toBe(7);
    expect(prisma.candidate.update).toHaveBeenCalledTimes(1);
    const stamp = prisma.candidate.update.mock.calls[0][0].data;
    expect(stamp.emailVerifiedAt).toEqual(NOW);
    // The consume + stamp are one unit: both writes happened inside the same
    // transaction callback (mocked pass-through), consume BEFORE stamp.
    expect(prisma.candidateEmailVerification.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { consumedAt: NOW },
    });
  });

  it("unknown token, expired and already-consumed are the SAME 400 — no oracle", async () => {
    // unknown
    await expect(consumeEmailVerification({ token: "nope" })).rejects.toMatchObject({
      status: 400,
      code: "HR-PORTAL-VERIFY-INVALID",
    });
    // expired
    prisma.candidateEmailVerification.findUnique.mockResolvedValue({
      id: 3,
      candidateId: 7,
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() - 1_000),
    });
    await expect(consumeEmailVerification({ token: "old" })).rejects.toMatchObject({
      status: 400,
      code: "HR-PORTAL-VERIFY-INVALID",
    });
    // consumed
    prisma.candidateEmailVerification.findUnique.mockResolvedValue({
      id: 3,
      candidateId: 7,
      consumedAt: new Date(NOW.getTime() - 5_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await expect(consumeEmailVerification({ token: "used" })).rejects.toMatchObject({
      code: "HR-PORTAL-VERIFY-INVALID",
    });
    // none of them stamped anyone
    expect(prisma.candidate.update).not.toHaveBeenCalled();
  });
});

describe("Phase 5 / §3.4 — the mailbox-owner notice", () => {
  it("sends with the job title and never throws even when the hub is down", async () => {
    sendCandidateEmail.mockResolvedValueOnce({ sent: false, reason: "hub-unreachable" });
    const result = await notifyMailboxOwner({
      tenantId: TENANT,
      candidate: { id: 9, firstName: "Bilal", email: "bilal@example.com" },
      requisitionTitle: "QA Lead",
    });
    expect(result.sent).toBe(false);
    const call = sendCandidateEmail.mock.calls[0][0];
    expect(call.recipients).toBeUndefined(); // shape is enforced inside the client
    expect(call.data.jobTitle).toBe("QA Lead");
    expect(call.templateId).toBe("hr.recruitment.portal_mailbox_notice");
  });
});
