// src/jobs/engagement.queue.js — background work of the Engagement Context
// Engine (ARCH-01 §9: durable jobs, retry ladder, dead letter, de-duped
// repeatables), mirroring reminder.queue.js and the assessment source bridge.
//
//   profile-refresh   per party, debounced by a stable jobId so a burst of
//                     messages yields ONE LLM refresh (delay = HR_ENGAGEMENT_REFRESH_DEBOUNCE_MS)
//   refresh-sweep     repeatable: queue a refresh for every QUEUED profile
//   inbox-drain       repeatable: process fabric events accepted into EngagementInboxEvent
//   source bridge     Redis stream consumer (HR_ENGAGEMENT_SOURCE_STREAMS, e.g. "comms:events")
//                     that accepts comms.* envelopes into the inbox (ids only; the
//                     body is fetched by the configured source fetcher or the item is
//                     left for the frontend thread import)
//
// Guards: NODE_ENV=test, HR_ENGAGEMENT_JOBS_ENABLED=false or no REDIS_URL ⇒
// disabled no-op handle. pino only.
import { randomUUID } from "node:crypto";

import { Queue as BullQueue, Worker as BullWorker } from "bullmq";
import IORedis from "ioredis";

import defaultLogger from "../lib/logger.js";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { refreshProfile } from "../services/engagement/profile.service.js";
import { acceptFabricEvent, drainInbox } from "../services/engagement/inbox.service.js";

export const ENGAGEMENT_QUEUE = "hr-engagement";
export const ENGAGEMENT_DLQ = "hr-engagement-dead";
export const JOB_PROFILE_REFRESH = "profile-refresh";
export const JOB_REFRESH_SWEEP = "refresh-sweep";
export const JOB_INBOX_DRAIN = "inbox-drain";

export function defaultJobOptions() {
  return {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  };
}

const disabledHandle = (reason) => ({ enabled: false, reason, enqueueRefresh: async () => null, stop: async () => {} });

const refreshJobId = (tenantId, partyId) => `refresh:${tenantId}:${partyId}`;

/** System-context env for a job (tenant from the job payload, service actor). */
const jobEnv = (tenantId, correlationId) => ({
  tenantId,
  user: { tenantId, userId: null, email: null, isAdmin: false },
  permissions: [],
  correlationId,
  actorId: "engagement-engine",
  log: defaultLogger,
});

/**
 * Queue one profile refresh for a party; a second call inside the debounce
 * window is coalesced by BullMQ's jobId de-dup.
 */
export async function enqueueProfileRefresh(queue, { tenantId, partyId, correlationId }, { delayMs } = {}) {
  if (!queue) return null;
  const delay = delayMs ?? Number.parseInt(process.env.HR_ENGAGEMENT_REFRESH_DEBOUNCE_MS || "45000", 10);
  return queue.add(JOB_PROFILE_REFRESH, { tenantId, partyId, correlationId: correlationId || randomUUID() }, { ...defaultJobOptions(), jobId: refreshJobId(tenantId, partyId), delay });
}

export async function runProfileRefreshJob({ tenantId, partyId, correlationId }, { log = defaultLogger } = {}) {
  const env = jobEnv(tenantId, correlationId);
  return mcpCtx.run({ user: env.user, permissions: [], correlationId, log }, () =>
    tenantTransaction(prisma, (tx) => refreshProfile(tx, env, partyId), { tenantId, txOptions: { timeout: 300_000, maxWait: 5_000 } }),
  );
}

/** Find QUEUED profiles across tenants (system context) and enqueue a refresh each. */
export async function runRefreshSweep(queue, { log = defaultLogger, batch = 100 } = {}) {
  const rows = await mcpCtx.run({ system: true, log }, () =>
    prisma.engagementProfile.findMany({ where: { refreshStatus: "QUEUED" }, orderBy: { updatedAt: "asc" }, take: batch, select: { tenantId: true, partyId: true } }),
  );
  let queued = 0;
  for (const row of rows) {
    const job = await enqueueProfileRefresh(queue, { tenantId: row.tenantId, partyId: row.partyId }, { delayMs: 0 });
    if (job) queued += 1;
  }
  return { candidates: rows.length, queued };
}

