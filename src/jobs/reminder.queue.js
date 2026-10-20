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
import { runScheduledDispositionJob } from '../services/scheduled-disposition.service.js';
import { runApplicationScoringJob } from '../services/application-scoring.service.js';
import { runCandidateDuplicateDetectionJob } from '../services/candidate-duplicate.service.js';
import { runOfferExpiryJob } from '../services/offer-expiry.service.js';
import { runEsignWebhookRetryJob } from '../services/offer-esign.service.js';
import { runInterviewReminderJob } from '../services/interview-reminder.service.js';
import { runDecisionPromptJob } from '../services/interview-decision-prompt.service.js';
import { runSlotOfferExpiryJob } from '../services/interview-slot-offer.service.js';
import { runTestItemStatsJob } from '../services/test-item-stats.service.js';
import { runTestSessionJob } from '../services/test-session.service.js';
import { runOnboardingReadinessJob } from '../services/onboarding-readiness.service.js';
import { runOnboardingSurveyJob } from '../services/onboarding-survey.service.js';
import { runHandoffWatchdogJob } from '../services/handoff-watchdog.service.js';
import { runTalentNurtureProposalJob } from '../services/talent-nurture.service.js';
import { runReferralBonusJob } from '../services/internal-referral.service.js';
import { runDsrSlaJob, runDsrVerificationSweepJob } from '../services/dsr-portal.service.js';
import { runRecruitmentAlertsJob } from '../services/recruitment-alerts.service.js';

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
// Phase 2 — intake and screening. Each body checks its own flag (all default
// OFF) and returns { skipped: "FLAG_OFF" } until a tenant opts in:
// knockout dispositions falling due (HR_RECRUITMENT_KNOCKOUT), fit scoring and
// shortlist proposals (HR_RECRUITMENT_SCORING) and duplicate candidate
// detection (HR_RECRUITMENT_DUPLICATES).
export const JOB_RECRUITMENT_SCHEDULED_DISPOSITION = 'recruitment-scheduled-disposition';
export const JOB_RECRUITMENT_SCORING = 'recruitment-scoring';
export const JOB_CANDIDATE_DUPLICATE_DETECTION = 'candidate-duplicate-detection';
// Phase 3a — interview and offer orchestration; each body checks its own flag
// (all default OFF): offer expiry reminders and expiry (HR_RECRUITMENT_OFFER_EXPIRY).
export const JOB_OFFER_EXPIRY = 'offer-expiry';
// Retries e-signature deliveries that failed or were abandoned mid-apply
// (HR_RECRUITMENT_ESIGN, and only with a provider configured).
export const JOB_ESIGN_WEBHOOK_RETRY = 'esign-webhook-retry';
// Interview reminders, feedback nudges, escalation and the no-show prompt
// (HR_RECRUITMENT_INTERVIEW_REMINDERS); the hiring manager's decision prompt
// (HR_RECRUITMENT_DECISION_PROMPTS).
export const JOB_INTERVIEW_REMINDERS = 'interview-reminders';
export const JOB_INTERVIEW_DECISION_PROMPTS = 'interview-decision-prompts';
// Expires interview slot offers the candidate did not answer in time
// (HR_RECRUITMENT_SELF_SCHEDULING).
export const JOB_INTERVIEW_SLOT_OFFER_EXPIRY = 'interview-slot-offer-expiry';
// Phase 3b — nightly item statistics and quality flags (HR_RECRUITMENT_ONSITE_TEST).
export const JOB_TEST_ITEM_STATS = 'test-item-stats';
// Phase 3b — expires unused kiosk codes, auto-submits sittings past their
// deadline and closes abandoned ones (HR_RECRUITMENT_ONSITE_TEST).
export const JOB_TEST_SESSIONS = 'test-sessions';
// Phase 4 — day-one readiness and the 30/60/90 day surveys
// (HR_ONBOARDING_AUTOMATION); the handoff watchdog fails handoffs stalled
// IN_PROGRESS so the failed-handoff alert covers a crash too
// (HR_RECRUITMENT_OFFER_HANDOFF).
export const JOB_ONBOARDING_READINESS = 'onboarding-readiness';
export const JOB_ONBOARDING_SURVEYS = 'onboarding-surveys';
export const JOB_HANDOFF_WATCHDOG = 'handoff-watchdog';
// Recruitment Phase 5: talent pool nurture proposals for newly posted
// requisitions (HR_RECRUITMENT_TALENT_NURTURE), the referral bonus clock
// (HR_RECRUITMENT_INTERNAL_BOARD), data-subject request SLA alerts
// (HR_RECRUITMENT_DSR_PORTAL), the sweep of unverified portal requests past
// their link's expiry (never flag-gated, so rows do not linger after the flag
// is turned off) and the analytics threshold alerts
// (HR_RECRUITMENT_ANALYTICS_ALERTS).
export const JOB_TALENT_NURTURE_PROPOSAL = 'talent-nurture-proposal';
export const JOB_REFERRAL_BONUS = 'referral-bonus';
export const JOB_DSR_SLA = 'dsr-sla';
export const JOB_DSR_VERIFICATION_SWEEP = 'dsr-verification-sweep';
export const JOB_RECRUITMENT_ALERTS = 'recruitment-alerts';

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
        {
            // Every 15 minutes — a knockout rejection runs within a quarter hour
            // of its delay ending; the delay itself is hours.
            name: JOB_RECRUITMENT_SCHEDULED_DISPOSITION,
            data: {},
            opts: { jobId: 'repeat:recruitment-scheduled-disposition', repeat: { pattern: '*/15 * * * *' } },
        },
        {
            // Every 15 minutes, offset from the disposition run so the two never
            // contend: a new application is scored and ranked shortly after it
            // arrives (and after its resume is parsed).
            name: JOB_RECRUITMENT_SCORING,
            data: {},
            opts: { jobId: 'repeat:recruitment-scoring', repeat: { pattern: '7,22,37,52 * * * *' } },
        },
        {
            // Hourly at :40 over the last two hours of candidate changes; the
            // overlap means a missed run is covered by the next one.
            name: JOB_CANDIDATE_DUPLICATE_DETECTION,
            data: { lookbackHours: 2 },
            opts: { jobId: 'repeat:candidate-duplicate-detection', repeat: { pattern: '40 * * * *' } },
        },
        {
            // Hourly at :35 — the expiry date is a day, so an hour of slack is
            // invisible to the candidate; the reminder window is days.
            name: JOB_OFFER_EXPIRY,
            data: {},
            opts: { jobId: 'repeat:offer-expiry', repeat: { pattern: '35 * * * *' } },
        },
        {
            // Every 15 minutes, offset from the other quarter-hour sweeps.
            name: JOB_ESIGN_WEBHOOK_RETRY,
            data: {},
            opts: { jobId: 'repeat:esign-webhook-retry', repeat: { pattern: '4,19,34,49 * * * *' } },
        },
        {
            // Every 15 minutes: the 1 h reminder's window is an hour wide, so a
            // quarter-hour cadence always lands inside it.
            name: JOB_INTERVIEW_REMINDERS,
            data: {},
            opts: { jobId: 'repeat:interview-reminders', repeat: { pattern: '*/15 * * * *' } },
        },
        {
            // Every 15 minutes, offset; the submit path prompts at once and this
            // is the backstop.
            name: JOB_INTERVIEW_DECISION_PROMPTS,
            data: {},
            opts: { jobId: 'repeat:interview-decision-prompts', repeat: { pattern: '11,26,41,56 * * * *' } },
        },
        {
            // Every 15 minutes, offset; validity is hours.
            name: JOB_INTERVIEW_SLOT_OFFER_EXPIRY,
            data: {},
            opts: { jobId: 'repeat:interview-slot-offer-expiry', repeat: { pattern: '8,23,38,53 * * * *' } },
        },
        {
            // 03:40 daily — after the 03:30 queue housekeeping; a day's tests
            // are long finished.
            name: JOB_TEST_ITEM_STATS,
            data: {},
            opts: { jobId: 'repeat:test-item-stats', repeat: { pattern: '40 3 * * *' } },
        },
        {
            // Every minute — a sitting's deadline is minute-grained, so a
            // timed-out candidate is submitted within a minute of the clock.
            name: JOB_TEST_SESSIONS,
            data: {},
            opts: { jobId: 'repeat:test-sessions', repeat: { pattern: '* * * * *' } },
        },
        {
            // 02:00 UTC = 07:00 in Asia/Karachi; each tenant's window and
            // "alerted today" use its own time zone.
            name: JOB_ONBOARDING_READINESS,
            data: {},
            opts: { jobId: 'repeat:onboarding-readiness', repeat: { pattern: '0 2 * * *' } },
        },
        {
            name: JOB_ONBOARDING_SURVEYS,
            data: {},
            opts: { jobId: 'repeat:onboarding-surveys', repeat: { pattern: '15 2 * * *' } },
        },
        {
            name: JOB_HANDOFF_WATCHDOG,
            data: {},
            opts: { jobId: 'repeat:handoff-watchdog', repeat: { pattern: '*/5 * * * *' } },
        },
        {
            name: JOB_TALENT_NURTURE_PROPOSAL,
            data: {},
            opts: { jobId: 'repeat:talent-nurture-proposal', repeat: { pattern: '45 * * * *' } },
        },
        {
            name: JOB_REFERRAL_BONUS,
            data: {},
            opts: { jobId: 'repeat:referral-bonus', repeat: { pattern: '30 2 * * *' } },
        },
        {
            name: JOB_DSR_SLA,
            data: {},
            opts: { jobId: 'repeat:dsr-sla', repeat: { pattern: '20 4 * * *' } },
        },
        {
            name: JOB_DSR_VERIFICATION_SWEEP,
            data: {},
            opts: { jobId: 'repeat:dsr-verification-sweep', repeat: { pattern: '35 * * * *' } },
        },
        {
            name: JOB_RECRUITMENT_ALERTS,
            data: {},
            opts: { jobId: 'repeat:recruitment-alerts', repeat: { pattern: '7 * * * *' } },
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
    scheduledDisposition = runScheduledDispositionJob,
    applicationScoring = runApplicationScoringJob,
    candidateDuplicateDetection = runCandidateDuplicateDetectionJob,
    offerExpiry = runOfferExpiryJob,
    esignWebhookRetry = runEsignWebhookRetryJob,
    interviewReminders = runInterviewReminderJob,
    interviewDecisionPrompts = runDecisionPromptJob,
    interviewSlotOfferExpiry = runSlotOfferExpiryJob,
    testItemStats = runTestItemStatsJob,
    testSessions = runTestSessionJob,
    onboardingReadiness = runOnboardingReadinessJob,
    onboardingSurveys = runOnboardingSurveyJob,
    handoffWatchdog = runHandoffWatchdogJob,
    talentNurtureProposal = runTalentNurtureProposalJob,
    referralBonus = runReferralBonusJob,
    dsrSla = runDsrSlaJob,
    dsrVerificationSweep = runDsrVerificationSweepJob,
    recruitmentAlerts = runRecruitmentAlertsJob,
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
                case JOB_RECRUITMENT_SCHEDULED_DISPOSITION:
                    return scheduledDisposition(data);
                case JOB_RECRUITMENT_SCORING:
                    return applicationScoring(data);
                case JOB_CANDIDATE_DUPLICATE_DETECTION:
                    return candidateDuplicateDetection(data);
                case JOB_OFFER_EXPIRY:
                    return offerExpiry(data);
                case JOB_ESIGN_WEBHOOK_RETRY:
                    return esignWebhookRetry(data);
                case JOB_INTERVIEW_REMINDERS:
                    return interviewReminders(data);
                case JOB_INTERVIEW_DECISION_PROMPTS:
                    return interviewDecisionPrompts(data);
                case JOB_INTERVIEW_SLOT_OFFER_EXPIRY:
                    return interviewSlotOfferExpiry(data);
                case JOB_TEST_ITEM_STATS:
                    return testItemStats(data);
                case JOB_TEST_SESSIONS:
                    return testSessions(data);
                case JOB_ONBOARDING_READINESS:
                    return onboardingReadiness(data);
                case JOB_ONBOARDING_SURVEYS:
                    return onboardingSurveys(data);
                case JOB_HANDOFF_WATCHDOG:
                    return handoffWatchdog(data);
                case JOB_TALENT_NURTURE_PROPOSAL:
                    return talentNurtureProposal(data);
                case JOB_REFERRAL_BONUS:
                    return referralBonus(data);
                case JOB_DSR_SLA:
                    return dsrSla(data);
                case JOB_DSR_VERIFICATION_SWEEP:
                    return dsrVerificationSweep(data);
                case JOB_RECRUITMENT_ALERTS:
                    return recruitmentAlerts(data);
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
