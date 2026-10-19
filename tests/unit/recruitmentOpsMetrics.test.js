// tests/unit/recruitmentOpsMetrics.test.js
//
// Phase 15 — the seven rollout counters:
//   * bounded labels: unknown values collapse to a safe bucket, never throw,
//     and never create unbounded label cardinality
//   * record helpers NEVER throw (a metrics hiccup must not derail the write)
//   * attachRecruitmentOpsMetrics exposes all seven on a private registry
//     (the same exposition shape /metrics serves)

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import client from "prom-client";

const {
    TRANSITION_FAILURES_METRIC,
    HANDOFF_METRIC,
    RESUME_PARSE_METRIC,
    NOTIFICATION_METRIC,
    DENIALS_METRIC,
    EXPORTS_METRIC,
    RETENTION_METRIC,
    recordTransitionFailure,
    recordHandoff,
    recordResumeParse,
    recordRecruitmentNotification,
    recordDenial,
    recordExport,
    recordRetentionRun,
    attachRecruitmentOpsMetrics,
    _resetRecruitmentOpsMetricsForTests,
} = await import("../../src/lib/recruitmentOpsMetrics.js");

beforeEach(() => {
    _resetRecruitmentOpsMetricsForTests();
});

describe("recruitmentOpsMetrics — counter exposure (Phase 15)", () => {
    it("exposes all seven counters on a private registry", async () => {
        const register = new client.Registry();
        attachRecruitmentOpsMetrics(register);
        const text = await register.metrics();
        for (const name of [TRANSITION_FAILURES_METRIC, HANDOFF_METRIC, RESUME_PARSE_METRIC, NOTIFICATION_METRIC, DENIALS_METRIC, EXPORTS_METRIC, RETENTION_METRIC]) {
            expect(text).toContain(name);
        }
    });

    it("is idempotent across repeated attachment", async () => {
        const register = new client.Registry();
        attachRecruitmentOpsMetrics(register);
        attachRecruitmentOpsMetrics(register);
        expect((await register.metrics()).match(new RegExp(TRANSITION_FAILURES_METRIC, "g"))?.length ?? 0).toBeLessThanOrEqual(2);
    });
});

describe("recruitmentOpsMetrics — bounded labels and never-throw", () => {
    it("records a transition failure by code family", async () => {
        recordTransitionFailure("HR-RECRUITMENT-TRANSITION-INVALID");
        const text = await client.register.getSingleMetric(TRANSITION_FAILURES_METRIC).get();
        expect(text.values[0].labels.code).toBe("HR-RECRUITMENT-TRANSITION-INVALID");
        expect(text.values[0].value).toBe(1);
    });

    it("collapses unknown label values into safe buckets, never creating new series", async () => {
        recordHandoff("completed");
        recordHandoff("something-else-entirely");
        const m = await client.register.getSingleMetric(HANDOFF_METRIC).get();
        const outcomes = m.values.map((v) => v.labels.outcome).sort();
        expect(outcomes).toEqual(["completed", "failed"]); // unknown → 'failed' bucket
    });

    it("counts parse outcomes by kind and allowlisted outcome", async () => {
        recordResumeParse({ kind: "CANDIDATE", outcome: "ok" });
        recordResumeParse({ kind: "CANDIDATE", outcome: "cache-hit" });
        recordResumeParse({ kind: "WEIRD", outcome: "nope" });
        const m = await client.register.getSingleMetric(RESUME_PARSE_METRIC).get();
        const pairs = m.values.map((v) => `${v.labels.kind}:${v.labels.outcome}`).sort();
        expect(pairs).toEqual(["CANDIDATE:cache-hit", "CANDIDATE:ok", "other:other"]);
    });

    it("strips version suffixes and collapses unknown event names into 'other'", async () => {
        // NB: the recruitment-stem filter lives in the CALLER (hrDomainEvent.service),
        // so non-recruitment events never reach this counter in production. Here we
        // pin the module's own contract: known stems count; unknown → 'other'.
        recordRecruitmentNotification("interview_scheduled", "enqueued");
        recordRecruitmentNotification("leave.approved", "enqueued"); // unknown stem
        const m = await client.register.getSingleMetric(NOTIFICATION_METRIC).get();
        const events = m.values.filter((v) => v.value > 0).map((v) => v.labels.event).sort();
        expect(events).toEqual(["interview_scheduled", "other"]);
    });

    it("never throws — even on garbage input", () => {
        expect(() => recordTransitionFailure(null)).not.toThrow();
        expect(() => recordHandoff(undefined)).not.toThrow();
        expect(() => recordResumeParse({})).not.toThrow();
        expect(() => recordRecruitmentNotification(null, null)).not.toThrow();
        expect(() => recordDenial("")).not.toThrow();
        expect(() => recordExport("xlsx", "weird")).not.toThrow();
        expect(() => recordRetentionRun("applied")).not.toThrow();
    });

    it("retention outcomes use the §8 vocabulary", async () => {
        recordRetentionRun("dry-run");
        recordRetentionRun("refused-flag");
        recordRetentionRun("applied");
        const m = await client.register.getSingleMetric(RETENTION_METRIC).get();
        const outcomes = m.values.filter((v) => v.value > 0).map((v) => v.labels.outcome).sort();
        expect(outcomes).toEqual(["applied", "dry-run", "refused-flag"]);
    });
});
