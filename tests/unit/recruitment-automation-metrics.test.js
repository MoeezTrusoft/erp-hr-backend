import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import client from "prom-client";
import {
  AUTOMATION_METRICS,
  RECRUITMENT_METRIC_JOBS,
  observeRecruitmentJob,
  attachRecruitmentAutomationMetrics,
  _resetRecruitmentAutomationMetricsForTests,
} from "../../src/lib/recruitment-automation-metrics.js";
beforeEach(() => _resetRecruitmentAutomationMetricsForTests());
const samples = async (key) =>
  (await client.register.getSingleMetric(AUTOMATION_METRICS[key]).get()).values;
const value = (rows, labels) =>
  rows
    .filter((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v))
    .reduce((n, r) => n + r.value, 0);
describe("recruitment automation telemetry", () => {
  it("exposes all required families and attaches idempotently to private registries", async () => {
    const a = new client.Registry(),
      b = new client.Registry();
    attachRecruitmentAutomationMetrics(a);
    attachRecruitmentAutomationMetrics(a);
    attachRecruitmentAutomationMetrics(b);
    expect(a.getMetricsAsArray()).toHaveLength(6);
    for (const name of Object.values(AUTOMATION_METRICS)) {
      expect(a.getSingleMetric(name)).toBe(b.getSingleMetric(name));
      expect(await a.metrics()).toContain(name);
    }
  });
  it("awaits one batch and preserves its result with timing and heartbeat", async () => {
    const result = { scored: 3, failed: 1 },
      run = jest.fn(async () => result);
    expect(await observeRecruitmentJob("application-scoring", run)).toBe(result);
    expect(run).toHaveBeenCalledTimes(1);
    const rows = await samples("scheduler");
    expect(value(rows, { task: "application-scoring", outcome: "started" })).toBe(1);
    expect(value(rows, { task: "application-scoring", outcome: "completed" })).toBe(1);
    expect(value(await samples("scoring"), { outcome: "scored" })).toBe(3);
    expect(value(await samples("scoring"), { outcome: "failed" })).toBe(1);
    expect(value(await samples("finished"), { task: "application-scoring" })).toBeGreaterThan(0);
    expect(
      (await samples("duration")).some(
        (v) => v.metricName === AUTOMATION_METRICS.duration + "_count" && v.value === 1,
      ),
    ).toBe(true);
  });
  it("preserves the original rejection without logging or exporting its contents", async () => {
    const error = new Error("private-person@example.invalid"),
      run = jest.fn(async () => {
        throw error;
      });
    await expect(observeRecruitmentJob("interview-calendar-sync", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(value(await samples("scheduler"), { outcome: "failed" })).toBe(1);
    expect(await client.register.metrics()).not.toContain(error.message);
    expect(client.register.getSingleMetric(AUTOMATION_METRICS.calendar)).toBeUndefined();
  });
  it("distinguishes a flag skip from a completed batch", async () => {
    const result = { skipped: true, reason: "flag-disabled" };
    expect(await observeRecruitmentJob("application-scoring", () => result)).toBe(result);
    expect(value(await samples("scheduler"), { outcome: "skipped" })).toBe(1);
    expect(value(await samples("scheduler"), { outcome: "completed" })).toBe(0);
  });
  it("counts Hub acceptance separately from real delivery and excludes result metadata", async () => {
    await observeRecruitmentJob("candidate-communication-delivery", () => ({
      sent: 2,
      retried: 1,
      failed: 3,
      suppressed: 4,
      delivered: 999,
      email: "candidate@example.invalid",
      tenantId: "private-company",
    }));
    const rows = await samples("communications");
    expect(rows.map((r) => r.labels.outcome).sort()).toEqual([
      "accepted",
      "failed",
      "retried",
      "suppressed",
    ]);
    expect(value(rows, { outcome: "accepted" })).toBe(2);
    expect(await client.register.metrics()).not.toMatch(
      /candidate@example|private-company|outcome="delivered"/,
    );
  });
  it("records each calendar kind and only the three bounded reconciliation outcomes", async () => {
    for (const kind of ["interview", "onboarding"])
      await observeRecruitmentJob(kind + "-calendar-sync", () => ({
        synced: 2,
        retried: 3,
        superseded: 1,
        privateResult: 19,
      }));
    const rows = await samples("calendar");
    expect(rows).toHaveLength(6);
    expect(value(rows, { kind: "onboarding", outcome: "retried" })).toBe(3);
  });
  it("ignores malformed, nonpositive, fractional and excessive counts", async () => {
    attachRecruitmentAutomationMetrics(new client.Registry());
    for (const count of [-1, 0, 0.1, NaN, Infinity, "2", 1000001, null, undefined])
      await observeRecruitmentJob("application-scoring", () => ({ scored: count, failed: count }));
    expect((await samples("scoring")).every((sample) => sample.value === 0)).toBe(true);
  });
  it("does not create label series for arbitrary job names or unrelated HR jobs", async () => {
    for (let i = 0; i < 100; i++)
      expect(await observeRecruitmentJob("private-" + i, () => 42)).toBe(42);
    expect(client.register.getSingleMetric(AUTOMATION_METRICS.scheduler)).toBeUndefined();
    const error = new Error("unknown job");
    await expect(
      observeRecruitmentJob("unknown", () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(new Set(RECRUITMENT_METRIC_JOBS).size).toBe(RECRUITMENT_METRIC_JOBS.length);
  });
  it("does not turn telemetry failures into business failure or retry", async () => {
    const spy = jest.spyOn(client.register, "getSingleMetric").mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    try {
      const result = { scored: 1 },
        run = jest.fn(async () => result);
      expect(await observeRecruitmentJob("application-scoring", run)).toBe(result);
      expect(run).toHaveBeenCalledTimes(1);
      const error = new Error("original");
      await expect(
        observeRecruitmentJob("application-scoring", () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(() => attachRecruitmentAutomationMetrics(new client.Registry())).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("counter baselines for first-event alerts", () => {
  it("exposes all finite zero series before the first event and never resets counts on reattach", async () => {
    const registry = new client.Registry();
    attachRecruitmentAutomationMetrics(registry);
    for (const [key, expected] of [
      ["scheduler", 100],
      ["communications", 4],
      ["scoring", 2],
      ["calendar", 6],
    ]) {
      const rows = await samples(key);
      expect(rows).toHaveLength(expected);
      expect(rows.every((row) => row.value === 0)).toBe(true);
    }
    const before = await registry.metrics();
    expect(before).toContain(
      'hr_recruitment_scheduler_runs_total{task="application-scoring",outcome="failed"} 0',
    );
    const error = new Error("failure after a healthy scrape");
    await expect(
      observeRecruitmentJob("application-scoring", () => {
        throw error;
      }),
    ).rejects.toBe(error);
    attachRecruitmentAutomationMetrics(registry);
    expect(
      value(await samples("scheduler"), { task: "application-scoring", outcome: "failed" }),
    ).toBe(1);
    expect(
      (await samples("scheduler")).every((row) =>
        RECRUITMENT_METRIC_JOBS.includes(row.labels.task),
      ),
    ).toBe(true);
    expect(await registry.metrics()).toContain(
      'hr_recruitment_scheduler_runs_total{task="application-scoring",outcome="failed"} 1',
    );
  });
});
