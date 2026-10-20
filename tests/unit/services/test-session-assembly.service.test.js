// Recruitment Phase 3b (stream I) — drawing a candidate's test: counts per
// section and difficulty (the blueprint module's rounding rule), top-up of a
// short difficulty, no repeats, exposure cap, latest version per code, the
// job family pool predicate shared with the publish-time depth check, and
// deterministic shuffles under a seeded RNG.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { makeOnsiteDb } from "./helpers/onsite-test.fake.js";

const db = makeOnsiteDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const {
    assembleItemOrder, difficultyCounts, drawSection, latestVersions, optionOrderFor, seededRng, shuffle,
} = await import("../../../src/services/test-session-assembly.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OPTIONS = ["a", "b", "c", "d"].map((id) => ({ id, text: id.toUpperCase() }));
let seq = 0;
const item = (over = {}) => {
    seq += 1;
    return {
        id: seq, tenantId: TENANT, itemCode: `C${seq}`, version: 1, status: "PUBLISHED", type: "SINGLE", difficulty: "EASY",
        competencyKey: "DOMAIN", language: "en", jobFamily: null, options: OPTIONS, exposureCount: 0, exposureCap: null,
        answerKey: "{\"optionIds\":[\"a\"]}", ...over,
    };
};

beforeEach(() => {
    for (const key of Object.keys(db.state.tables)) delete db.state.tables[key];
    seq = 0;
});

describe("difficultyCounts", () => {
    it("rounds the mix to the item count like the blueprint's pool depth check", () => {
        expect(difficultyCounts({ itemCount: 10, difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 } })).toEqual({ EASY: 3, MEDIUM: 5, HARD: 2 });
        expect(difficultyCounts({ itemCount: 7, difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 } })).toEqual({ EASY: 2, MEDIUM: 4, HARD: 1 });
        expect(difficultyCounts({ itemCount: 10 })).toEqual({ EASY: 3, MEDIUM: 5, HARD: 2 }); // the default mix
    });
});

describe("drawSection", () => {
    const section = { key: "s1", itemCount: 4, difficultyMix: { EASY: 50, MEDIUM: 50, HARD: 0 } };

    it("draws the mix, skips excluded codes and capped items, and keeps the latest version", () => {
        const pool = [
            item({ difficulty: "EASY" }), item({ difficulty: "EASY" }), item({ difficulty: "EASY", exposureCount: 3, exposureCap: 3 }),
            item({ difficulty: "MEDIUM", itemCode: "SEEN" }), item({ difficulty: "MEDIUM" }), item({ difficulty: "MEDIUM" }),
            item({ difficulty: "MEDIUM", itemCode: "C5", version: 2 }),
        ];
        expect(latestVersions(pool).find((i) => i.itemCode === "C5").version).toBe(2);
        const drawn = drawSection({ section, pool, excludeCodes: new Set(["SEEN"]), rng: seededRng(3) });
        expect(drawn).toHaveLength(4);
        expect(drawn.filter((i) => i.difficulty === "EASY")).toHaveLength(2);
        expect(drawn.map((i) => i.itemCode)).not.toContain("SEEN");
        expect(drawn.map((i) => i.id)).not.toContain(3);
        expect(drawn.filter((i) => i.itemCode === "C5").map((i) => i.version)).not.toContain(1);
    });

    it("tops a short difficulty up from the section and refuses a pool that cannot fill it", () => {
        const pool = [item({ difficulty: "EASY" }), item({ difficulty: "MEDIUM" }), item({ difficulty: "MEDIUM" }), item({ difficulty: "HARD" })];
        expect(drawSection({ section, pool, rng: seededRng(1) })).toHaveLength(4);
        expect(() => drawSection({ section, pool: pool.slice(0, 3), rng: seededRng(1) })).toThrow(
            expect.objectContaining({ status: 409, code: "HR-RECRUITMENT-TEST-POOL-TOO-SHALLOW" }),
        );
    });

    it("shuffles deterministically under a seeded RNG", () => {
        expect(shuffle([1, 2, 3, 4, 5, 6], seededRng(9))).toEqual(shuffle([1, 2, 3, 4, 5, 6], seededRng(9)));
        expect(optionOrderFor(item(), seededRng(4))).toEqual(optionOrderFor(item(), seededRng(4)));
        expect(optionOrderFor(item({ type: "TRUE_FALSE", options: [{ id: "true" }, { id: "false" }] }), seededRng(4))).toEqual(["true", "false"]);
    });
});

describe("assembleItemOrder: the pool predicate", () => {
    const blueprint = (over = {}) => ({
        language: "en",
        jobFamily: "ENG",
        sections: [{ key: "s1", competencyKey: "DOMAIN", itemCount: 3, difficultyMix: { EASY: 100, MEDIUM: 0, HARD: 0 } }],
        ...over,
    });
    const run = (bp) => mcpCtx.run({ user: { tenantId: TENANT } }, async () =>
        await assembleItemOrder(db, { tenantId: TENANT, blueprint: bp, candidateId: 5, rng: seededRng(2) }));

    it("matches the family case-insensitively, takes generic items, never another family, language or status", async () => {
        db.rows("candidateTestItem").push(
            item({ jobFamily: "eng" }), item({ jobFamily: " Eng".trim() }), item({ jobFamily: null }),
            item({ jobFamily: "OPS" }), item({ language: "ur" }), item({ status: "RETIRED" }), item({ tenantId: "22222222-2222-4222-8222-222222222222" }),
        );
        const order = await run(blueprint());
        expect(order.map((e) => e.itemId).sort()).toEqual([1, 2, 3]);
        expect(db.rows("candidateTestItem").filter((i) => i.exposureCount === 1).map((i) => i.id).sort()).toEqual([1, 2, 3]);
        expect(order[0]).toEqual(expect.objectContaining({ n: 1, itemCode: expect.any(String), itemVersion: 1, sectionKey: "s1" }));
        expect(JSON.stringify(order)).not.toContain("optionIds");
    });

    it("draws generic items only for a blueprint with no family, as the publish check counts", async () => {
        db.rows("candidateTestItem").push(item({ jobFamily: "ENG" }), item({ jobFamily: null }), item({ jobFamily: null }), item({ jobFamily: null }));
        const order = await run(blueprint({ jobFamily: null }));
        expect(order.map((e) => e.itemId)).not.toContain(1);
        expect(order).toHaveLength(3);
    });

    it("skips item codes from the candidate's earlier sessions", async () => {
        db.rows("candidateTestItem").push(item(), item(), item(), item(), item());
        db.rows("candidateTestSession").push({ id: 900, tenantId: TENANT, candidateId: 5, itemOrder: [{ n: 1, itemId: 99, itemCode: "C1" }, { n: 2, itemId: 2 }] });
        const order = await run(blueprint({ jobFamily: null }));
        // C1 by its frozen code, C2 through the item id of an older entry.
        expect(order.map((e) => e.itemCode).sort()).toEqual(["C3", "C4", "C5"]);
    });
});
