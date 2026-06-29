// src/jobs/reminder.queue.js — BE-§9.4 / WBS-MODULES §M1.
//
// BullMQ scheduling for the HR background jobs that used to run under node-cron
// (reminderScheduler): the performance-review reminder, the document-expiry
// alert sweep, and an outbox retention sweep. BullMQ is chosen over bare cron
// because the spec (ARCH-01 §9) requires durable jobs with:
//
//   * a RETRY LADDER — a transient failure (DB blip) is retried with
//     exponential backoff instead of being lost until the next day,
//   * a DEAD-LETTER QUEUE — a job that exhausts its attempts is captured in
//     `hr:reminders:dead` (audited / replayable), never silently dropped,
//   * REPEATABLE DE-DUP — each schedule is registered with a STABLE jobId so a
//     redeploy/restart re-uses the same repeatable instead of stacking
//     duplicates that would fire the sweep N times.
//
// The Queue/Worker FACTORIES are injectable so the wiring is unit-testable
// without a live Redis; server boot passes the real BullMQ ones. Guarded like
// the outbox loop: NODE_ENV=test or an absent REDIS_URL ⇒ a disabled no-op
// handle (never spawns a worker/timer). pino only; bounded logs.
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import IORedis from 'ioredis';

import defaultLogger from '../lib/logger.js';
import {
    runReviewReminderJob,
    runDocumentExpiryJob,
    runRetentionSweepJob,
} from '../services/reminderScheduler.service.js';

export const REMINDER_QUEUE = 'hr:reminders';
export const REMINDER_DLQ = 'hr:reminders:dead';

export const JOB_REVIEW_REMINDER = 'review-reminder';
export const JOB_DOCUMENT_EXPIRY = 'document-expiry';
export const JOB_RETENTION_SWEEP = 'retention-sweep';

// The retry ladder applied to every job: bounded attempts + exponential
// backoff, with bounded completed/failed retention so the queue keys do not
// grow unbounded.
export function defaultJobOptions() {
    return {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 }, // 30s, 60s, 120s, …
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
    };
}

// The three migrated cron jobs as BullMQ REPEATABLES. Each carries a STABLE
// jobId so re-registering on every boot de-dups (BullMQ keys repeatables by
// name+pattern; the explicit jobId makes the de-dup intent unambiguous and lets
// us upsert deterministically).
export function repeatableJobs() {
    return [
        {
            name: JOB_REVIEW_REMINDER,
            data: {},
            opts: { jobId: 'repeat:review-reminder', repeat: { pattern: '0 9 * * *' } }, // 09:00 daily
        },
        {
            name: JOB_DOCUMENT_EXPIRY,
            data: {},
            opts: { jobId: 'repeat:document-expiry', repeat: { pattern: '0 8 * * *' } }, // 08:00 daily
        },
        {
            name: JOB_RETENTION_SWEEP,
            data: { retentionDays: 30 },
            opts: { jobId: 'repeat:retention-sweep', repeat: { pattern: '30 3 * * *' } }, // 03:30 daily
        },
    ];
}

/**
 * Build the worker processor: dispatch by job name to the (injectable) job
 * bodies. An UNKNOWN job name THROWS so BullMQ retries it and — on exhaustion —
 * routes it to the DLQ; it is never silently acked.
 */
export function buildReminderProcessor({
    reviewReminder = runReviewReminderJob,
    documentExpiry = runDocumentExpiryJob,
    retentionSweep = runRetentionSweepJob,
} = {}) {
    return async function reminderProcessor(job) {
        switch (job.name) {
            case JOB_REVIEW_REMINDER:
                return reviewReminder(job.data);
            case JOB_DOCUMENT_EXPIRY:
                return documentExpiry(job.data);
            case JOB_RETENTION_SWEEP:
                return retentionSweep(job.data);
            default:
                throw new Error(`reminder.queue: unknown job name "${job.name}"`);
        }
    };
}

function isEnabledFlag(raw, defaultWhenUnset = true) {
    if (raw === undefined || raw === null || raw === '') return defaultWhenUnset;
    return String(raw).toLowerCase() !== 'false';
}

