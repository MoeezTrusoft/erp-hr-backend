// src/services/test-session-assembly.service.js
//
// Phase 3b — drawing one candidate's test (plan 7.3.4 "Assembly").
//
// When the kiosk starts a session the server draws, per blueprint section and
// per difficulty, from the PUBLISHED items of the section's competency in the
// blueprint's language whose job family is the blueprint's (case-insensitive)
// or none: a generic item fits any family, and a blueprint with no family
// draws generic items only. This is the same pool the publish-time depth
// check counts (test-blueprint.service.js), so a published blueprint can
// always be drawn. The rules:
//
//   * NO REPEATS. An item code the candidate saw in any earlier session is
//     never drawn again, whatever version is now published.
//   * EXPOSURE. Each drawn item's exposureCount is incremented in the same
//     transaction; an item at its exposureCap is not drawn.
//   * EQUIVALENT DIFFICULTY. The section's difficultyMix (percentages, rounded
//     to the item count by test-blueprint.util's rule) fixes how many
//     EASY / MEDIUM / HARD items are drawn. A difficulty whose pool is short
//     is topped up from the section's other difficulties; a section that still
//     cannot be filled refuses the start (409), because a shorter test would
//     not be equivalent.
//   * FROZEN. Each drawn entry records the item version row (itemId, which a
//     published version never changes), the item code, the section and the
//     per-candidate option order, so scoring and the report see exactly what
//     the candidate saw. The kiosk later adds servedAt to an entry; nothing
//     else changes.
//
// The answer key is never selected here.
import { randomInt } from "node:crypto";

import { withTenant } from "../lib/tenancy.js";
import {
    DEFAULT_DIFFICULTY_MIX,
    DIFFICULTIES,
    difficultyCounts as blueprintDifficultyCounts,
    normalizeJobFamily,
} from "../lib/test-blueprint.util.js";

