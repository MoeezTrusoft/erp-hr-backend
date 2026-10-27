import { performance } from "node:perf_hooks";
import client from "prom-client";

// No runtime identifiers, error strings, addresses or request data become labels.
export const RECRUITMENT_METRIC_JOBS = Object.freeze([
  "recruitment-analytics-alerts",
  "talent-campaign-suggestions",
  "candidate-duplicate-detection",
  "onboarding-calendar-sync",
  "onboarding-document-scans",
  "onboarding-signatures",
  "onboarding-provisioning",
  "onboarding-milestones",
  "interview-staff-notices",
  "interview-reminders",
  "interview-calendar-sync",
  "offer-signatures",
  "candidate-resume-parsing",
  "candidate-communication-events",
  "candidate-communication-delivery",
  "application-scoring",
  "candidate-communication-erasure",
  "candidate-media-cleanup",
  "requisition-autoclose",
  "talent-pool-invitation-expiry",
  "offer-expiry",
  "candidate-test-expiry",
  "candidate-test-item-statistics",
  "candidate-retention",
  "application-draft-sweep",
]);
export const AUTOMATION_METRICS = Object.freeze({
  scheduler: "hr_recruitment_scheduler_runs_total",
  communications: "hr_recruitment_communication_outcomes_total",
  scoring: "hr_recruitment_scoring_outcomes_total",
  calendar: "hr_recruitment_calendar_sync_outcomes_total",
  duration: "hr_recruitment_scheduler_duration_seconds",
  finished: "hr_recruitment_scheduler_last_finished_seconds",
});
const definitions = [
  [
    "scheduler",
    client.Counter,
    {
      help: "Recruitment scheduler attempts; completed means the batch returned, not that every row succeeded.",
      labelNames: ["task", "outcome"],
    },
  ],
  [
    "communications",
    client.Counter,
    {
      help: "Outcomes reported by completed candidate communication batches; accepted means Notification Hub acceptance, not mailbox delivery.",
      labelNames: ["outcome"],
    },
  ],
  [
    "scoring",
    client.Counter,
    {
      help: "Application scoring outcomes reported by completed scheduler batches.",
      labelNames: ["outcome"],
    },
  ],
  [
    "calendar",
    client.Counter,
    {
      help: "Calendar reconciliation outcomes reported by completed scheduler batches.",
      labelNames: ["kind", "outcome"],
    },
  ],
  [
    "duration",
    client.Histogram,
    {
      help: "Elapsed time of completed, skipped or failed recruitment scheduler attempts.",
      labelNames: ["task"],
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900],
    },
  ],
  [
    "finished",
    client.Gauge,
    {
      help: "Unix timestamp of the last finished recruitment scheduler attempt, including failure or flag skip; zero means no observation in this process.",
      labelNames: ["task"],
    },
  ],
];
const zeroLabels = {
  scheduler: RECRUITMENT_METRIC_JOBS.flatMap((task) =>
    ["started", "completed", "skipped", "failed"].map((outcome) => ({ task, outcome })),
  ),
  communications: ["accepted", "retried", "failed", "suppressed"].map((outcome) => ({ outcome })),
  scoring: ["scored", "failed"].map((outcome) => ({ outcome })),
  calendar: ["interview", "onboarding"].flatMap((kind) =>
    ["synced", "retried", "superseded"].map((outcome) => ({ kind, outcome })),
  ),
};
const metrics = new Map();
function metric(key) {
  if (!metrics.has(key)) {
    const [, Type, options] = definitions.find(([name]) => name === key);
    metrics.set(
      key,
      client.register.getSingleMetric(AUTOMATION_METRICS[key]) ||
        new Type({ name: AUTOMATION_METRICS[key], ...options }),
    );
    // inc(0) creates the finite series without resetting an existing counter.
    for (const labels of zeroLabels[key] || []) metrics.get(key).inc(labels, 0);
  }
  return metrics.get(key);
}
const safe = (fn) => {
  try {
    fn();
  } catch {
    /* Telemetry must not change business results. */
  }
};
const known = (job) => typeof job === "string" && RECRUITMENT_METRIC_JOBS.includes(job);
function outcomeCounts(key, result, mapping, labels = {}) {
  for (const [field, outcome] of Object.entries(mapping)) {
    const value = result?.[field];
    // A scheduler batch is bounded; malformed counts are not coerced into samples.
    if (Number.isSafeInteger(value) && value > 0 && value <= 1000000)
      metric(key).inc({ ...labels, outcome }, value);
  }
}
function recordBatch(job, result) {
  safe(() => {
    if (job === "candidate-communication-delivery")
      outcomeCounts("communications", result, {
        sent: "accepted",
        retried: "retried",
        failed: "failed",
        suppressed: "suppressed",
      });
    if (job === "application-scoring")
      outcomeCounts("scoring", result, { scored: "scored", failed: "failed" });
    if (job === "interview-calendar-sync" || job === "onboarding-calendar-sync")
      outcomeCounts(
        "calendar",
        result,
        { synced: "synced", retried: "retried", superseded: "superseded" },
        { kind: job === "interview-calendar-sync" ? "interview" : "onboarding" },
      );
  });
}
export async function observeRecruitmentJob(job, run) {
  // Unrelated HR jobs and unknown names do not create recruitment label series.
  if (!known(job)) return run();
  const started = performance.now();
  safe(() => metric("scheduler").inc({ task: job, outcome: "started" }));
  try {
    const result = await run();
    safe(() =>
      metric("scheduler").inc({
        task: job,
        outcome: result?.skipped === true ? "skipped" : "completed",
      }),
    );
    recordBatch(job, result);
    return result;
  } catch (error) {
    safe(() => metric("scheduler").inc({ task: job, outcome: "failed" }));
    throw error;
  } finally {
    safe(() =>
      metric("duration").observe({ task: job }, Math.max(0, (performance.now() - started) / 1000)),
    );
    safe(() => metric("finished").set({ task: job }, Date.now() / 1000));
  }
}
export function attachRecruitmentAutomationMetrics(register) {
  for (const [key] of definitions)
    safe(() => {
      const value = metric(key);
      if (!register.getSingleMetric?.(AUTOMATION_METRICS[key])) register.registerMetric(value);
    });
}
export function _resetRecruitmentAutomationMetricsForTests() {
  for (const name of Object.values(AUTOMATION_METRICS)) client.register.removeSingleMetric(name);
  metrics.clear();
}
