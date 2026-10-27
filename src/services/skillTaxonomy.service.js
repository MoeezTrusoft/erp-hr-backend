// src/services/skillTaxonomy.service.js
//
// Phase 13 / decision record §7.2–7.2b — taxonomy service. The canonical Skill
// catalogue is deterministic reference data; this service is the read/curate
// layer around it: alias index loading, parse reconciliation, and the
// ai-suggested alias evidence path. There is NO fuzzy matcher here by design
// (§7.2): resolution is exact over the alias index, everything else surfaces
// as UNMAPPED for a human to curate.

import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { candidateScopeWhere } from "../lib/recruitmentAccess.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { currentCorrelationId } from "../lib/requestContext.js";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import {
  buildAliasIndex,
  reconcileParsedSkills,
  recordAliasSuggestion,
} from "../lib/skillNormalization.js";

export { loadAliasIndex } from "./candidateMatch.service.js";

/**
 * Reconcile a candidate's parsed resume skills onto the taxonomy (§7.2a).
 * Read-only preview: mapped items, unmapped leftovers, and (optionally) the
 * alias suggestions the unmapped leftovers would produce. Nothing is written —
 * persisting CandidateSkill rows stays with the ingest path.
 */
export async function reconcileParsedSkillsPreview({
  candidateId,
  tenantId = null,
  withSuggestions = false,
}) {
  const { scope } = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.read",
    allowedScopes: ["ORG", "MANAGED"],
  });
  const candidate = await prisma.candidate.findFirst({
    where: {
      id: Number(candidateId),
      tenantId,
      anonymizedAt: null,
      status: "active",
      ...candidateScopeWhere(scope),
    },
    select: {
      id: true,
      tenantId: true,
      parsedResume: true,
      candidateSkills: { select: { name: true, score: true, level: true } },
    },
  });
  if (!candidate)
    throw Object.assign(new Error("Candidate not found"), { status: 404 });

  await assertCommunicationsAllowed({
    tenantId,
    candidateId: candidate.id,
    purpose: "PROCESSING",
    requireExplicitConsent: true,
  });
  const effectiveTenant = tenantId;
  const [aliasRows, skills] = await Promise.all([
    prisma.skillAlias.findMany({
      where: {
        OR: [{ tenantId: null }, { tenantId: effectiveTenant }],
        status: "ACTIVE",
      },
      select: {
        alias: true,
        skillId: true,
        scope: true,
        status: true,
        tenantId: true,
      },
    }),
    prisma.skill.findMany({
      where: { OR: [{ tenantId: null }, { tenantId: effectiveTenant }] },
      select: { id: true, name: true, tenantId: true },
    }),
  ]);
  const index = buildAliasIndex(aliasRows, skills, effectiveTenant);

  const parsedItems = Array.isArray(candidate.parsedResume?.skills)
    ? candidate.parsedResume.skills
    : [];
  const { mapped, unmapped } = reconcileParsedSkills(index, parsedItems);

  const result = {
    candidateId: candidate.id,
    mapped,
    unmapped,
  };

  if (withSuggestions && unmapped.length) {
    // Evidence rows only (§7.2a) — the caller would persist these via
    // createAliasSuggestions after an admin reviews them.
    result.suggestedAliases = unmapped.slice(0, 20).map((u) => ({
      suggestedAlias: u.raw,
      evidence: { score: u.score ?? null, level: u.level ?? null },
    }));
  }

  await assertCommunicationsAllowed({
    tenantId,
    candidateId: candidate.id,
    purpose: "PROCESSING",
    requireExplicitConsent: true,
  });
  return result;
}

/**
 * Approve reviewed AI-suggested mappings (origin 'ai-suggested'). Only a
 * verified tenant HR administrator may promote them into the active alias
 * index; canonical targets must belong to this tenant or the platform core.
 */
export async function createAliasSuggestions({ suggestions, tenantId = null }) {
  const { who } = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.create",
    allowedScopes: ["ORG"],
    adminOnly: true,
  });
  if (!Array.isArray(suggestions) || !suggestions.length) return { created: 0 };
  if (
    suggestions.length > 100 ||
    suggestions.some(
      (s) =>
        typeof s?.alias !== "string" ||
        !s.alias.trim() ||
        s.alias.length > 256 ||
        !Number.isSafeInteger(Number(s.skillId)) ||
        Number(s.skillId) < 1,
    )
  )
    throw Object.assign(new Error("Provide up to 100 valid alias mappings"), {
      status: 422,
      code: "HR-5904",
    });
  const rows = [];
  for (const s of suggestions) {
    if (!s?.alias || !s?.skillId) continue;
    rows.push(
      recordAliasSuggestion({
        alias: s.alias,
        skillId: Number(s.skillId),
        tenantId,
      }),
    );
  }
  if (!rows.length) return { created: 0 };
  const created = await tenantTransaction(
    prisma,
    async (db) => {
      for (const row of rows) {
        const target = await db.skill.findFirst({
          where: { id: row.skillId, OR: [{ tenantId: null }, { tenantId }] },
          select: { id: true },
        });
        if (!target)
          throw Object.assign(new Error("Skill not found"), {
            status: 404,
            code: "HR-5904",
          });
      }
      const saved = [];
      for (const row of rows)
        saved.push(
          await db.skillAlias.upsert({
            where: { tenantId_alias: { tenantId, alias: row.alias } },
            create: row,
            update: { skillId: row.skillId },
          }),
        );
      await db.log.create({
        data: {
          tenantId,
          employeeId: who.id,
          actionById: who.id,
          type: "Update",
          action_type: "SKILL_ALIAS_APPROVED",
          module: "Recruitment taxonomy",
          result: "SUCCESS",
          ip: "unknown",
          os: "server",
          notes: String(saved.length) + " reviewed alias mappings recorded",
          correlationId: currentCorrelationId() ?? null,
        },
      });
      return saved;
    },
    { tenantId },
  );
  logger.info(
    { count: created.length, tenantId },
    "skill alias suggestions persisted",
  );
  return { created: created.length };
}
