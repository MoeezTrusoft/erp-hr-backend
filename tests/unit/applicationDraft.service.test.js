import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createHash } from "node:crypto";
const tenant = "11111111-1111-4111-8111-111111111111";
let rows = [],
  seq = 0;
const owner = {
  id: 7,
  email: "ayesha@example.invalid",
  firstName: "Ayesha",
  status: "active",
  anonymizedAt: null,
};
const prisma = {
  $executeRaw: jest.fn(async () => 1),
  $executeRawUnsafe: jest.fn(async () => 1),
  $queryRawUnsafe: jest.fn(async () => [{ id: 1 }]),
  candidate: {
    findFirst: jest.fn(),
    create: jest.fn(async ({ data }) => ({ id: 50, ...data })),
    update: jest.fn(async () => ({ id: 7 })),
  },
  candidateDncEntry: { findFirst: jest.fn() },
  applicationDraft: {
    findFirst: jest.fn(async ({ where }) => {
      const row = rows.find(
        (x) =>
          x.tenantId === where.tenantId &&
          (!where.tokenHash || x.tokenHash === where.tokenHash) &&
          (!where.candidateId || x.candidateId === where.candidateId) &&
          (!where.requisitionId || x.requisitionId === where.requisitionId) &&
          (!("submittedAt" in where) || x.submittedAt === where.submittedAt) &&
          (!where.expiresAt || x.expiresAt > where.expiresAt.gt),
      );
      return row ? { ...row, candidate: { ...owner } } : null;
    }),
    create: jest.fn(async ({ data }) => {
      const row = {
        id: ++seq,
        submittedAt: null,
        updated_at: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = rows.find((x) => x.id === where.id);
      Object.assign(row, data, {
        updated_at: new Date(row.updated_at.getTime() + 1),
      });
      return row;
    }),
    deleteMany: jest.fn(async () => ({ count: 2 })),
  },
};
const queueMailboxMessage = jest.fn(async () => ({ queued: true }));
const submitPublicApplication = jest.fn(async () => ({
  received: true,
  applicationId: 901,
}));
const getPublicJob = jest.fn(async () => ({
  id: 5,
  title: "Backend Engineer",
}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: (_db, fn) => fn(prisma),
}));
jest.unstable_mockModule("../../src/services/candidateMailboxQueue.service.js", () => ({
  queueMailboxMessage,
}));
jest.unstable_mockModule("../../src/services/publicPortal.service.js", () => ({
  submitPublicApplication,
  getPublicJob,
}));
jest.unstable_mockModule("../../src/lib/recruitmentFlags.js", () => ({
  isRecruitmentFlagEnabled: () => true,
}));
jest.unstable_mockModule("../../src/lib/publicPortal.js", () => ({
  getPublicJob,
  toPublicJob: (row) => row,
  PUBLIC_JOB_SELECT: {},
}));
const service = await import("../../src/services/applicationDraft.service.js");
const save = (body) =>
  service.saveApplicationDraft({
    tenantId: tenant,
    requisitionId: 5,
    email: owner.email,
    body: body ?? { firstName: "Ayesha", answers: { 12: "Karachi" } },
  });
