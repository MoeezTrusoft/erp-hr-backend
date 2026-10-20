// Recruitment Phase 4 (stream M) — the failed-handoff alerting rules parse,
// and every expression names the metric and the outcome label the code
// actually records (recruitmentOpsMetrics.js), so a rename cannot silently
// leave the page wired to a series that no longer exists.
import { describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import client from "prom-client";
import yaml from "js-yaml";
import {
    HANDOFF_METRIC,
    recordHandoff,
    _resetRecruitmentOpsMetricsForTests,
} from "../../../src/lib/recruitmentOpsMetrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(here, "../../../observability/alerts/recruitment-onboarding.rules.yml");
const text = readFileSync(RULES_PATH, "utf8");
const load = yaml.safeLoad ?? yaml.load;
const doc = load(text);
const rules = doc.groups.flatMap((g) => g.rules);

describe("recruitment onboarding alert rules", () => {
    beforeEach(() => _resetRecruitmentOpsMetricsForTests());

    it("is a Prometheus rule file with named groups of alerting rules", () => {
        expect(Array.isArray(doc.groups)).toBe(true);
        for (const group of doc.groups) {
            expect(typeof group.name).toBe("string");
            expect(Array.isArray(group.rules)).toBe(true);
        }
        for (const rule of rules) {
            expect(rule.alert).toMatch(/^[A-Za-z][A-Za-z0-9]+$/);
            expect(typeof rule.expr).toBe("string");
            expect(rule.labels.severity).toBe("page");
            expect(typeof rule.annotations.summary).toBe("string");
        }
    });

    it("pages on any handoff failure within 15 minutes", () => {
        const page = rules.find((r) => r.alert === "HrRecruitmentHandoffFailed");
        expect(page).toBeDefined();
        expect(page.expr.replace(/\s+/g, "")).toBe(`sum(increase(${HANDOFF_METRIC}{outcome="failed"}[15m]))>0`);
        expect(page.for ?? "0m").toBe("0m");
    });

    it("every expression names the real metric and its failed outcome", async () => {
        // The series the code records, read from the registry.
        recordHandoff("failed");
        const exposed = await client.register.getSingleMetricAsString(HANDOFF_METRIC);
        expect(exposed).toContain(`${HANDOFF_METRIC}{outcome="failed"} 1`);
        for (const rule of rules) {
            const selectors = [...rule.expr.matchAll(/([a-z_:][a-z0-9_:]*)\{([^}]*)\}/g)];
            expect(selectors.length).toBeGreaterThan(0);
            for (const [, name, labels] of selectors) {
                expect(name).toBe(HANDOFF_METRIC);
                expect(labels.trim()).toBe('outcome="failed"');
            }
        }
    });

    it("the runbook points at the handoff operator tools", () => {
        for (const rule of rules) {
            expect(rule.annotations.runbook).toContain("hr_offer_handoffs_failed_list");
            expect(rule.annotations.runbook).toContain("hr_offer_handoff_retry");
        }
    });
});
