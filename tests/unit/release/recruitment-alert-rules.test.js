// Recruitment Phase 6 (go-live) — every Prometheus rules file under
// observability/alerts/ parses, and every metric and label value its
// expressions use is one the code actually records. A rename in
// src/lib/recruitment-ops-metrics.util.js (or a label value its allowlist collapses
// to "other") would otherwise leave an alert wired to a series that never moves.
//
// js-yaml is only a transitive dependency today (as in the Phase 4 rules
// test); p6-notes/E.md asks for it as a devDependency.
import { describe, it, expect, beforeEach } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import client from "prom-client";
import yaml from "js-yaml";

import * as ops from "../../../src/lib/recruitment-ops-metrics.util.js";
import * as auth from "../../../src/lib/authMetrics.js";
import * as http from "../../../src/lib/httpMetrics.js";
import { RECRUITMENT_TOOL_MANIFEST } from "../../../src/release/recruitment-tools.manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_DIR = path.resolve(here, "../../../observability/alerts");
const load = yaml.safeLoad ?? yaml.load;

const ruleFiles = readdirSync(ALERTS_DIR)
    .filter((f) => f.endsWith(".rules.yml"))
    .map((file) => ({ file, doc: load(readFileSync(path.join(ALERTS_DIR, file), "utf8")) }));
const rules = ruleFiles.flatMap(({ file, doc }) => doc.groups.flatMap((g) => g.rules.map((rule) => ({ file, group: g.name, ...rule }))));
const alerts = rules.filter((r) => r.alert);
const recorded = new Set(rules.filter((r) => r.record).map((r) => r.record));

// Metric names the code exports (the *_METRIC constants of the metric modules).
const metricNames = new Set(
    [ops, auth, http].flatMap((mod) => Object.entries(mod).filter(([k, v]) => k.endsWith("_METRIC") && typeof v === "string").map(([, v]) => v)),
);
const HISTOGRAM_SUFFIX = /_(bucket|sum|count)$/;

// How to produce one sample of a recruitment ops counter with given labels,
// so the test can see whether a label value survives the allowlist.
const RECORDERS = {
    [ops.HANDOFF_METRIC]: (l) => ops.recordHandoff(l.outcome ?? "failed"),
    [ops.RETENTION_METRIC]: (l) => ops.recordRetentionRun(l.outcome ?? "dry-run"),
    [ops.NOTIFICATION_METRIC]: (l) => ops.recordRecruitmentNotification(l.event ?? "offer_sent", l.outcome ?? "enqueued"),
    [ops.EXPORTS_METRIC]: (l) => ops.recordExport(l.format ?? "csv", l.outcome ?? "ok"),
    [ops.RESUME_PARSE_METRIC]: (l) => ops.recordResumeParse({ kind: l.kind ?? "CANDIDATE", outcome: l.outcome ?? "ok" }),
    [ops.DENIALS_METRIC]: (l) => ops.recordDenial(l.code ?? "HR-4030"),
    [ops.TRANSITION_FAILURES_METRIC]: (l) => ops.recordTransitionFailure(l.code ?? "HR-RECRUITMENT-TEST"),
};

// Label values the rules already use but the code's allowlist does not accept
// YET. The lead applies the NOTIFY_EVENTS diff in p6-notes/E.md section 6 and
// then deletes these lines (the last test fails until they are deleted).
const PENDING_LABEL_VALUES = Object.freeze({});
const isPending = (metric, label, value) => PENDING_LABEL_VALUES[metric]?.[label]?.includes(value) === true;

/** [{ name, labels: {k: v} }] for every metric selector in an expression. */
function selectors(expr) {
    const found = [];
    const withBraces = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^}]*)\}/g;
    for (const [, name, body] of expr.matchAll(withBraces)) {
        const labels = {};
        for (const [, k, op, v] of body.matchAll(/([a-zA-Z_]+)\s*(=~|!=|!~|=)\s*"([^"]*)"/g)) if (op === "=") labels[k] = v;
        found.push({ name, labels });
    }
    const bare = expr.replace(withBraces, " ").replace(/\b(by|without)\s*\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
    for (const [name] of bare.matchAll(/\b(?:hr_[a-z0-9_]+|[a-z_]+:[a-z0-9_:]+)\b/g)) found.push({ name, labels: {} });
    return found;
}

