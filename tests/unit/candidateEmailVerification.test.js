import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { randomBytes, createHash } from "node:crypto";
const tenant = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-21T12:00:00Z");
const db = {
  candidateEmailVerification: {
    updateMany: jest.fn(),
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    findUnique: jest.fn(),
  },
  candidate: {
    findFirst: jest.fn(),
    update: jest.fn(async ({ data }) => ({ id: 7, ...data })),
  },
};
const transaction = jest.fn((_client, fn) => fn(db)),
  queueMailboxMessage = jest.fn(async () => ({ id: "queued" }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: transaction,
}));
jest.unstable_mockModule(
  "../../src/services/candidateMailboxQueue.service.js",
  () => ({ queueMailboxMessage }),
);
const { issueEmailVerification, consumeEmailVerification, issueStatusLink } =
  await import("../../src/services/candidateVerification.service.js");
const candidate = {
  id: 7,
  firstName: "Fictional",
  email: "candidate@example.invalid",
};
const raw = randomBytes(32).toString("base64url");
const valid = {
  id: 3,
  candidateId: 7,
  tenantId: tenant,
  tokenHash: createHash("sha256").update(raw).digest("hex"),
  email: candidate.email,
  purpose: "APPLY_VERIFICATION",
  consumedAt: null,
  expiresAt: new Date(now.getTime() + 60000),
};
beforeEach(() => {
  jest.clearAllMocks();
  db.candidateEmailVerification.findUnique.mockResolvedValue({ ...valid });
  db.candidateEmailVerification.updateMany.mockResolvedValue({ count: 1 });
  db.candidate.findFirst.mockResolvedValue(candidate);
  queueMailboxMessage.mockResolvedValue({ id: "queued" });
});
describe("transactional verified mailbox links", () => {
  it("replaces the old token and queues the new link in the same transaction without storing plaintext tokens", async () => {
    const issued = await issueEmailVerification(db, {
      tenantId: tenant,
      candidate,
      email: candidate.email,
      now,
    });
    const stored = db.candidateEmailVerification.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(issued.token).digest("hex"),
    );
    expect(stored.token).toBeUndefined();
    expect(stored.purpose).toBe("APPLY_VERIFICATION");
    expect(stored.expiresAt.getTime() - now.getTime()).toBe(86400000);
    expect(db.candidateEmailVerification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: tenant,
        candidateId: 7,
        purpose: "APPLY_VERIFICATION",
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
    expect(queueMailboxMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: tenant,
        candidate,
        token: issued.token,
        tokenPurpose: "APPLY_VERIFICATION",
        templateKey: "portal_email_verification",
      }),
    );
  });
  it("returns null when no mailbox owner is supplied", async () => {
    expect(
      await issueEmailVerification(db, {
        tenantId: tenant,
        candidate: { id: 7 },
        email: null,
      }),
    ).toBeNull();
    expect(db.candidateEmailVerification.create).not.toHaveBeenCalled();
    expect(queueMailboxMessage).not.toHaveBeenCalled();
  });
  it("propagates a queue write failure so the caller transaction cannot commit a link without delivery intent", async () => {
    queueMailboxMessage.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(
      issueEmailVerification(db, { tenantId: tenant, candidate, now }),
    ).rejects.toThrow("queue unavailable");
  });
  it("queues mailbox-owner notices with the purpose-scoped status token", async () => {
    const issued = await issueStatusLink(db, {
      tenantId: tenant,
      candidate,
      now,
      templateKey: "portal_mailbox_notice",
      jobTitle: "Editor",
    });
    expect(queueMailboxMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        templateKey: "portal_mailbox_notice",
        tokenPurpose: "STATUS_LINK",
        jobTitle: "Editor",
        token: issued.token,
      }),
    );
    const data = db.candidateEmailVerification.create.mock.calls[0][0].data;
    expect(data.expiresAt.getTime() - now.getTime()).toBe(180 * 86400000);
  });
  it("consumes a live token once and stamps only its active mailbox owner", async () => {
    const result = await consumeEmailVerification({
      tenantId: tenant,
      token: raw,
      now,
    });
    expect(result).toMatchObject({ verified: true, candidateId: 7 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(
      db.candidateEmailVerification.findUnique.mock.calls[0][0].where,
    ).toEqual({ tokenHash: valid.tokenHash, tenantId: tenant });
    expect(db.candidateEmailVerification.updateMany).toHaveBeenCalledWith({
      where: { id: 3, tenantId: tenant, consumedAt: null },
      data: { consumedAt: now },
    });
    expect(db.candidate.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { emailVerifiedAt: now, version: { increment: 1 } },
    });
  });
  it.each([
    null,
    { purpose: "STATUS_LINK" },
    { consumedAt: now },
    { expiresAt: new Date(now.getTime() - 1) },
    { tenantId: "22222222-2222-4222-8222-222222222222" },
  ])(
    "unknown, wrong-purpose, expired, used and foreign tokens have uniform errors (%p)",
    async (delta) => {
      db.candidateEmailVerification.findUnique.mockResolvedValue(
        delta === null ? null : { ...valid, ...delta },
      );
      await expect(
        consumeEmailVerification({ tenantId: tenant, token: raw, now }),
      ).rejects.toMatchObject({
        status: 400,
        code: "HR-PORTAL-VERIFY-INVALID",
      });
      expect(db.candidate.update).not.toHaveBeenCalled();
    },
  );
  it("does not stamp a deleted owner or lose the consume race", async () => {
    db.candidate.findFirst.mockResolvedValueOnce(null);
    await expect(
      consumeEmailVerification({ tenantId: tenant, token: raw, now }),
    ).rejects.toMatchObject({ status: 400 });
    db.candidateEmailVerification.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      consumeEmailVerification({ tenantId: tenant, token: raw, now }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.candidate.update).not.toHaveBeenCalled();
  });
  it("rejects missing tenant and malformed tokens before lookup", async () => {
    for (const args of [
      { token: raw },
      { tenantId: tenant, token: "short" },
      { tenantId: tenant, token: "" },
    ])
      await expect(consumeEmailVerification(args)).rejects.toMatchObject({
        status: 400,
      });
    expect(db.candidateEmailVerification.findUnique).not.toHaveBeenCalled();
  });
});
