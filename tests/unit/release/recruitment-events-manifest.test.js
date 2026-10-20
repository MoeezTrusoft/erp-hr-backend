// Recruitment Phase 6 (go-live) — the Notification Hub mapping
// (src/release/recruitment-events.manifest.js) covers every recruitment and
// onboarding event the code emits, and nothing else.
//
// The test re-scans src/ (outside src/release, which only names events) for
//   * event name literals: "hr.recruitment.<name>.v1" / "hr.onboarding.<name>.v1"
//   * the on-site assessment builder: assessmentEvent("<name>", ...) builds
//     hr.recruitment.<name>.v1 (src/services/test-result.service.js)
// and fails when a name has no manifest entry, when an entry is not emitted
// anywhere, or when a new dynamic builder (`hr.recruitment.${...}`) appears
// that the scan does not understand yet.
//
// Adding an event: add its entry to the manifest ("HOW TO ADD AN EVENT").
import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    RECRUITMENT_EVENT_MANIFEST,
    RECRUITMENT_DIRECT_HUB_TEMPLATES,
    RECRUITMENT_NON_TEMPLATE_KEYS,
} from "../../../src/release/recruitment-events.manifest.js";
import { RECRUITMENT_ROLE_GRANTS } from "../../../src/release/recruitment-tools.manifest.js";
import { CANDIDATE_COMMUNICATION_TEMPLATES } from "../../../src/services/candidate-communication.templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../src");
const RELEASE = path.join(SRC, "release");

function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) return full === RELEASE ? [] : walk(full);
        return /\.(m?js)$/.test(entry) ? [full] : [];
    });
}

const files = walk(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, "utf8") }));

