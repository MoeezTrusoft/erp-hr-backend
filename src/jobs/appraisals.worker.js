import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import {
  scanCompany,
  launchWork,
  reconcileLaunches,
} from "../services/appraisals/jobs.js";
import logger from "../lib/logger.js";
import { dispatchReminders } from '../services/appraisals/notifications.js';
const tenants = z
  .array(z.string().uuid())
  .min(1)
  .parse((process.env.APPRAISAL_TENANT_IDS || "").split(",").filter(Boolean));
if (!process.env.REDIS_URL)
  throw new Error("REDIS_URL is required for the dedicated appraisal worker");
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const queue = new Queue("hr-appraisals", { connection });
for (const tenantId of tenants)
  await queue.upsertJobScheduler(
    "scan-" + tenantId,
    { every: 300000 },
    {
      name: "scan",
      data: { tenantId },
      opts: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    },
  );
const worker = new Worker(
  "hr-appraisals",
  async (job) => {
    if (!tenants.includes(job.data.tenantId))
      throw new Error("Unsupported appraisal tenant");
    if (job.name === 'notifications') {
      if (process.env.APPRAISAL_NOTIFICATIONS_ENABLED !== 'true') return { disabled: true };
      const notifications = await dispatchReminders(job.data.tenantId, { cursor: job.data.cursor });
      if (notifications.failed) logger.warn({ failed: notifications.failed }, 'Appraisal notification retries remain pending');
      if (notifications.nextCursor) await queue.add('notifications', { tenantId: job.data.tenantId, cursor: notifications.nextCursor },
        { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } });
      return notifications;
    }
    if (job.name === "launch") {
      const cycleId = z.string().uuid().parse(job.data.cycleId);
      for (;;) {
        const result = await launchWork(job.data.tenantId, { cycleId });
        if (result.processed !== undefined)
          await job.updateProgress({
            processed: result.processed,
            total: result.total,
          });
        if (result.done) return result;
      }
    }
    if (job.name !== "scan") throw new Error("Unsupported appraisal job");
    await reconcileLaunches(queue, job.data.tenantId);
    const cursor = job.data.cursor
      ? z.string().uuid().parse(job.data.cursor)
      : undefined;
    const result = await scanCompany(job.data.tenantId, { cursor });
    if (!cursor && process.env.APPRAISAL_NOTIFICATIONS_ENABLED === 'true')
      await queue.add('notifications', { tenantId: job.data.tenantId },
        { jobId: `notifications-${job.data.tenantId}-${Math.floor(Date.now() / 300000)}`,
          removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } });
    if (result.nextCursor)
      await queue.add(
        "scan",
        { tenantId: job.data.tenantId, cursor: result.nextCursor },
        {
          jobId: `scan-${job.data.tenantId}-${result.nextCursor}-${Math.floor(Date.now() / 300000)}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      );
    return result;
  },
  { connection, concurrency: 2 },
);
worker.on("failed", (job, error) =>
  logger.error(
    { jobId: job?.id, errorCode: error.code || "APPRAISAL_JOB_FAILED" },
    "Appraisal job failed; durable state retained",
  ),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await worker.close();
  await queue.close();
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
