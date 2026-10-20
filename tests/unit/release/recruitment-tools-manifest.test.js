// Recruitment Phase 6 (go-live) — the release manifest of the recruitment MCP
// tools (src/release/recruitment-tools.manifest.js) is DERIVED, not trusted.
//
// For every registrar the manifest lists, the test registers it on a capturing
// server and calls every handler under mcpCtx as a caller with NO permissions.
// Every recruitment tool checks its grant first, so the refusal names the gate:
// "Insufficient permissions: <resource>:<action>". The test then:
//   * grants exactly that key and checks the refusal is gone (the gate is that
//     key, not something the message merely mentions);
//   * grants each other known resource alone (same action) and checks the tool
//     still refuses, unless the entry declares it in `alsoAccepts`.
// Prisma is a proxy that rejects every query and the logger is silent, so a
// handler that passes its gate stops at its first query: nothing is written
// and nothing leaves the process. Every recruitment flag is switched on so a
// flag check placed before the permission would show up as a different error.
//
// It also checks that the manifest covers every recruitment-named tool in the
// full HR registry, and that the role table (RBAC keys per role) is coherent
// with the tools and with the row-scope library.
//
// Adding a tool: add its entry to the manifest (header there, "HOW TO ADD A
// TOOL"); this test names what is missing or wrong.
import { jest, describe, it, expect, beforeAll } from "@jest/globals";
import pino from "pino";

const NO_DB = "NO-DB: the release manifest test has no database";
function rejectingDb() {
    const reject = () => Promise.reject(Object.assign(new Error(NO_DB), { status: 599 }));
    // Every property is another proxy and every call rejects, so any query
    // shape (prisma.x.findMany, prisma.$transaction, tx.y.update) fails fast.
    return new Proxy(reject, {
        get: (_target, prop) => (prop === "then" ? undefined : rejectingDb()),
        apply: () => reject(),
    });
}

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: rejectingDb() }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: pino({ level: "silent" }) }));

const { RECRUITMENT_FLAG_DEFINITIONS } = await import("../../../src/lib/recruitmentFlags.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { registerAllTools } = await import("../../../src/mcp/toolRegistry.js");
const manifest = await import("../../../src/release/recruitment-tools.manifest.js");
const {
    RECRUITMENT_TOOL_GROUPS,
    RECRUITMENT_TOOL_MANIFEST,
    RECRUITMENT_RESOURCES,
    RECRUITMENT_ROLE_GRANTS,
    RECRUITMENT_REST_ONLY_RESOURCES,
    RBAC_ACTIONS,
    rbacScopeKey,
    recruitmentGatewayToolMap,
    recruitmentRoleScopes,
    RECRUITMENT_LEGACY_TOOLS,
    RECRUITMENT_TOOL_NAME_PATTERN,
} = manifest;
const NOT_IN_RECRUITMENT_RELEASE = new Set(RECRUITMENT_LEGACY_TOOLS);

const KNOWN_RESOURCES = Object.values(RECRUITMENT_RESOURCES);
const INSUFFICIENT = /^Insufficient permissions: ([a-z_:.]+):([A-Z]+)$/;
const TENANT = "00000000-0000-4000-8000-0000000000e6";

for (const def of Object.values(RECRUITMENT_FLAG_DEFINITIONS)) process.env[def.env] = "true";

function capture(register) {
    const tools = new Map();
    const take = (name, ...rest) => tools.set(name, rest.at(-1));
    register({ tool: take, registerTool: take, resource: () => {} });
    return tools;
}

/** The handler's refusal text for a caller holding exactly `scopes`. */
async function refusalFor(handler, scopes) {
    const ctx = {
        user: { userId: "release-manifest", tenantId: TENANT, roles: [], employeeId: null, isAdmin: false },
        permissions: scopes,
        actorVerified: true,
    };
    let timer;
    try {
        const result = await mcpCtx.run(ctx, async () => await Promise.race([
            handler({}),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("TIMEOUT")), 2000); }),
        ]));
        if (!result?.isError) return "OK";
        return String(JSON.parse(result.content[0].text).error ?? "");
    } catch (err) {
        return `THROW ${err?.message}`;
    } finally {
        clearTimeout(timer);
    }
}

// name -> { first, granted, alternatives: { resource: refusal } }
const observed = new Map();
const registered = new Map(); // module -> Set(names)
const missingRegistrar = [];