const EVENT_LITERAL = /["'`](hr\.(?:recruitment|onboarding)\.[a-z0-9_]+\.v1)["'`]/g;
const ASSESSMENT_BUILDER_CALL = /assessmentEvent\(\s*["']([a-z0-9_]+)["']/g;
const DYNAMIC_NAME = /`hr\.(?:recruitment|onboarding)\.\$\{/g;
// The one dynamic builder the scan understands (its names come from the
// assessmentEvent("<name>") calls above).
const KNOWN_DYNAMIC_BUILDERS = new Set(["services/test-result.service.js"]);
const TEMPLATE_LITERAL = /["'`](hr\.(?:recruitment|onboarding)\.[A-Za-z0-9_.]+)["'`]/g;

/** event name -> files that name or build it */
const emitted = new Map();
const note = (name, file) => emitted.set(name, new Set([...(emitted.get(name) ?? []), file]));
const dynamicBuilders = [];
const templateLiterals = new Map();
for (const { file, text } of files) {
    for (const [, name] of text.matchAll(EVENT_LITERAL)) note(name, file);
    for (const [, name] of text.matchAll(ASSESSMENT_BUILDER_CALL)) note(`hr.recruitment.${name}.v1`, file);
    if (DYNAMIC_NAME.test(text) && !KNOWN_DYNAMIC_BUILDERS.has(file)) dynamicBuilders.push(file);
    DYNAMIC_NAME.lastIndex = 0;
    for (const [, literal] of text.matchAll(TEMPLATE_LITERAL)) {
        if (!literal.endsWith(".v1")) templateLiterals.set(literal, file);
    }
}

const entries = Object.entries(RECRUITMENT_EVENT_MANIFEST);
const catalogue = Object.values(CANDIDATE_COMMUNICATION_TEMPLATES);
const catalogueTemplateIds = new Set(catalogue.map((t) => t.hubTemplateId));
const RECIPIENT = /^(field:[A-Za-z]+|resolve:[A-Za-z]+\.[A-Za-z.]+|role:[A-Z_]+|approvalRole:[A-Za-z]+|candidate)$/;

describe("recruitment events release manifest: coverage", () => {
    it("the scan finds the event surface (sanity)", () => {
        expect(emitted.size).toBeGreaterThan(90);
        expect(emitted.has("hr.recruitment.test_result_recorded.v1")).toBe(true); // via the builder
        expect(emitted.has("hr.onboarding.readiness_at_risk.v1")).toBe(true);
    });

    it("every emitted recruitment and onboarding event has an entry", () => {
        const missing = [...emitted.keys()].filter((name) => !(name in RECRUITMENT_EVENT_MANIFEST)).sort();
        expect(missing).toEqual([]);
    });

    it("every entry is an event the code emits", () => {
        const stale = entries.map(([name]) => name).filter((name) => !emitted.has(name));
        expect(stale).toEqual([]);
    });

    it("no event name is built in a way the scan cannot read", () => {
        expect(dynamicBuilders).toEqual([]);
    });
});

describe("recruitment events release manifest: entries", () => {
    it("each entry either notifies through routes or says why it does not", () => {
        for (const [name, entry] of entries) {
            if (entry.notify === false) {
                expect({ name, reason: typeof entry.reason }).toEqual({ name, reason: "string" });
                expect(entry.reason.length).toBeGreaterThan(10);
                continue;
            }
            expect(entry.notify).toBe(true);
            expect(entry.routes.length).toBeGreaterThan(0);
            for (const route of entry.routes) {
                expect(route.recipient.length).toBeGreaterThan(0);
                for (const r of route.recipient) expect({ name, r, ok: RECIPIENT.test(r) }).toEqual({ name, r, ok: true });
                expect(["in-app", "email", "in-app+email"]).toContain(route.channel);
                expect(route.template).toMatch(/^hr\.(recruitment|onboarding)\.[a-z0-9_]+$/);
                expect(typeof route.candidateFacing).toBe("boolean");
                expect(["first", "all"]).toContain(route.mode);
            }
        }
    });

    it("candidate routes go through the candidate-communication module only", () => {
        for (const [name, entry] of entries) {
            for (const route of entry.routes ?? []) {
                const toCandidate = route.recipient.includes("candidate");
                expect({ name, candidateFacing: route.candidateFacing }).toEqual({ name, candidateFacing: toCandidate });
                if (toCandidate) {
                    expect(route.recipient).toEqual(["candidate"]);
                    expect(route.channel).toBe("email");
                }
            }
        }
    });

    it("role recipients are roles of the RBAC role table", () => {
        for (const [, entry] of entries) {
            for (const route of entry.routes ?? []) {
                for (const r of route.recipient.filter((x) => x.startsWith("role:"))) {
                    expect(Object.keys(RECRUITMENT_ROLE_GRANTS)).toContain(r.slice("role:".length));
                }
            }
        }
    });

    it("payload keys named by a recipient appear where the event is built", () => {
        const problems = [];
        const textOf = new Map(files.map((f) => [f.file, f.text]));
        for (const [name, entry] of entries) {
            const sources = [...(emitted.get(name) ?? [])].map((f) => textOf.get(f)).join("\n");
            // The assessment events' payloads are built at the call sites.
            for (const route of entry.routes ?? []) {
                for (const r of route.recipient) {
                    const m = /^(?:field|approvalRole):([A-Za-z]+)$|^resolve:([A-Za-z]+)\./.exec(r);
                    const key = m?.[1] ?? m?.[2];
                    if (key && !new RegExp(`\\b${key}\\b`).test(sources)) problems.push(`${name}: ${r} (no "${key}" where the event is built)`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});

describe("recruitment events release manifest: candidate-communication catalogue", () => {
    it("every event the catalogue maps has a candidate route with that template", () => {
        const problems = [];
        for (const template of catalogue) {
            for (const event of template.events) {
                const entry = RECRUITMENT_EVENT_MANIFEST[event];
                const routes = (entry?.routes ?? []).filter((r) => r.candidateFacing);
                if (!routes.some((r) => r.template === template.hubTemplateId)) problems.push(`${event} -> ${template.hubTemplateId}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it("every candidate route is a catalogue template for that event (or is marked pending)", () => {
        const problems = [];
        for (const [name, entry] of entries) {
            for (const route of (entry.routes ?? []).filter((r) => r.candidateFacing)) {
                const mapped = catalogue.some((t) => t.hubTemplateId === route.template && t.events.includes(name));
                if (!mapped && !route.pending) problems.push(`${name} -> ${route.template}`);
                if (mapped && route.pending) problems.push(`${name} -> ${route.template} is built: drop "pending"`);
            }
        }
        expect(problems).toEqual([]);
    });
});

describe("recruitment hub templates sent directly", () => {
    it("every hub template literal in src/ is a catalogue template, a direct template or a known non-template key", () => {
        const unknown = [...templateLiterals.keys()].filter((literal) =>
            !catalogueTemplateIds.has(literal)
            && !(literal in RECRUITMENT_DIRECT_HUB_TEMPLATES)
            && !(literal in RECRUITMENT_NON_TEMPLATE_KEYS)).sort();
        expect(unknown).toEqual([]);
    });

    it("every direct template and non-template key is still in src/", () => {
        const stale = [...Object.keys(RECRUITMENT_DIRECT_HUB_TEMPLATES), ...Object.keys(RECRUITMENT_NON_TEMPLATE_KEYS)]
            .filter((t) => !templateLiterals.has(t));
        expect(stale).toEqual([]);
    });
});
