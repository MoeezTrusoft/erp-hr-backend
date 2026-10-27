import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { randomBytes, createHash } from "node:crypto";
const tenant = "11111111-1111-4111-8111-111111111111",
  raw = randomBytes(32).toString("base64url");
const db = {
  candidate: { findFirst: jest.fn() },
  application: { findMany: jest.fn() },
  candidateEmailVerification: {
    findUnique: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
  },
};
const queueMailboxMessage = jest.fn(async () => ({ id: "queued" })),
  transaction = jest.fn((_client, fn) => fn(db));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: transaction,
}));
jest.unstable_mockModule(
  "../../src/services/candidateMailboxQueue.service.js",
  () => ({ queueMailboxMessage }),
);
const { requestStatusLink, readStatusViaLink } =
  await import("../../src/services/candidateStatus.service.js");
const candidate = {
    id: 7,
    firstName: "Fictional",
    email: "candidate@example.invalid",
  },
  token = {
    id: 5,
    candidateId: 7,
    tenantId: tenant,
    email: candidate.email,
    purpose: "STATUS_LINK",
    consumedAt: null,
    expiresAt: new Date(Date.now() + 86400000),
  };
beforeEach(() => {
  jest.clearAllMocks();
  db.candidate.findFirst.mockResolvedValue(candidate);
  db.candidateEmailVerification.findUnique.mockResolvedValue(token);
  db.application.findMany.mockResolvedValue([]);
});
describe("candidate status links", () => {
  it("returns a uniform receipt while queuing a purpose-scoped link in the token transaction", async () => {
    expect(
      await requestStatusLink({
        tenantId: tenant,
        email: "  CANDIDATE@EXAMPLE.INVALID ",
      }),
    ).toEqual({ accepted: true });
    const data = db.candidateEmailVerification.create.mock.calls[0][0].data;
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.purpose).toBe("STATUS_LINK");
    expect(data.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 170 * 86400000,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queueMailboxMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: tenant,
        email: candidate.email,
        templateKey: "portal_status_link",
        tokenPurpose: "STATUS_LINK",
      }),
    );
  });
  it("unknown addresses receive the same receipt without a token or delivery intent", async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    expect(
      await requestStatusLink({
        tenantId: tenant,
        email: "unknown@example.invalid",
      }),
    ).toEqual({ accepted: true });
    expect(queueMailboxMessage).not.toHaveBeenCalled();
    expect(db.candidateEmailVerification.create).not.toHaveBeenCalled();
  });
  it("rejects malformed email before lookup", async () => {
    await expect(
      requestStatusLink({ tenantId: tenant, email: "bad" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.candidate.findFirst).not.toHaveBeenCalled();
  });
  it("returns the public projection under the verified tenant and owner", async () => {
    db.application.findMany.mockResolvedValue([
      {
        jobRequisitionId: 12,
        stage: "interview",
        updatedAt: new Date("2026-10-01T10:00:00Z"),
        jobRequisition: { title: "Editor" },
        offer: null,
        notes: "PRIVATE",
        score: 99,
      },
    ]);
    const result = await readStatusViaLink({ tenantId: tenant, token: raw });
    expect(result.candidateId).toBe(7);
    expect(result.view.applications[0]).toEqual({
      jobRequisitionId: 12,
      jobTitle: "Editor",
      status: "INTERVIEW",
      label: "Interview",
      updatedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(db.candidateEmailVerification.findUnique).toHaveBeenCalledWith({
      where: {
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        tenantId: tenant,
      },
    });
    expect(db.application.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: tenant,
      candidateId: 7,
    });
    expect(db.candidateEmailVerification.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { purpose: "APPLY_VERIFICATION" },
    { consumedAt: new Date() },
    { expiresAt: new Date(0) },
  ])(
    "unknown, wrong-purpose, consumed and expired status links yield no data (%p)",
    async (delta) => {
      db.candidateEmailVerification.findUnique.mockResolvedValue(
        delta === null ? null : { ...token, ...delta },
      );
      expect(
        await readStatusViaLink({ tenantId: tenant, token: raw }),
      ).toBeNull();
      expect(db.application.findMany).not.toHaveBeenCalled();
    },
  );
  it("rejects unavailable owners and malformed or unscoped links", async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    expect(
      await readStatusViaLink({ tenantId: tenant, token: raw }),
    ).toBeNull();
    db.candidateEmailVerification.findUnique.mockClear();
    for (const args of [
      { token: raw },
      { tenantId: tenant, token: "short" },
      {},
    ])
      expect(await readStatusViaLink(args)).toBeNull();
    expect(db.candidateEmailVerification.findUnique).not.toHaveBeenCalled();
    expect(db.application.findMany).not.toHaveBeenCalled();
  });
});
