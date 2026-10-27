import { jest, beforeEach, describe, it, expect } from "@jest/globals";
const tenantId = "11111111-1111-1111-1111-111111111111";
let candidates, apps, receipts;
const actor = jest.fn(async () => ({
  who: { id: 9 },
  scope: { level: "ORG" },
}));
const event = jest.fn(async () => ({ id: "event" }));
const db = {
  $queryRawUnsafe: jest.fn(async (sql) =>
    sql.startsWith("SELECT a.id") ? apps : [],
  ),
  candidate: {
    findFirst: jest.fn(async ({ where }) =>
      where.tenantId === tenantId ? candidates.get(where.id) : null,
    ),
    update: jest.fn(async ({ where, data }) => {
      const c = candidates.get(where.id);
      Object.assign(c, { ...data, version: c.version + 1 });
      return c;
    }),
  },
  application: {
    updateMany: jest.fn(async ({ where }) => ({ count: where.id.in.length })),
  },
  candidateLegalHold: { findMany: jest.fn(async () => []) },
  candidateEmailVerification: {
    updateMany: jest.fn(async () => ({ count: 2 })),
  },
  candidateConsent: { updateMany: jest.fn() },
  talentPool: { updateMany: jest.fn() },
  candidateSkill: { updateMany: jest.fn() },
  aiInferenceRecord: { updateMany: jest.fn() },
  log: {
    findFirst: jest.fn(
      async ({ where }) =>
        receipts.find((r) => r.notes.startsWith(where.notes.startsWith)) ??
        null,
    ),
    create: jest.fn(async ({ data }) => {
      receipts.push(data);
      return data;
    }),
  },
};
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_p, fn) => fn(db)),
}));
jest.unstable_mockModule("../../src/mcp/context.js", () => ({
  getCtx: () => ({ user: {} }),
}));
jest.unstable_mockModule(
  "../../src/services/recruitmentActor.service.js",
  () => ({ requireRecruitmentActor: actor }),
);
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: event,
}));
const { mergeCandidates } =
  await import("../../src/services/candidateMerge.service.js");
const preview = (extra = {}) =>
  mergeCandidates({ tenantId, sourceId: 1, targetId: 2, ...extra });
const apply = async (extra = {}) => {
  const p = await preview();
  return preview({
    mode: "APPLY",
    previewHash: p.previewHash,
    confirmed: true,
    ...extra,
  });
};
beforeEach(() => {
  jest.clearAllMocks();
  apps = [];
  receipts = [];
  candidates = new Map([
    [
      1,
      {
        id: 1,
        tenantId,
        firstName: "Ayesha",
        email: "typo@example.invalid",
        phone: "source phone",
        notes: "Original source note",
        status: "active",
        version: 0,
      },
    ],
    [
      2,
      {
        id: 2,
        tenantId,
        firstName: "Ayesha",
        email: "correct@example.invalid",
        phone: null,
        notes: "Survivor note",
        status: "active",
        version: 3,
      },
    ],
  ]);
  db.candidateLegalHold.findMany.mockResolvedValue([]);
  actor.mockResolvedValue({ who: { id: 9 }, scope: { level: "ORG" } });
  event.mockResolvedValue({ id: "event" });
});
describe("candidate merge preview and identity boundaries", () => {
  it("defaults to a read-only preview and requires verified organization-wide edit access", async () => {
    const p = await preview();
    expect(p.mode).toBe("PREVIEW");
    expect(p.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(actor).toHaveBeenCalledWith(
      { tenantId, permission: "hr.recruitment.update", allowedScopes: ["ORG"] },
      db,
    );
  });
  it("keeps personal identity/evidence in place and attributes archive to the actual employee", async () => {
    const r = await apply({ actorId: 999 });
    expect(r.actorId).toBe(9);
    expect(candidates.get(2).phone).toBeNull();
    expect(candidates.get(2).notes).toBe("Survivor note");
    expect(candidates.get(1).notes).toContain("Original source note");
    expect(candidates.get(1).status).toBe("archived");
    for (const key of [
      "candidateConsent",
      "talentPool",
      "candidateSkill",
      "aiInferenceRecord",
    ])
      expect(db[key].updateMany).not.toHaveBeenCalled();
    expect(db.candidateEmailVerification.updateMany).toHaveBeenCalledWith({
      where: { tenantId, candidateId: 1, consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(db.log.create).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledTimes(1);
  });
  it("transfers only unprotected applications and requires explicit historical conflict confirmation", async () => {
    apps = [
      {
        id: 11,
        candidateId: 1,
        jobRequisitionId: 5,
        stage: "screening",
        version: 0,
        protected: false,
      },
      {
        id: 12,
        candidateId: 1,
        jobRequisitionId: 6,
        stage: "rejected",
        version: 2,
        protected: false,
      },
      {
        id: 21,
        candidateId: 2,
        jobRequisitionId: 6,
        stage: "interview",
        version: 1,
        protected: false,
      },
    ];
    await expect(apply()).rejects.toThrow(/Explicitly confirm/);
    const r = await apply({ keepTargetOnConflict: true });
    expect(r.transferredApplicationIds).toEqual([11]);
    expect(r.keptOnSourceApplicationIds).toEqual([12]);
    expect(db.application.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { candidateId: 2, version: { increment: 1 } },
      }),
    );
  });
  it("never silently abandons a live conflicting or identity-protected application", async () => {
    apps = [
      {
        id: 11,
        candidateId: 1,
        jobRequisitionId: 5,
        stage: "screening",
        version: 0,
        protected: true,
      },
    ];
    const p = await preview();
    expect(p.canMerge).toBe(false);
    expect(p.blockedApplicationIds).toEqual([11]);
    await expect(apply({ keepTargetOnConflict: true })).rejects.toThrow(
      /Resolve active/,
    );
    expect(db.candidate.update).not.toHaveBeenCalled();
  });
  it("refuses stale previews, absent confirmation and truthy string confirmation", async () => {
    const p = await preview();
    candidates.get(2).version++;
    await expect(
      preview({ mode: "APPLY", previewHash: p.previewHash, confirmed: true }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(preview({ mode: "APPLY" })).rejects.toMatchObject({
      status: 428,
    });
    await expect(
      preview({ keepTargetOnConflict: "false" }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("replays an identical confirmed request without duplicating changes or audit", async () => {
    const p = await preview(),
      args = { mode: "APPLY", previewHash: p.previewHash, confirmed: true };
    await preview(args);
    const r = await preview(args);
    expect(r.replayed).toBe(true);
    expect(db.log.create).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledTimes(1);
  });
  it("refuses self-merge, foreign rows, archived rows, erasure and legal holds", async () => {
    await expect(preview({ targetId: 1 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(preview({ targetId: 99 })).rejects.toMatchObject({
      status: 404,
    });
    candidates.get(2).anonymizedAt = new Date();
    await expect(preview()).rejects.toThrow(/Anonymized/);
    delete candidates.get(2).anonymizedAt;
    candidates.get(2).status = "archived";
    await expect(preview()).rejects.toThrow(/active/);
    candidates.get(2).status = "active";
    db.candidateLegalHold.findMany.mockResolvedValue([{ candidateId: 1 }]);
    await expect(preview()).rejects.toThrow(/legal hold/);
  });
  it("requires the domain audit event to commit successfully", async () => {
    event.mockResolvedValueOnce(null);
    await expect(apply()).rejects.toMatchObject({ status: 503 });
  });
});
