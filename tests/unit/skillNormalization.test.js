// tests/unit/skillNormalization.test.js
//
// Phase 13 / decision record §7.2–7.2b — the taxonomy rules:
//
//   * §7.2  resolution is EXACT over the alias index; fuzzy free-text matching
//           is never the source of truth. Unresolved input surfaces as
//           visibly UNMAPPED, never as a guess.
//   * §7.2a AI suggestions are evidence rows (origin ai-suggested), never
//           auto-accepted decisions; reconciliation splits mapped/unmapped.
//   * §7.2b tenant extensions shadow the platform core; another tenant's
//           extension is invisible.
//   * §7.3  the match report is advisory evidence — no overall score, no
//           ranking verb, no decision field.

import {
    aliasKey,
    buildAliasIndex,
    resolveSkill,
    reconcileParsedSkills,
    recordAliasSuggestion,
    matchCandidateToRequisition,
} from "../../src/lib/skill-normalization.util.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const aliasRows = [
    { alias: "JS", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null },
    { alias: "javascript", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null },
    { alias: "React.js", skillId: 2, scope: "PLATFORM", status: "ACTIVE", tenantId: null },
    // A tenant extension shadowing a platform alias with a DIFFERENT target:
    { alias: "JS", skillId: 9, scope: "TENANT", status: "ACTIVE", tenantId: TENANT_A },
    // A retired alias must not resolve:
    { alias: "CoffeeScript", skillId: 3, scope: "PLATFORM", status: "RETIRED", tenantId: null },
    // Another tenant's extension must be invisible:
    { alias: "InternalDash", skillId: 4, scope: "TENANT", status: "ACTIVE", tenantId: TENANT_B },
];

const skills = [
    { id: 1, name: "JavaScript", tenantId: null },
    { id: 2, name: "React", tenantId: null },
    { id: 3, name: "Python", tenantId: null },
    { id: 9, name: "Job Sequencing (tenant A meaning)", tenantId: TENANT_A },
];

function indexFor(tenantId) {
    return buildAliasIndex(aliasRows, skills, tenantId);
}

describe("skillNormalization — §7.2 exact taxonomy resolution", () => {
    test("canonical names resolve to their own id", () => {
        expect(resolveSkill(indexFor(null), "JavaScript").skillId).toBe(1);
        expect(resolveSkill(indexFor(null), "React").skillId).toBe(2);
    });

    test("aliases resolve case/whitespace-insensitively but exactly", () => {
        expect(resolveSkill(indexFor(null), "js").skillId).toBe(1);
        expect(resolveSkill(indexFor(null), "  JavaScript ").skillId).toBe(1);
        // Near-miss: fuzzy matching must NOT rescue this — §7.2.
        expect(resolveSkill(indexFor(null), "JavaScripts").skillId).toBeNull();
        expect(resolveSkill(indexFor(null), "java script").skillId).toBeNull();
    });

    test("a resolved answer carries no confidence; an unresolved one is visibly unmapped", () => {
        const miss = resolveSkill(indexFor(null), "Frobnication");
        expect(miss.skillId).toBeNull();
        expect(miss.unmapped).toBe("Frobnication");
    });

    test("RETIRED aliases do not resolve", () => {
        expect(resolveSkill(indexFor(null), "CoffeeScript").skillId).toBeNull();
    });
});

describe("skillNormalization — §7.2b tenant scope", () => {
    test("a tenant extension shadows the platform core for that tenant", () => {
        expect(resolveSkill(indexFor(TENANT_A), "JS").skillId).toBe(9);
    });

    test("the platform core still applies to other tenants and to platform context", () => {
        expect(resolveSkill(indexFor(TENANT_B), "JS").skillId).toBe(1);
        expect(resolveSkill(indexFor(null), "JS").skillId).toBe(1);
    });

    test("another tenant's extension is invisible to this tenant", () => {
        expect(resolveSkill(indexFor(TENANT_A), "InternalDash").skillId).toBeNull();
    });

    test("aliasKey normalizes spacing and case", () => {
        expect(aliasKey("  Node.JS   ")).toBe("node.js");
    });
});

describe("skillNormalization — §7.2a reconciliation", () => {
    test("splits mapped from unmapped without guessing", () => {
        const { mapped, unmapped } = reconcileParsedSkills(indexFor(null), [
            { name: "JS", score: 80, level: "Advanced" },
            { name: "React.js", score: 60, level: "Intermediate" },
            { name: "Totally New Thing", score: 40, level: "Beginner" },
        ]);
        expect(mapped).toEqual([
            { raw: "JS", skillId: 1, score: 80, level: "Advanced" },
            { raw: "React.js", skillId: 2, score: 60, level: "Intermediate" },
        ]);
        expect(unmapped).toEqual([{ raw: "Totally New Thing", score: 40, level: "Beginner" }]);
    });

    test("recordAliasSuggestion builds an evidence row, never an auto-accept", () => {
        const row = recordAliasSuggestion({ alias: "JSX", skillId: 2, tenantId: TENANT_A });
        expect(row).toEqual({
            alias: "JSX",
            skillId: 2,
            scope: "TENANT",
            origin: "ai-suggested",
            status: "ACTIVE",
            tenantId: TENANT_A,
        });
    });
});

describe("skillNormalization — §7.3 advisory matching", () => {
    const req = { required: ["JavaScript", "Kubernetes"], preferred: ["React"] };

    test("both sides resolve through the taxonomy before comparison", () => {
        const report = matchCandidateToRequisition(indexFor(null), [{ name: "JS", score: 90 }], req);
        // "JS" matched the requirement "JavaScript" — same canonical id.
        expect(report.matched).toEqual([
            { skillId: 1, canonical: true, importance: "required", score: 90, level: null },
        ]);
        // "Kubernetes" resolves nowhere → a visible unmapped miss, not a silent one.
        expect(report.missing).toContainEqual({ raw: "Kubernetes", skillId: null, importance: "required" });
        expect(report.coverage).toEqual({ requiredTotal: 2, requiredMatched: 1, preferredTotal: 1, preferredMatched: 0 });
    });

    test("preferred hits count separately from required", () => {
        const report = matchCandidateToRequisition(indexFor(null), [{ name: "React", score: 70 }], req);
        expect(report.coverage.requiredMatched).toBe(0);
        expect(report.coverage.preferredMatched).toBe(1);
    });

    test("the report is ADVISORY: no overall score, no ranking field, no decision", () => {
        const report = matchCandidateToRequisition(indexFor(null), [{ name: "JS" }], req);
        const serialized = JSON.stringify(report);
        expect(report).not.toHaveProperty("score");
        expect(report).not.toHaveProperty("overall");
        expect(report).not.toHaveProperty("rank");
        expect(report).not.toHaveProperty("decision");
        expect(serialized).not.toMatch(/recommend|verdict|suitable/i);
    });

    test("unmapped candidate items surface for curation", () => {
        const report = matchCandidateToRequisition(indexFor(null), [{ name: "JS" }, { name: "ObscureTool" }], req);
        expect(report.unmappedCandidateSkills).toEqual(["ObscureTool"]);
    });
});
