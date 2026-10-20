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
//     `hr-reminders-dead` (audited / replayable), never silently dropped,
//   * REPEATABLE DE-DUP — each schedule is registered with a STABLE jobId so a
//     redeploy/restart re-uses the same repeatable instead of stacking
//     duplicates that would fire the sweep N times.
//
// The Queue/Worker FACTORIES are injectable so the wiring is unit-testable
// without a live Redis; server boot passes the real BullMQ ones. Guarded like
// the outbox loop: NODE_ENV=test or an absent REDIS_URL ⇒ a disabled no-op
// handle (never spawns a worker/timer). pino only; bounded logs.
import { randomUUID } from 'node:crypto';

import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import IORedis from 'ioredis';

import defaultLogger from '../lib/logger.js';
import { mcpCtx } from '../mcp/context.js';
import {
    runReviewReminderJob,
    runDocumentExpiryJob,
    runRetentionSweepJob,
    runAbsenceMarkingJob,
    runCandidateRetentionJob,
    runApplicationDraftSweepJob,
    runRequisitionAutoCloseJob,
    runTalentPoolInvitationExpiryJob,
    runRequisitionPostingExpiryJob,
    runRequisitionAutoPublishJob,
    runRecruitmentApprovalSlaJob,
} from '../services/reminderScheduler.service.js';

// BullMQ v5 forbids ':' in a queue NAME (Redis key separator) — a colon here
// makes `new Queue()` throw at boot, which the startReminderJobs try/catch
// downgrades to a disabled no-op handle, so NO reminder ever schedules. Use '-'
// separators. (Job names and jobIds are unrestricted and keep their ':'.)
export const REMINDER_QUEUE = 'hr-reminders';
export const REMINDER_DLQ = 'hr-reminders-dead';

export const JOB_REVIEW_REMINDER = 'review-reminder';
export const JOB_DOCUMENT_EXPIRY = 'document-expiry';
export const JOB_RETENTION_SWEEP = 'retention-sweep';
// HR-ATT-ABSENCE-02 (2026-09-28) — nothing ever SCHEDULED the absence marking;
// `hr_attendance_mark_absences` was the only entrypoint, so ABSENT days only
// existed when HR remembered to run it manually (the September table went dark
// after Sep 15). The repeatable below closes the day in Pakistan time the same
// way the self-service regularization deadline does (Asia/Karachi +05:00): the
// 22:00 UTC pattern is 03:00 PKT, so "yesterday" is always the FULL previous
// day when the body runs. The job body itself (tenant sweep + guards) lives
// with the other processors in reminderScheduler.service.js.
export const JOB_ABSENCE_MARKING = 'absence-marking';
// Phase 10 (remainder) — candidate-data retention (GDPR erasure), deliberately a
// DIFFERENT job from JOB_RETENTION_SWEEP above, which prunes the queue's own
// completed/failed rows. Two different meanings of "retention" in one job name is
// how an operator ends up believing candidate erasure runs when only housekeeping
// does.
export const JOB_CANDIDATE_RETENTION = 'candidate-retention';
// Phase 5 residue — save-and-return draft expiry (deletes never-submitted WIP
// forms past their 30-day clock). Deliberately a distinct job name from
// JOB_RETENTION_SWEEP (queue housekeeping) and JOB_CANDIDATE_RETENTION (GDPR
// erasure): three "retention" meanings in one name is how an operator stops
// knowing which sweep did what.
export const JOB_APPLICATION_DRAFT_SWEEP = 'application-draft-sweep';
// D-07 — the recruitment sweeps that existed with no schedule: close requisitions
// that opted into auto-close once their openings are filled, and expire
// talent-pool invitations past their validity.
export const JOB_REQUISITION_AUTOCLOSE = 'requisition-autoclose';
export const JOB_TALENT_POOL_INVITATION_EXPIRY = 'talent-pool-invitation-expiry';
// F-04 — close the postings of a POSTED requisition whose closesAt passed
// (reason EXPIRED), and publish APPROVED requisitions to the default channel(s).
export const JOB_REQUISITION_POSTING_EXPIRY = 'requisition-posting-expiry';
export const JOB_REQUISITION_AUTOPUBLISH = 'requisition-autopublish';
// F-02 — requisition/offer approval SLA reminders and escalation.
export const JOB_RECRUITMENT_APPROVAL_SLA = 'recruitment-approval-sla';

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