/**
 * Server-boot entrypoint. Creates the main queue + the DLQ, registers the
 * repeatables (idempotent via stable jobId), and starts a worker that drains
 * the queue. A job that exhausts its retry ladder is forwarded to the DLQ on
 * the worker `failed` event when `job.attemptsMade >= job.opts.attempts`.
 *
 * DISABLED (no-op handle, enabled:false) when:
 *   * NODE_ENV === 'test'                      — never spawn a worker in the suite,
 *   * HR_REMINDER_JOBS_ENABLED === 'false'     — explicit ops kill-switch,
 *   * REDIS_URL is not configured              — nothing to connect to.
 *
 * Best-effort: any boot error is caught and downgraded to a disabled handle so
 * a Redis hiccup at startup can never take down the HTTP server.
 *
 * @returns {{ enabled: boolean, stop: () => Promise<void> }}
 */
export function startReminderJobs({
    env = process.env,
    logger = defaultLogger,
    processor,
    // Factories are injectable for tests; defaults build real BullMQ objects.
    connectionFactory = (url) => new IORedis(url, { maxRetriesPerRequest: null }),
    queueFactory,
    workerFactory,
} = {}) {
    const noop = { enabled: false, stop: async () => {} };

    if (String(env.NODE_ENV).toLowerCase() === 'test') {
        return noop;
    }
    if (!isEnabledFlag(env.HR_REMINDER_JOBS_ENABLED)) {
        logger.info?.('hr reminder jobs: disabled via HR_REMINDER_JOBS_ENABLED=false');
        return noop;
    }
    if (!env.REDIS_URL) {
        logger.warn?.('hr reminder jobs: REDIS_URL not configured — BullMQ scheduling disabled');
        return noop;
    }

    try {
        const connection = (queueFactory || workerFactory) ? undefined : connectionFactory(env.REDIS_URL);
        const mkQueue = queueFactory || ((name) => new BullQueue(name, { connection }));
        const mkWorker = workerFactory || ((name, proc, o) => new BullWorker(name, proc, o));

        const queue = mkQueue(REMINDER_QUEUE, { connection });
        const dlq = mkQueue(REMINDER_DLQ, { connection });

        // Register the repeatables (idempotent — stable jobId de-dups).
        const jobOpts = defaultJobOptions();
        for (const job of repeatableJobs()) {
            queue.add(job.name, job.data, { ...jobOpts, ...job.opts });
        }

        const worker = mkWorker(
            REMINDER_QUEUE,
            processor || buildReminderProcessor(),
            { connection },
        );

        // DLQ routing: when a job has exhausted its retry ladder, capture it on
        // the dead-letter queue (audited / replayable) before BullMQ drops it.
        worker.on?.('failed', (job, err) => {
            const attempts = job?.opts?.attempts ?? jobOpts.attempts;
            const exhausted = (job?.attemptsMade ?? 0) >= attempts;
            logger.warn?.(
                { job: job?.name, attemptsMade: job?.attemptsMade, exhausted, errMessage: err?.message },
                'hr reminder job failed'
            );
            if (exhausted) {
                dlq.add(`${job?.name || 'unknown'}:dead`, {
                    name: job?.name,
                    data: job?.data,
                    failedReason: err?.message,
                    attemptsMade: job?.attemptsMade,
                }).catch((dErr) =>
                    logger.error?.({ errMessage: dErr?.message }, 'hr reminder DLQ enqueue failed'));
            }
        });

        worker.on?.('error', (err) =>
            logger.warn?.({ errMessage: err?.message }, 'hr reminder worker error'));

        logger.info?.(
            { queue: REMINDER_QUEUE, dlq: REMINDER_DLQ, repeatables: repeatableJobs().length },
            'hr reminder jobs: BullMQ scheduler started'
        );

        return {
            enabled: true,
            async stop() {
                try { await worker.close?.(); } catch { /* best effort */ }
                try { await queue.close?.(); } catch { /* best effort */ }
                try { await dlq.close?.(); } catch { /* best effort */ }
                try { await connection?.quit?.(); } catch { /* best effort */ }
            },
        };
    } catch (err) {
        logger.error?.(
            { errMessage: err?.message },
            'hr reminder jobs: failed to start — continuing without BullMQ scheduling'
        );
        return noop;
    }
}

export default startReminderJobs;
