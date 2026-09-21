// src/services/skillTaxonomy.service.js
//
// Phase 13 / decision record §7.2–7.2b — taxonomy service. The canonical Skill
// catalogue is deterministic reference data; this service is the read/curate
// layer around it: alias index loading, parse reconciliation, and the
// ai-suggested alias evidence path. There is NO fuzzy matcher here by design
// (§7.2): resolution is exact over the alias index, everything else surfaces
// as UNMAPPED for a human to curate.

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { buildAliasIndex, reconcileParsedSkills, recordAliasSuggestion } from "../lib/skillNormalization.js";

export { loadAliasIndex } from "./candidateMatch.service.js";

/**
 * Reconcile a candidate's parsed resume skills onto the taxonomy (§7.2a).
 * Read-only preview: mapped items, unmapped leftovers, and (optionally) the
 * alias suggestions the unmapped leftovers would produce. Nothing is written —
 * persisting CandidateSkill rows stays with the ingest path.
 */
export async function reconcileParsedSkillsPreview({ candidateId, tenantId = null, withSuggestions = false }) {
    const candidate = await prisma.candidate.findUnique({
        where: { id: Number(candidateId) },
        select: {
            id: true,
            tenantId: true,
            parsedResume: true,
            candidateSkills: { select: { name: true, score: true, level: true } },
        },
    });
    if (!candidate) throw Object.assign(new Error("Candidate not found"), { status: 404 });

    const effectiveTenant = tenantId ?? candidate.tenantId ?? null;
    const [aliasRows, skills] = await Promise.all([
        prisma.skillAlias.findMany({
            where: { OR: [{ tenantId: null }, { tenantId: effectiveTenant }], status: "ACTIVE" },
            select: { alias: true, skillId: true, scope: true, status: true, tenantId: true },
        }),
        prisma.skill.findMany({
            where: { OR: [{ tenantId: null }, { tenantId: effectiveTenant }] },
            select: { id: true, name: true, tenantId: true },
        }),
    ]);
    const index = buildAliasIndex(aliasRows, skills, effectiveTenant);

    const parsedItems = Array.isArray(candidate.parsedResume?.skills) ? candidate.parsedResume.skills : [];
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

    return result;
}

/**
 * Persist AI-suggested alias rows as EVIDENCE (origin 'ai-suggested'). Per
 * §7.2a the suggestion is recorded, not auto-trusted: it becomes a resolution
 * only because a row exists, and curation (retire/replace) stays with the
 * authorized tenant HR admin (§7.2b).
 */
export async function createAliasSuggestions({ suggestions, tenantId = null }) {
    if (!Array.isArray(suggestions) || !suggestions.length) return { created: 0 };
    const rows = [];
    for (const s of suggestions) {
        if (!s?.alias || !s?.skillId) continue;
        rows.push(recordAliasSuggestion({ alias: s.alias, skillId: Number(s.skillId), tenantId }));
    }
    if (!rows.length) return { created: 0 };
    const created = await prisma.$transaction(
        rows.map((row) =>
            prisma.skillAlias.upsert({
                where: { tenantId_alias: { tenantId: row.tenantId, alias: row.alias } },
                create: row,
                update: { skillId: row.skillId }, // re-pointing an existing alias is a curation act
            }),
        ),
    );
    logger.info({ count: created.length, tenantId }, "skill alias suggestions persisted");
    return { created: created.length };
}