export function startEngagementJobs({
  env: processEnv = process.env,
  logger = defaultLogger,
  connectionFactory = (url) => new IORedis(url, { maxRetriesPerRequest: null }),
  queueFactory = (name, opts) => new BullQueue(name, opts),
  workerFactory = (name, processor, opts) => new BullWorker(name, processor, opts),
} = {}) {
  if (processEnv.NODE_ENV === "test") return disabledHandle("test");
  if (processEnv.HR_ENGAGEMENT_JOBS_ENABLED === "false") return disabledHandle("disabled");
  if (!processEnv.REDIS_URL) return disabledHandle("no-redis");

  let connection;
  let queue;
  let dlq;
  let worker;
  let bridge;
  try {
    connection = connectionFactory(processEnv.REDIS_URL);
    queue = queueFactory(ENGAGEMENT_QUEUE, { connection, defaultJobOptions: defaultJobOptions() });
    dlq = queueFactory(ENGAGEMENT_DLQ, { connection });

    const processor = async (job) => {
      const correlationId = job.data?.correlationId || randomUUID();
      const log = logger.child({ job: job.name, jobId: job.id, correlationId });
      switch (job.name) {
        case JOB_PROFILE_REFRESH:
          return runProfileRefreshJob(job.data, { log });
        case JOB_REFRESH_SWEEP:
          return runRefreshSweep(queue, { log });
        case JOB_INBOX_DRAIN:
          return mcpCtx.run({ system: true, correlationId, log }, () => drainInbox({ log }));
        default:
          throw new Error(`engagement queue: unknown job ${job.name}`);
      }
    };
    worker = workerFactory(ENGAGEMENT_QUEUE, processor, { connection, concurrency: Number.parseInt(processEnv.HR_ENGAGEMENT_CONCURRENCY || "2", 10) });
    worker.on?.("failed", async (job, err) => {
      logger.warn({ job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err: { message: err?.message, code: err?.code } }, "engagement job failed");
      if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
        try {
          await dlq.add(job.name, { ...job.data, failedJobId: job.id, error: err?.message }, { removeOnComplete: false });
        } catch (dlqErr) {
          logger.error({ err: { message: dlqErr?.message } }, "engagement dead-letter add failed");
        }
      }
    });

    const schedule = async () => {
      await queue.add(JOB_REFRESH_SWEEP, {}, { jobId: "repeat:engagement-refresh-sweep", repeat: { every: Number.parseInt(processEnv.HR_ENGAGEMENT_SWEEP_MS || "120000", 10) }, ...defaultJobOptions() });
      await queue.add(JOB_INBOX_DRAIN, {}, { jobId: "repeat:engagement-inbox-drain", repeat: { every: Number.parseInt(processEnv.HR_ENGAGEMENT_INBOX_MS || "30000", 10) }, ...defaultJobOptions() });
    };
    schedule().catch((err) => logger.warn({ err: { message: err?.message } }, "engagement repeatables not scheduled"));

    bridge = startSourceBridge({ env: processEnv, logger, connectionFactory });
    logger.info({ queue: ENGAGEMENT_QUEUE }, "engagement jobs started");
  } catch (err) {
    logger.warn({ err: { message: err?.message } }, "engagement jobs disabled: start failed");
    return disabledHandle("start-failed");
  }

  return {
    enabled: true,
    queue,
    enqueueRefresh: (args) => enqueueProfileRefresh(queue, args),
    stop: async () => {
      try { await bridge?.stop?.(); } catch { /* best effort */ }
      try { await worker?.close?.(); } catch { /* best effort */ }
      try { await queue?.close?.(); } catch { /* best effort */ }
      try { await dlq?.close?.(); } catch { /* best effort */ }
      try { await connection?.quit?.(); } catch { /* best effort */ }
    },
  };
}

/**
 * Redis stream consumer for the communication fabric. Each stream row carries
 * `envelope=<EventEnvelope json>` (the convention HR's own outbox uses).
 * Accepted envelopes land in EngagementInboxEvent (idempotent on envelope id)
 * and are processed by the inbox-drain job.
 */
export function startSourceBridge({ env: processEnv = process.env, logger = defaultLogger, connectionFactory } = {}) {
  const streams = String(processEnv.HR_ENGAGEMENT_SOURCE_STREAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!streams.length || processEnv.NODE_ENV === "test" || !processEnv.REDIS_URL) return { enabled: false, stop: async () => {} };
  const redis = connectionFactory ? connectionFactory(processEnv.REDIS_URL) : new IORedis(processEnv.REDIS_URL, { maxRetriesPerRequest: null });
  const group = processEnv.HR_ENGAGEMENT_CONSUMER_GROUP || "hr-engagement-v1";
  const consumer = `hr-engagement-${process.pid}`;
  let stopped = false;

  const ensureGroups = async () => {
    for (const stream of streams) {
      try {
        await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
      } catch (err) {
        if (!String(err?.message || "").includes("BUSYGROUP")) throw err;
      }
    }
  };
  const processRow = async (stream, [id, fields]) => {
    const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[2 * i], fields[2 * i + 1]]));
    try {
      await acceptFabricEvent(JSON.parse(data.envelope || "{}"), { source: stream, log: logger });
      await redis.xack(stream, group, id);
    } catch (err) {
      const attempts = await redis.hincrby(`hr:engagement:retry:${stream}`, id, 1);
      if (attempts >= 5) {
        await redis.xadd(`hr:engagement:dead-letter`, "*", "stream", stream, "sourceId", id, "code", err?.code || "INVALID_EVENT", "envelope", data.envelope || "{}");
        await redis.xack(stream, group, id);
        await redis.hdel(`hr:engagement:retry:${stream}`, id);
      }
      logger.warn({ stream, id, attempts, code: err?.code }, "engagement source event rejected");
    }
  };
  const loop = async () => {
    await ensureGroups();
    while (!stopped) {
      try {
        const args = ["GROUP", group, consumer, "COUNT", 50, "BLOCK", 2000, "STREAMS", ...streams, ...streams.map(() => ">")];
        const batches = await redis.xreadgroup(...args);
        for (const [stream, rows] of batches ?? []) for (const row of rows) await processRow(stream, row);
      } catch (err) {
        if (!stopped) {
          logger.warn({ err: { message: err?.message } }, "engagement source bridge read failed");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  };
  const running = loop().catch((err) => logger.error({ err: { message: err?.message } }, "engagement source bridge stopped"));
  return {
    enabled: true,
    stop: async () => {
      stopped = true;
      try { await redis.quit(); } catch { /* best effort */ }
      await running;
    },
  };
}