const token = () => queueMailboxMessage.mock.calls.at(-1)[1].token;
beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  seq = 0;
  prisma.candidate.findFirst.mockResolvedValue({ ...owner });
  prisma.candidateDncEntry.findFirst.mockResolvedValue(null);
  getPublicJob.mockResolvedValue({ id: 5, title: "Backend Engineer" });
});
describe("mailbox-owned application drafts", () => {
  it("stores a hash and queues the mailbox link on the same transaction with a uniform receipt", async () => {
    expect(await save()).toEqual({ saved: true });
    const raw = token();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].tokenHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(rows[0].payload.answers).toEqual({ 12: "Karachi" });
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect(queueMailboxMessage.mock.calls[0][0]).toBe(prisma);
    expect(queueMailboxMessage.mock.calls[0][1]).toMatchObject({
      tenantId: tenant,
      tokenPurpose: "DRAFT",
      templateKey: "portal_draft_link",
    });
  });
  it("anonymous recovery rotates the token while preserving saved answers", async () => {
    await save();
    const first = token();
    await save({ firstName: "Attacker", answers: { 12: "Overwrite" } });
    expect(token()).not.toBe(first);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.firstName).toBe("Ayesha");
    expect(rows[0].payload.answers[12]).toBe("Karachi");
    expect(await service.loadApplicationDraft({ tenantId: tenant, token: first })).toBeNull();
  });
  it("creates an unknown candidate without asserting processing consent", async () => {
    prisma.candidate.findFirst.mockResolvedValueOnce(null);
    await save();
    expect(prisma.candidate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: tenant,
        email: owner.email,
        status: "active",
      }),
    });
    expect(prisma.candidate.create.mock.calls[0][0].data.consentStatus).toBeUndefined();
  });
  it("uses the same receipt for DNC and inactive candidates without queuing contact", async () => {
    prisma.candidateDncEntry.findFirst.mockResolvedValue({ id: 1 });
    expect(await save()).toEqual({ saved: true });
    expect(queueMailboxMessage).not.toHaveBeenCalled();
    prisma.candidateDncEntry.findFirst.mockResolvedValue(null);
    prisma.candidate.findFirst.mockResolvedValue({
      ...owner,
      anonymizedAt: new Date(),
    });
    expect(await save()).toEqual({ saved: true });
    expect(rows).toHaveLength(0);
  });
  it("validates payload and published job before writes", async () => {
    await expect(save({ answers: "wrong" })).rejects.toThrow();
    expect(prisma.applicationDraft.create).not.toHaveBeenCalled();
    getPublicJob.mockResolvedValue(null);
    await expect(save()).rejects.toMatchObject({ code: "HR-5801" });
  });
  it("loads only a safe owned projection with upload presence, never internal document or candidate ids", async () => {
    await save();
    const view = await service.loadApplicationDraft({
      tenantId: tenant,
      token: token(),
    });
    expect(view).toMatchObject({
      jobTitle: "Backend Engineer",
      email: owner.email,
      requisitionId: 5,
      resumeUploaded: false,
    });
    expect(Object.keys(view).sort()).toEqual([
      "email",
      "expiresAt",
      "job",
      "jobTitle",
      "payload",
      "requisitionId",
      "resumeUploaded",
      "updatedAt",
    ]);
  });
  it("rejects missing tenant, wrong tenant and malformed tokens uniformly", async () => {
    await save();
    for (const args of [
      { token: token() },
      { tenantId: "other", token: token() },
      { tenantId: tenant, token: "nope" },
    ])
      expect(await service.loadApplicationDraft(args)).toBeNull();
  });
  it.each(["expired", "submitted", "anonymized"])("does not load a %s draft", async (state) => {
    await save();
    const raw = token();
    if (state === "expired") rows[0].expiresAt = new Date(0);
    if (state === "submitted") rows[0].submittedAt = new Date();
    if (state === "anonymized")
      prisma.applicationDraft.findFirst.mockResolvedValueOnce({
        ...rows[0],
        candidate: { ...owner, anonymizedAt: new Date() },
      });
    expect(await service.loadApplicationDraft({ tenantId: tenant, token: raw })).toBeNull();
  });
  it("requires the current saved version and proves mailbox ownership on an authenticated save", async () => {
    await save();
    const args = {
      tenantId: tenant,
      token: token(),
      body: { firstName: "Ayesha", answers: { 12: "Lahore" } },
    };
    await expect(
      service.updateApplicationDraft({
        ...args,
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 412 });
    await service.updateApplicationDraft({
      ...args,
      expectedUpdatedAt: rows[0].updated_at.toISOString(),
    });
    expect(rows[0].payload.answers[12]).toBe("Lahore");
    expect(prisma.candidate.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });
  it("delegates submit to canonical intake with tenant and token; intake owns atomic consumption", async () => {
    await save();
    const raw = token();
    expect(await service.submitApplicationDraft({ tenantId: tenant, token: raw })).toMatchObject({
      received: true,
    });
    expect(submitPublicApplication).toHaveBeenCalledWith({
      tenantId: tenant,
      requisitionId: 5,
      draftToken: raw,
    });
    expect(rows[0].submittedAt).toBeNull();
  });
  it("rejects invalid submission before canonical intake", async () => {
    await expect(
      service.submitApplicationDraft({ tenantId: tenant, token: "garbage" }),
    ).rejects.toMatchObject({ code: "HR-5801" });
    expect(submitPublicApplication).not.toHaveBeenCalled();
  });
  it("purges by scoped candidate and sweeps only expired unsubmitted drafts", async () => {
    await service.purgeDraftsForCandidate(prisma, {
      tenantId: tenant,
      candidateId: 7,
    });
    expect(prisma.applicationDraft.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: tenant, candidateId: 7 },
    });
    const now = new Date();
    expect(await service.purgeExpiredDrafts({ now })).toEqual({ purged: 2 });
    expect(prisma.applicationDraft.deleteMany).toHaveBeenLastCalledWith({
      where: { expiresAt: { lte: now }, submittedAt: null },
    });
  });
  it("strips raw media ids and ownership fields from candidate payloads", () => {
    expect(service.parseDraftPayload({})).toEqual({});
    expect(
      service.parseDraftPayload({
        resumeMediaId: 55,
        tenantId: "foreign",
        candidateId: 77,
        answers: { 1: "x" },
      }),
    ).toEqual({ answers: { 1: "x" } });
    expect(() => service.parseDraftPayload({ answers: [] })).toThrow();
  });
});