// The scheduled cron jobs as BullMQ REPEATABLES. Each carries a STABLE
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
        {
            name: JOB_ABSENCE_MARKING,
            data: {},
            // 22:00 UTC == 03:00 PKT — closes yesterday's window in Karachi.
            opts: { jobId: 'repeat:absence-marking', repeat: { pattern: '0 22 * * *' } },
        },
        {
            // 04:00 daily — after the 03:30 housekeeping sweep, so the two never
            // contend for the same window.
            //
            // NO `mode` IN THE JOB DATA ON PURPOSE. It is read from
            // HR_CANDIDATE_RETENTION_MODE at run time (default `dry-run`), so
            // flipping a tenant to live erasure is an env change an operator can
            // see and revert — not an edit to registered job payloads that keeps
            // running until the queue is rebuilt.
            name: JOB_CANDIDATE_RETENTION,
            data: {},
            opts: { jobId: 'repeat:candidate-retention', repeat: { pattern: '0 4 * * *' } },
        },
        {
            // 04:10 daily — after the candidate-retention window, so sweeps never
            // contend; the purge itself is a single deleteMany on expired rows.
            name: JOB_APPLICATION_DRAFT_SWEEP,
            data: {},
            opts: { jobId: 'repeat:application-draft-sweep', repeat: { pattern: '10 4 * * *' } },
        },
        {
            // Hourly at :20 — a filled requisition stops advertising within the hour.
            name: JOB_REQUISITION_AUTOCLOSE,
            data: {},
            opts: { jobId: 'repeat:requisition-autoclose', repeat: { pattern: '20 * * * *' } },
        },
        {
            // 04:20 daily — after the other recruitment sweeps.
            name: JOB_TALENT_POOL_INVITATION_EXPIRY,
            data: {},
            opts: { jobId: 'repeat:talent-pool-invitation-expiry', repeat: { pattern: '20 4 * * *' } },
        },
        {
            // Hourly at :25 — after the :20 auto-close, so a filled requisition is
            // closed as FILLED before its window could expire its postings.
            name: JOB_REQUISITION_POSTING_EXPIRY,
            data: {},
            opts: { jobId: 'repeat:requisition-posting-expiry', repeat: { pattern: '25 * * * *' } },
        },
        {
            // Every 10 minutes — an approved requisition goes live shortly after
            // its final approval (flag-gated; a no-op while autoPublish is off).
            name: JOB_REQUISITION_AUTOPUBLISH,
            data: {},
            opts: { jobId: 'repeat:requisition-autopublish', repeat: { pattern: '*/10 * * * *' } },
        },
        {
            // Every 30 minutes — SLA thresholds are hours, so a reminder lands
            // within half an hour of falling due (flag-gated, default off).
            name: JOB_RECRUITMENT_APPROVAL_SLA,
            data: {},
            opts: { jobId: 'repeat:recruitment-approval-sla', repeat: { pattern: '*/30 * * * *' } },
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
    absenceMarking = runAbsenceMarkingJob,
    candidateRetention = runCandidateRetentionJob,
    applicationDraftSweep = runApplicationDraftSweepJob,
    requisitionAutoClose = runRequisitionAutoCloseJob,
    talentPoolInvitationExpiry = runTalentPoolInvitationExpiryJob,
    requisitionPostingExpiry = runRequisitionPostingExpiryJob,
    requisitionAutoPublish = runRequisitionAutoPublishJob,
    recruitmentApprovalSla = runRecruitmentApprovalSlaJob,
} = {}) {
    // Reminder sweeps are cross-tenant → run as SYSTEM (deny-by-default off);
    // each sweep already scopes its own per-tenant work.
    return async function reminderProcessor(job) {
        // LOG-3: a scheduled job carries a correlationId minted at enqueue (or a
        // fresh one for a legacy job with none) so its logs and any events it
        // emits join back to one chain. Bind it on the SYSTEM ctx so downstream
        // side-effects (event envelopes) can read it.
        const correlationId = job?.data?.correlationId || randomUUID();
        const data = { ...(job?.data || {}), correlationId };
        return mcpCtx.run({ system: true, correlationId }, async () => {
            switch (job.name) {
                case JOB_REVIEW_REMINDER:
                    return reviewReminder(data);
                case JOB_DOCUMENT_EXPIRY:
                    return documentExpiry(data);
                case JOB_RETENTION_SWEEP:
                    return retentionSweep(data);
                case JOB_ABSENCE_MARKING:
                    return absenceMarking(data);
                case JOB_CANDIDATE_RETENTION:
                    return candidateRetention(data);
                case JOB_APPLICATION_DRAFT_SWEEP:
                    return applicationDraftSweep(data);
                case JOB_REQUISITION_AUTOCLOSE:
                    return requisitionAutoClose(data);
                case JOB_TALENT_POOL_INVITATION_EXPIRY:
                    return talentPoolInvitationExpiry(data);
                case JOB_REQUISITION_POSTING_EXPIRY:
                    return requisitionPostingExpiry(data);
                case JOB_REQUISITION_AUTOPUBLISH:
                    return requisitionAutoPublish(data);
                case JOB_RECRUITMENT_APPROVAL_SLA:
                    return recruitmentApprovalSla(data);
                default:
                    throw new Error(`reminder.queue: unknown job name "${job.name}"`);
            }
        });
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