// Item types whose option order carries meaning or that have no options.
const UNSHUFFLED_TYPES = Object.freeze(["TRUE_FALSE", "NUMERIC"]);

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/** The production RNG: uniform in [0, 1) from the crypto source. */
export const cryptoRng = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** A deterministic RNG (mulberry32) for tests and previews. */
export function seededRng(seed = 1) {
    let a = Number(seed) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates on a copy. */
export function shuffle(list, rng = cryptoRng) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * How many items of each difficulty a section draws: the blueprint module's
 * rounding rule (stream H), so the publish-time pool depth check and this
 * draw always plan the same counts.
 * @returns {{ EASY:number, MEDIUM:number, HARD:number }}
 */
export function difficultyCounts(section) {
    const total = Math.max(0, Math.floor(Number(section?.itemCount) || 0));
    return blueprintDifficultyCounts(total, section?.difficultyMix ?? DEFAULT_DIFFICULTY_MIX);
}

/** Keep only the highest published version of each item code. */
export function latestVersions(pool) {
    const byCode = new Map();
    for (const item of pool) {
        const held = byCode.get(item.itemCode);
        if (!held || item.version > held.version) byCode.set(item.itemCode, item);
    }
    return [...byCode.values()].sort((a, b) => a.id - b.id);
}

const underCap = (item) => item.exposureCap === null || item.exposureCap === undefined || item.exposureCount < item.exposureCap;

/**
 * Draw one section from its pool. Pure.
 * @param {object} args
 * @param {object} args.section    blueprint section
 * @param {Array}  args.pool       PUBLISHED items of the section's competency
 * @param {Set<string>} args.excludeCodes  item codes seen before or already drawn
 * @param {Function} args.rng
 * @returns {Array} the drawn items, shuffled
 */
export function drawSection({ section, pool, excludeCodes = new Set(), rng = cryptoRng }) {
    const eligible = latestVersions(pool).filter((item) => !excludeCodes.has(item.itemCode) && underCap(item));
    const counts = difficultyCounts(section);
    const taken = new Set();
    const picked = [];
    const take = (candidates, n) => {
        for (const item of shuffle(candidates.filter((c) => !taken.has(c.id)), rng).slice(0, n)) {
            taken.add(item.id);
            picked.push(item);
        }
    };
    let short = 0;
    for (const difficulty of DIFFICULTIES) {
        const want = counts[difficulty];
        if (!want) continue;
        const before = picked.length;
        take(eligible.filter((item) => item.difficulty === difficulty), want);
        short += want - (picked.length - before);
    }
    // A short difficulty is topped up from whatever is left in the section.
    if (short > 0) take(eligible, short);
    const needed = DIFFICULTIES.reduce((a, d) => a + counts[d], 0);
    if (picked.length < needed) {
        throw fail(
            `Section "${section?.label ?? section?.key}" has too few eligible items to draw ${needed}`,
            409,
            "HR-RECRUITMENT-TEST-POOL-TOO-SHALLOW",
        );
    }
    return shuffle(picked, rng);
}

/** A candidate's own option order for one item. */
export function optionOrderFor(item, rng = cryptoRng) {
    const ids = Array.isArray(item?.options) ? item.options.map((o) => String(o?.id)) : [];
    if (UNSHUFFLED_TYPES.includes(item?.type)) return ids;
    return shuffle(ids, rng);
}

/** Item codes in earlier sessions' frozen orders. */
async function seenItemCodes(tx, { tenantId, candidateId, sessionId }) {
    const earlier = await tx.candidateTestSession.findMany({
        where: withTenant(tenantId, { candidateId, id: { not: sessionId ?? 0 } }),
        select: { itemOrder: true },
    });
    const codes = new Set();
    const idsWithoutCode = [];
    for (const session of earlier) {
        for (const entry of Array.isArray(session.itemOrder) ? session.itemOrder : []) {
            if (entry?.itemCode) codes.add(String(entry.itemCode));
            else if (entry?.itemId) idsWithoutCode.push(Number(entry.itemId));
        }
    }
    if (idsWithoutCode.length) {
        const rows = await tx.candidateTestItem.findMany({
            where: withTenant(tenantId, { id: { in: idsWithoutCode } }),
            select: { itemCode: true },
        });
        for (const row of rows) codes.add(String(row.itemCode));
    }
    return codes;
}

/**
 * Draw the test for one session on the caller's transaction and count the
 * exposure. Returns the itemOrder to freeze on the session.
 *
 * @param {object} tx  tenant transaction client
 * @param {{ tenantId: string, blueprint: object, candidateId: number, sessionId?: number, rng?: Function }} args
 * @returns {Promise<Array<{ n, itemId, itemCode, itemVersion, sectionKey, optionOrder }>>}
 */
export async function assembleItemOrder(tx, { tenantId, blueprint, candidateId, sessionId = null, rng = cryptoRng }) {
    const sections = Array.isArray(blueprint?.sections) ? blueprint.sections : [];
    if (!sections.length) throw fail("The test blueprint has no sections", 409, "HR-RECRUITMENT-TEST-BLUEPRINT-EMPTY");
    const family = normalizeJobFamily(blueprint.jobFamily);
    const competencies = [...new Set(sections.map((s) => String(s.competencyKey ?? "")).filter(Boolean))];

    const pool = await tx.candidateTestItem.findMany({
        where: withTenant(tenantId, {
            status: "PUBLISHED",
            language: blueprint.language ?? "en",
            competencyKey: { in: competencies },
            // The publish-time pool predicate (test-blueprint.service.js
            // itemPoolWhere): a generic item (no family) fits any blueprint;
            // a family item only its own family, compared case-insensitively
            // because blueprints store families upper-cased and items as typed.
            OR: family ? [{ jobFamily: null }, { jobFamily: { equals: family, mode: "insensitive" } }] : [{ jobFamily: null }],
        }),
        // Never the answer key or rationale.
        select: {
            id: true, itemCode: true, version: true, type: true, difficulty: true,
            competencyKey: true, options: true, exposureCount: true, exposureCap: true,
        },
    });

    const exclude = await seenItemCodes(tx, { tenantId, candidateId, sessionId });
    const entries = [];
    for (const section of sections) {
        const drawn = drawSection({
            section,
            pool: pool.filter((item) => item.competencyKey === section.competencyKey),
            excludeCodes: exclude,
            rng,
        });
        for (const item of drawn) {
            exclude.add(item.itemCode); // one item code once per test
            entries.push({
                n: entries.length + 1,
                itemId: item.id,
                itemCode: item.itemCode,
                itemVersion: item.version,
                sectionKey: String(section.key),
                optionOrder: optionOrderFor(item, rng),
            });
        }
    }

    if (entries.length) {
        await tx.candidateTestItem.updateMany({
            where: withTenant(tenantId, { id: { in: entries.map((e) => e.itemId) } }),
            data: { exposureCount: { increment: 1 } },
        });
    }
    return entries;
}

export { DIFFICULTIES };

export default { assembleItemOrder, drawSection, difficultyCounts, optionOrderFor, seededRng, shuffle };
