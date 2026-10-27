// Recruitment Phase 6 (go-live) — scripts/RECRUITMENT-GOLIVE.runbook.md stays
// true to the code: every recruitment flag is placed exactly once in the flag
// order, every alert in the rules files is described, and every repository
// file the checklist cites exists.
import { describe, it, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

import { RECRUITMENT_FLAG_DEFINITIONS } from "../../../src/lib/recruitment-flags.util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const runbook = readFileSync(path.join(ROOT, "scripts/RECRUITMENT-GOLIVE.runbook.md"), "utf8");
const section = (n) => {
    const start = runbook.indexOf(`\n## ${n}. `);
    const end = runbook.indexOf(`\n## ${n + 1}. `);
    return runbook.slice(start, end === -1 ? undefined : end);
};
const load = yaml.safeLoad ?? yaml.load;

describe("recruitment go-live runbook", () => {
    it("places every recruitment flag exactly once in the flag order", () => {
        // The flag column of the stage tables: | <order> | `<ENV>` | notes |
        const placed = [...section(1).matchAll(/^\|\s*\d+\.\d+\s*\|\s*`([A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);
        const envs = Object.values(RECRUITMENT_FLAG_DEFINITIONS).map((d) => d.env);
        expect([...placed].sort()).toEqual([...envs].sort());
        expect(new Set(placed).size).toBe(placed.length);
    });

    it("keeps the plan's stage order with retention last", () => {
        const stages = [...section(1).matchAll(/^### Stage (\d): (.+)$/gm)].map((m) => `${m[1]} ${m[2].trim()}`);
        expect(stages).toEqual(["0 security (no flag)", "1 workflow", "2 offer handoff", "3 portal", "4 analytics", "5 AI", "6 retention, last and per tenant"]);
    });

    it("describes every alert of every rules file", () => {
        const dir = path.join(ROOT, "observability/alerts");
        const alerts = readdirSync(dir)
            .filter((f) => f.endsWith(".rules.yml"))
            .flatMap((f) => load(readFileSync(path.join(dir, f), "utf8")).groups.flatMap((g) => g.rules))
            .filter((r) => r.alert)
            .map((r) => r.alert);
        expect(alerts.length).toBeGreaterThan(0);
        for (const alert of alerts) expect(section(3)).toContain(`\`${alert}\``);
    });

    it("cites only files that exist", () => {
        const cited = [...runbook.matchAll(/`((?:tests|scripts|src|observability)\/[A-Za-z0-9_./*-]+)`/g)].map((m) => m[1]);
        expect(cited.length).toBeGreaterThan(10);
        const missing = cited.filter((p) => !p.includes("*") && !existsSync(path.join(ROOT, p)));
        expect(missing).toEqual([]);
    });
});