describe("recruitment Prometheus rules", () => {
    beforeEach(() => ops._resetRecruitmentOpsMetricsForTests());

    it("finds the rule files (the Phase 4 handoff pages and the go-live rules)", () => {
        expect(ruleFiles.map((f) => f.file)).toEqual(expect.arrayContaining(["recruitment-onboarding.rules.yml", "recruitment-golive.rules.yml"]));
    });

    it("every rule is a named alert or a recording rule with an expression", () => {
        for (const { file, doc } of ruleFiles) {
            expect({ file, groups: Array.isArray(doc.groups) }).toEqual({ file, groups: true });
            for (const group of doc.groups) expect(typeof group.name).toBe("string");
        }
        for (const rule of rules) {
            expect(typeof rule.expr).toBe("string");
            if (rule.record) {
                expect(rule.record).toMatch(/^[a-z_]+:[a-z0-9_]+:[a-z0-9_]+$/);
                continue;
            }
            expect(rule.alert).toMatch(/^HrRecruitment[A-Za-z0-9]+$/);
            expect(["page", "ticket"]).toContain(rule.labels?.severity);
            expect(typeof rule.annotations?.summary).toBe("string");
            expect(typeof rule.annotations?.runbook).toBe("string");
        }
    });

    it("alert names are unique across files", () => {
        const names = alerts.map((a) => a.alert);
        expect(new Set(names).size).toBe(names.length);
    });

    it("every metric an expression uses is exported by the code or recorded by a rule", () => {
        const unknown = [];
        for (const rule of rules) {
            for (const { name } of selectors(rule.expr)) {
                const known = metricNames.has(name) || metricNames.has(name.replace(HISTOGRAM_SUFFIX, "")) || recorded.has(name);
                if (!known) unknown.push(`${rule.alert ?? rule.record}: ${name}`);
            }
        }
        expect(unknown).toEqual([]);
    });

    it("every label value a recruitment counter selector matches survives the code's allowlist", async () => {
        const problems = [];
        for (const rule of rules) {
            for (const { name, labels } of selectors(rule.expr)) {
                const record = RECORDERS[name];
                if (!record || Object.keys(labels).length === 0) continue;
                ops._resetRecruitmentOpsMetricsForTests();
                record(labels);
                const exposed = await client.register.getSingleMetricAsString(name);
                for (const [label, value] of Object.entries(labels)) {
                    const survives = exposed.includes(`${label}="${value}"`);
                    if (!survives && !isPending(name, label, value)) problems.push(`${rule.alert ?? rule.record}: ${name}{${label}="${value}"} is never recorded (allowlist collapses it)`);
                    if (survives && isPending(name, label, value)) problems.push(`${name} ${label}="${value}" is accepted now: delete it from PENDING_LABEL_VALUES`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it("the go-live rules cover the Phase 5 counters", () => {
        const golive = rules.filter((r) => r.file === "recruitment-golive.rules.yml").map((r) => r.expr).join("\n");
        for (const outcome of ["failed", "refused-tenant", "applied"]) expect(golive).toContain(`${ops.RETENTION_METRIC}{outcome="${outcome}"}`);
        expect(golive).toContain(`sum by (outcome) (increase(${ops.RETENTION_METRIC}[1d]))`);
        for (const event of ["dsr_sla_at_risk", "agency_submission_received", "analytics_alert_raised"]) {
            expect(golive).toContain(`event="${event}"`);
        }
    });

    it("every MCP tool a runbook annotation names is a real recruitment tool", () => {
        const tools = new Set(RECRUITMENT_TOOL_MANIFEST.map((t) => t.name));
        const unknown = [];
        for (const alert of alerts) {
            for (const [name] of String(alert.annotations.runbook).matchAll(/\bhr_[a-z0-9_]+\b/g)) if (!tools.has(name)) unknown.push(`${alert.alert}: ${name}`);
        }
        expect(unknown).toEqual([]);
    });

    it("the pending label list only names labels a rule still uses", () => {
        const used = new Set(rules.flatMap((r) => selectors(r.expr).flatMap(({ name, labels }) => Object.entries(labels).map(([k, v]) => `${name}|${k}|${v}`))));
        for (const [metric, byLabel] of Object.entries(PENDING_LABEL_VALUES)) {
            for (const [label, values] of Object.entries(byLabel)) for (const v of values) expect(used.has(`${metric}|${label}|${v}`)).toBe(true);
        }
    });
});
