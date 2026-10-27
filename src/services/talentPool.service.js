import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  candidateScopeWhere,
  maskCandidateForScope,
} from "../lib/recruitmentAccess.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import {
  computeRetentionUntil,
  assertCommunicationsAllowed,
} from "./candidatePrivacy.service.js";
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5601" });
};
export const listPools = async ({ page = 1, limit = 20, tenantId } = {}) => {
  const { scope } = await requireRecruitmentActor({ tenantId });
  page = Math.max(1, Math.floor(Number(page) || 1));
  limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const where = {
    tenantId,
    candidate: { anonymizedAt: null, ...candidateScopeWhere(scope) },
  };
  const [items, total] = await Promise.all([
    prisma.talentPool.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { addedAt: "desc" },
      include: {
        candidate: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    }),
    prisma.talentPool.count({ where }),
  ]);
  return {
    items: scope.canSeeInternalNotes
      ? items
      : items.map((r) => ({ ...r, notes: null })),
    total,
    page,
    limit,
  };
};
export const addToPool = async ({
  candidateId,
  poolName = "General",
  notes,
  tenantId,
}) =>
  tenantTransaction(
    prisma,
    async (db) => {
      const { who } = await requireRecruitmentActor(
        {
          tenantId,
          permission: "hr.recruitment.create",
          allowedScopes: ["ORG"],
        },
        db,
      );
      const id = Number(candidateId),
        name = String(poolName).trim();
      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !name ||
        name.length > 100 ||
        (notes != null && (typeof notes !== "string" || notes.length > 4000))
      )
        fail("Valid candidate, pool name and bounded notes are required", 422);
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        id,
        tenantId,
      );
      const candidate = await db.candidate.findFirst({
        where: { id, tenantId, anonymizedAt: null, status: "active" },
        select: { id: true },
      });
      if (!candidate) fail("Candidate not found", 404);
      await assertCommunicationsAllowed(
        { tenantId, candidateId: id, purpose: "TALENT_POOL" },
        { db },
      );
      const existing = await db.talentPool.findFirst({
        where: { tenantId, candidateId: id, poolName: name },
      });
      if (existing) return existing;
      // Membership and its retention clock commit together. A policy failure must
      // not leave personal data retained under an unknown policy.
      const retentionUntil = await computeRetentionUntil(
        { tenantId, appliesTo: "TALENT_POOL" },
        { db },
      );
      const entry = await db.talentPool.create({
        data: {
          tenantId,
          candidateId: id,
          poolName: name,
          notes: notes?.trim() || null,
          addedById: who.id,
        },
      });
      if (retentionUntil)
        await db.candidate.updateMany({
          where: { id, tenantId },
          data: { retentionUntil, retentionPopulation: "TALENT_POOL" },
        });
      return {
        ...entry,
        ...(retentionUntil
          ? { retentionUntil, retentionPopulation: "TALENT_POOL" }
          : {}),
      };
    },
    { tenantId },
  );
export const removeFromPool = async (id, tenantId) =>
  tenantTransaction(
    prisma,
    async (db) => {
      await requireRecruitmentActor(
        {
          tenantId,
          permission: "hr.recruitment.delete",
          allowedScopes: ["ORG"],
        },
        db,
      );
      const removed = await db.talentPool.deleteMany({
        where: { id: Number(id), tenantId },
      });
      if (!removed.count) fail("Talent pool entry not found", 404);
      return { removed: true, id: Number(id) };
    },
    { tenantId },
  );
export const getCandidatesInPool = async (poolName, tenantId) => {
  const { scope } = await requireRecruitmentActor({ tenantId });
  const rows = await prisma.talentPool.findMany({
    where: {
      tenantId,
      poolName,
      candidate: { anonymizedAt: null, ...candidateScopeWhere(scope) },
    },
    take: 100,
    include: { candidate: { include: { tags: { include: { tag: true } } } } },
  });
  return rows.map((r) => ({
    ...r,
    notes: scope.canSeeInternalNotes ? r.notes : null,
    candidate: maskCandidateForScope(r.candidate, scope),
  }));
};