beforeAll(async () => {
    for (const group of RECRUITMENT_TOOL_GROUPS) {
        const mod = await import(`../../../src/mcp/tools/${group.module}.js`);
        if (typeof mod[group.registrar] !== "function") {
            missingRegistrar.push(`${group.module}.${group.registrar}`);
            continue;
        }
        const tools = capture(mod[group.registrar]);
        registered.set(group.module, new Set(tools.keys()));
        for (const [name, handler] of tools) {
            const first = await refusalFor(handler, []);
            const gate = INSUFFICIENT.exec(first);
            const entry = { first, gate: gate ? { resource: gate[1], action: gate[2] } : null, granted: null, alternatives: {} };
            if (gate) {
                entry.granted = await refusalFor(handler, [rbacScopeKey(gate[1], gate[2])]);
                for (const resource of KNOWN_RESOURCES) {
                    if (resource === gate[1]) continue;
                    entry.alternatives[resource] = await refusalFor(handler, [rbacScopeKey(resource, gate[2])]);
                }
            }
            observed.set(name, entry);
        }
    }
}, 120000);

describe("recruitment tools release manifest: derived from the handlers", () => {
    it("names only registrars that exist", () => {
        expect(missingRegistrar).toEqual([]);
    });

    it("lists every tool each registrar registers, and nothing it does not", () => {
        const problems = [];
        for (const group of RECRUITMENT_TOOL_GROUPS) {
            const actual = registered.get(group.module) ?? new Set();
            const listed = new Set(group.tools.map((t) => t.name));
            for (const name of actual) if (!listed.has(name)) problems.push(`${name} (registered by ${group.module}) has no manifest entry`);
            for (const name of listed) if (!actual.has(name)) problems.push(`${name} is in the manifest but ${group.module} does not register it`);
        }
        expect(problems).toEqual([]);
    });

    it("has one entry per tool name", () => {
        const names = RECRUITMENT_TOOL_MANIFEST.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("every entry's resource and action are the gate the tool asserts first", () => {
        const problems = [];
        for (const t of RECRUITMENT_TOOL_MANIFEST) {
            const seen = observed.get(t.name);
            if (!seen) continue; // reported by the membership test
            if (!seen.gate) problems.push(`${t.name}: first check is not a permission (${seen.first}); give it an explicit entry and a comment`);
            else if (seen.gate.resource !== t.resource || seen.gate.action !== t.action) {
                problems.push(`${t.name}: manifest says ${t.resource}:${t.action}, the tool asserts ${seen.gate.resource}:${seen.gate.action}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it("granting exactly the manifest key gets every tool past its gate", () => {
        const problems = [];
        for (const t of RECRUITMENT_TOOL_MANIFEST) {
            const seen = observed.get(t.name);
            if (!seen?.gate) continue;
            if (INSUFFICIENT.test(seen.granted)) problems.push(`${t.name}: still refused with ${rbacScopeKey(t.resource, t.action)} (${seen.granted})`);
        }
        expect(problems).toEqual([]);
    });

    it("no other resource opens a tool unless the entry says alsoAccepts", () => {
        const problems = [];
        for (const t of RECRUITMENT_TOOL_MANIFEST) {
            const seen = observed.get(t.name);
            if (!seen?.gate) continue;
            const accepts = new Set(t.alsoAccepts ?? []);
            for (const [resource, refusal] of Object.entries(seen.alternatives)) {
                const opens = refusal !== seen.first;
                if (opens && !accepts.has(resource)) problems.push(`${t.name}: ${resource} alone gets past the gate (${refusal}); declare alsoAccepts or fix the tool`);
                if (!opens && accepts.has(resource)) problems.push(`${t.name}: declares alsoAccepts ${resource} but the tool refuses it`);
            }
        }
        expect(problems).toEqual([]);
    });

    it("covers every recruitment-named tool in the HR registry", () => {
        const all = [];
        registerAllTools({ tool: (n) => all.push(n), registerTool: (n) => all.push(n), resource: () => {} });
        const listed = new Set(RECRUITMENT_TOOL_MANIFEST.map((t) => t.name));
        const uncovered = all.filter((n) => RECRUITMENT_TOOL_NAME_PATTERN.test(n) && !listed.has(n) && !NOT_IN_RECRUITMENT_RELEASE.has(n));
        expect(uncovered).toEqual([]);
        for (const name of listed) expect(all).toContain(name);
    });
});

describe("recruitment tools release manifest: shapes the other owners load", () => {
    it("uses only known resources and METHOD_ACTION verbs", () => {
        for (const t of RECRUITMENT_TOOL_MANIFEST) {
            expect(KNOWN_RESOURCES).toContain(t.resource);
            expect(["VIEW", "CREATE", "EDIT", "DELETE"]).toContain(t.action);
            for (const alt of t.alsoAccepts ?? []) expect(KNOWN_RESOURCES).toContain(alt);
        }
    });

    it("gateway map has an entry per tool with the canonical RBAC key", () => {
        const map = recruitmentGatewayToolMap();
        expect(Object.keys(map)).toHaveLength(RECRUITMENT_TOOL_MANIFEST.length);
        expect(map.hr_requisitions_list).toEqual({ resource: "hr:recruitment", action: "VIEW", scope: "hr.recruitment.read" });
        expect(map.hr_recruitment_agency_portal_submit.scope).toBe("hr.recruitment_agency.create");
        expect(map.hr_self_internal_jobs_list.scope).toBe("hr.self.read");
    });

    it("rbacScopeKey matches the canonical form hasPermission accepts", async () => {
        const { hasPermission } = await import("../../../src/lib/assertPermission.js");
        for (const resource of KNOWN_RESOURCES) {
            for (const action of ["VIEW", "CREATE", "EDIT", "DELETE", "EXPORT"]) {
                expect(hasPermission([rbacScopeKey(resource, action)], resource, action)).toBe(true);
            }
        }
        expect(() => rbacScopeKey(manifest.RECRUITMENT_RESOURCES.RECRUITMENT, "APPROVE")).toThrow();
    });
});

describe("recruitment RBAC role table", () => {
    const roles = Object.entries(RECRUITMENT_ROLE_GRANTS);
    const held = (def, resource, action) => def.grants.some((g) => g.resource === resource && g.actions.includes(action));
    const toolByName = new Map(RECRUITMENT_TOOL_MANIFEST.map((t) => [t.name, t]));
    const reaches = (def, t) => held(def, t.resource, t.action) || (t.alsoAccepts ?? []).some((r) => held(def, r, t.action));

    it("grants only known resources (or the REST-only ones) and RBAC verbs", () => {
        for (const [, def] of roles) {
            for (const g of def.grants) {
                expect([...KNOWN_RESOURCES, ...RECRUITMENT_REST_ONLY_RESOURCES]).toContain(g.resource);
                for (const a of g.actions) expect(RBAC_ACTIONS).toContain(a);
            }
        }
    });

    it("every role reaches the tools the access matrix gives it", () => {
        const problems = [];
        for (const [name, def] of roles) {
            for (const toolName of def.uses) {
                const t = toolByName.get(toolName);
                if (!t) problems.push(`${name}: uses ${toolName}, which is not in the manifest`);
                else if (!reaches(def, t)) problems.push(`${name}: cannot call ${toolName} (needs ${t.resource}:${t.action})`);
            }
        }
        expect(problems).toEqual([]);
    });

    it("no tool is left that no role can call", () => {
        const orphans = RECRUITMENT_TOOL_MANIFEST.filter((t) => !roles.some(([, def]) => reaches(def, t))).map((t) => t.name);
        expect(orphans).toEqual([]);
    });

    it("no role holds a grant it must not hold", () => {
        const problems = [];
        for (const [name, def] of roles) {
            for (const g of def.mustNotHold) {
                for (const a of g.actions) if (held(def, g.resource, a)) problems.push(`${name} holds ${g.resource}:${a}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it("each role's claims resolve to its declared row scope (with an employee id)", () => {
        for (const [, def] of roles) {
            for (const claim of def.claims) {
                const level = resolveRecruitmentScope({ roles: [claim], employeeId: 4242, tenantId: TENANT }).level;
                // scope null = not a recruitment role: the library falls back
                // to ORG for it, which is why such a role holds no hr:recruitment.
                expect({ claim, level }).toEqual({ claim, level: def.scope ?? "ORG" });
            }
        }
    });

    it("a role outside the recruitment vocabulary never holds hr:recruitment (it would read the whole tenant)", () => {
        for (const [, def] of roles.filter(([, d]) => d.scope === null)) {
            expect(def.grants.some((g) => g.resource === RECRUITMENT_RESOURCES.RECRUITMENT)).toBe(false);
        }
    });

    it("MANAGED and ASSIGNED claims need the employeeId claim, or they resolve to ORG", () => {
        // Pinned so the runbook's "mint employeeId for every staff login" stays true.
        expect(resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], tenantId: TENANT }).level).toBe("ORG");
        expect(resolveRecruitmentScope({ roles: ["INTERVIEWER"], tenantId: TENANT }).level).toBe("ORG");
    });

    it("agency logins hold only hr:recruitment_agency", () => {
        expect(recruitmentRoleScopes("AGENCY")).toEqual(["hr.recruitment_agency.read", "hr.recruitment_agency.create"]);
        expect(() => recruitmentRoleScopes("NOBODY")).toThrow();
    });
});
