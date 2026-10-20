// src/services/reminderScheduler.service.js
//
// BE-§9.4 (WBS-MODULES §M1): the node-cron scheduler is RETIRED. The job
// BODIES live here as plain, reusable async processors; the SCHEDULING is owned
// by BullMQ (src/jobs/reminder.queue.js) which gives a retry ladder, a DLQ, and
// repeatable de-dup that bare cron cannot. These processors are pure of any
// timer wiring so they are unit-testable and can be invoked from a BullMQ
// worker, a one-shot script, or a request.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { generateDocumentExpiryAlerts } from "./documentExpiryAlert.service.js";
import { applyRetention } from "./candidatePrivacy.service.js";
import { purgeExpiredDrafts } from "./applicationDraft.service.js";
import {
  autoCloseFilledRequisitions,
  autoPublishApprovedRequisitions,
  closePostingsPastClosesAt,
} from "./requisitionPublication.service.js";
import { expireInvitations } from "./talentPoolInvitation.service.js";
import {
  sweepApprovalSla,
  APPROVAL_SLA_KINDS,
  APPROVAL_SLA_STAGES,
} from "./recruitment-approval-sla.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";

const reminderLog = logger.child({ component: "reminder-jobs" });

/**
 * Performance review reminder sweep (was the 9 AM cron). Creates a
 * PENDING_REVIEW reminder row per pending review, idempotent within the day.
 * @returns {Promise<{ scanned: number, created: number }>}
 */
export async function runReviewReminderJob() {
  reminderLog.info("performance review reminder job: start");

  const pendingReviews = await prisma.performanceReview.findMany({
    where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
    include: { employee: true, reviewer: true, cycle: true },
  });

  let created = 0;
  for (const review of pendingReviews) {
    try {
      const alreadySent = await prisma.reviewReminder.findFirst({
        where: {
          reviewId: review.id,
          sentToId: review.employeeId,
          sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });

      if (alreadySent) continue;

      await prisma.reviewReminder.create({
        data: {
          reviewId: review.id,
          sentToId: review.employeeId,
          type: "PENDING_REVIEW",
        },
      });
      created += 1;
    } catch (err) {
      reminderLog.error({ err, reviewId: review.id }, "performance review reminder per-review failed");
    }
  }

  reminderLog.info({ scanned: pendingReviews.length, created }, "performance review reminder job: done");
  return { scanned: pendingReviews.length, created };
}

/**
 * Document-expiry alert sweep (was the 8 AM cron). Fleet-wide (no tenant) so it
 * scans every tenant's documents at the 30/14/7-day marks.
 * @returns {Promise<{ created: number }>}
 */
export async function runDocumentExpiryJob() {
  const alerts = await generateDocumentExpiryAlerts({ daysBefore: [30, 14, 7] });
  reminderLog.info({ newAlertCount: alerts.length }, "document expiry alert job: done");
  return { created: alerts.length };
}

/**
 * Retention sweep — prune stale, fully-published outbox rows past the retention
 * window so the outbox table does not grow unbounded. Bounded + idempotent: a
 * row is eligible only when publishedAt is set AND older than the window.
 * @param {object} [opts]
 * @param {number} [opts.retentionDays=30]
 * @returns {Promise<{ deleted: number }>}
 */
// ── Phase 5 residue — the save-and-return draft expiry sweep ─────────────────
//
// `purgeExpiredDrafts` (applicationDraft.service.js) already deleted drafts
// whose 30-day clock ran out, but nothing SCHEDULED it: the sweep was exposed
// for the job ladder and then left as a document rather than a control — the
// exact posture the candidate-retention job comment below warns about. This job
// body closes that. Deletion (not anonymization) is the correct action for a
// never-submitted WIP form: a draft holds only verbatim form input, the owner's
// candidate row is untouched, and the 30-day clock is the §3.4-minimizing choice.
export async function runApplicationDraftSweepJob() {
  const result = await purgeExpiredDrafts();
  reminderLog.info({ purged: result.purged }, "application draft sweep job: done");
  return result;
}

export async function runRetentionSweepJob({ retentionDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const writer = prisma?.outboxEvent;
  if (!writer?.deleteMany) {
    reminderLog.warn("retention sweep: OutboxEvent model unavailable — skipping");
    return { deleted: 0 };
  }
  const res = await writer.deleteMany({
    where: { publishedAt: { not: null, lt: cutoff } },
  });
  reminderLog.info({ deleted: res?.count ?? 0, retentionDays }, "retention sweep job: done");
  return { deleted: res?.count ?? 0 };
}

// ── Phase 10 (remainder) — the SCHEDULED candidate-retention job ─────────────
//
// The retention SERVICE existed with no cron/worker invoking it, so a retention
// policy was a document rather than a control: nothing ever acted on it. This is
// the job body; BullMQ schedules it (src/jobs/reminder.queue.js).
//
// THREE DELIBERATE SAFETY PROPERTIES:
//
//   1. MODE, never a boolean. `HR_CANDIDATE_RETENTION_MODE` is one of
//      `off | dry-run | apply`, defaulting to **dry-run**. A scheduled job that is
//      merely "enabled" cannot be trusted to be non-destructive, but a job that
//      defaults to dry-run reports what it WOULD erase until an operator opts in.
//      An unrecognized value falls back to dry-run, so a typo can never turn on
//      erasure — the fail-safe direction is the non-destructive one.
//   2. TENANTS COME FROM THE POLICIES. The sweep runs only for tenants that have
//      an ACTIVE retention policy, and the window comes from that policy. No
//      policy ⇒ no clock ⇒ nothing to erase, which is the same rule the service
//      enforces on the write path. It never invents a tenant or a window.
//   3. PER-TENANT ISOLATION. One tenant's failure is caught and reported; it
//      cannot abort the sweep for every other tenant.
//
// @param {object} [opts]
// @param {'off'|'dry-run'|'apply'} [opts.mode]      defaults to the env value, then dry-run
// @param {Date|string} [opts.asOf]                  evaluation instant (defaults to now)
// @param {number} [opts.limit=100]                  max candidates erased per tenant per run
// @returns {Promise<object>} a per-tenant summary
const RETENTION_MODES = Object.freeze(["off", "dry-run", "apply"]);

export async function runCandidateRetentionJob({
  mode = process.env.HR_CANDIDATE_RETENTION_MODE || "dry-run",
  asOf = new Date(),
  limit = 100,
} = {}) {
  const requested = String(mode).toLowerCase();
  const resolved = RETENTION_MODES.includes(requested) ? requested : "dry-run";
  if (resolved !== requested) {
    reminderLog.warn(
      { requested, using: resolved },
      "candidate retention job: unrecognized mode — falling back to dry-run (never erases on a typo)",
    );
  }
  if (resolved === "off") {
    reminderLog.info("candidate retention job: mode=off — nothing to do");
    return { mode: "off", tenants: 0, wouldAnonymize: 0, anonymized: 0, suspendedByLegalHold: 0, perTenant: [] };
  }

  const policies = await prisma.candidateRetentionPolicy.findMany({
    where: { isActive: true },
    select: { tenantId: true, appliesTo: true, retentionMonths: true },
  });
  const tenants = [...new Set(policies.map((p) => p.tenantId).filter(Boolean))];
  if (tenants.length === 0) {
    reminderLog.info("candidate retention job: no tenant has an active retention policy — nothing to do");
    return { mode: resolved, tenants: 0, wouldAnonymize: 0, anonymized: 0, suspendedByLegalHold: 0, perTenant: [] };
  }

  const at = new Date(asOf);
  const dryRun = resolved !== "apply";
  const perTenant = [];
  let wouldAnonymize = 0;
  let anonymized = 0;
  let suspendedByLegalHold = 0;

  for (const tenantId of tenants) {
    try {
      const result = await applyRetention({ tenantId, asOf: at, dryRun, limit });
      const held = result.suspendedByLegalHold?.length ?? 0;
      suspendedByLegalHold += held;
      if (dryRun) {
        wouldAnonymize += result.wouldAnonymize?.length ?? 0;
        perTenant.push({ tenantId, wouldAnonymize: result.wouldAnonymize?.length ?? 0, suspendedByLegalHold: held });
      } else {
        anonymized += result.anonymized?.length ?? 0;
        perTenant.push({ tenantId, anonymized: result.anonymized?.length ?? 0, suspendedByLegalHold: held });
      }
    } catch (err) {
      // One tenant's failure is reported, never propagated: it must not abort the
      // sweep for every other tenant, and BullMQ must not retry the whole run.
      reminderLog.error({ errMessage: err?.message, tenantId }, "candidate retention job: tenant failed");
      perTenant.push({ tenantId, error: err?.message ?? "unknown" });
    }
  }

  reminderLog.info(
    { mode: resolved, tenants: tenants.length, wouldAnonymize, anonymized, suspendedByLegalHold },
    "candidate retention job: done",
  );
  return { mode: resolved, asOf: at, tenants: tenants.length, wouldAnonymize, anonymized, suspendedByLegalHold, perTenant };
}

// ── D-07 — scheduled recruitment sweeps ──────────────────────────────────────
//
// autoCloseFilledRequisitions and expireInvitations existed with no caller, so
// "close when filled" and "invitations expire after 30 days" were documented
// behaviours nothing performed (expiry was only derived at read time). Both are
// tenant-scoped functions, so each job first finds the tenants with work, then
// sweeps each one in isolation: one tenant's failure is reported and never
// aborts the others. Both are governed by HR_RECRUITMENT_WORKFLOW_ENFORCEMENT.

const tenantsWith = async (model, where) => {
  const rows = await prisma[model].findMany({ where, select: { tenantId: true }, distinct: ["tenantId"] });
  return rows.map((row) => row.tenantId).filter(Boolean);
};

const sweepTenants = async (label, tenants, run) => {
  const perTenant = [];
  for (const tenantId of tenants) {
    try {
      perTenant.push({ tenantId, ...(await run(tenantId)) });
    } catch (err) {
      reminderLog.error({ errMessage: err?.message, tenantId }, `${label}: tenant failed`);
      perTenant.push({ tenantId, error: err?.message ?? "unknown" });
    }
  }
  return perTenant;
};

export async function runRequisitionAutoCloseJob({ now = new Date() } = {}) {
  if (!isRecruitmentFlagEnabled("workflow")) {
    reminderLog.info("requisition auto-close job: workflow flag off — nothing to do");
    return { skipped: "flag-disabled", tenants: 0, closed: 0, perTenant: [] };
  }
  const tenants = await tenantsWith("jobRequisition", {
    status: { in: ["APPROVED", "POSTED"] },
    autoCloseWhenFilled: true,
    autoClosedAt: null,
  });
  const perTenant = await sweepTenants("requisition auto-close job", tenants, async (tenantId) => {
    const closed = await autoCloseFilledRequisitions({ tenantId, now });
    return { closed: closed.length };
  });
  const closed = perTenant.reduce((sum, row) => sum + (row.closed ?? 0), 0);
  reminderLog.info({ tenants: tenants.length, closed }, "requisition auto-close job: done");
  return { tenants: tenants.length, closed, perTenant };
}

export async function runTalentPoolInvitationExpiryJob({ asOf = new Date() } = {}) {
  if (!isRecruitmentFlagEnabled("workflow")) {
    reminderLog.info("talent-pool invitation expiry job: workflow flag off — nothing to do");
    return { skipped: "flag-disabled", tenants: 0, expired: 0, perTenant: [] };
  }
  const tenants = await tenantsWith("talentPoolInvitation", { status: "INVITED", expiresAt: { lte: asOf } });
  const perTenant = await sweepTenants("talent-pool invitation expiry job", tenants, async (tenantId) => {
    const result = await expireInvitations({ tenantId, asOf, dryRun: false });
    return { expired: result.expired?.length ?? 0 };
  });
  const expired = perTenant.reduce((sum, row) => sum + (row.expired ?? 0), 0);
  reminderLog.info({ tenants: tenants.length, expired }, "talent-pool invitation expiry job: done");
  return { tenants: tenants.length, expired, perTenant };
}

// ── F-04 — posting expiry past closesAt ──────────────────────────────────────
//
// A SIBLING of the auto-close job rather than a second step inside it: the two
// discover tenants from different predicates (opted-in autoCloseWhenFilled vs
// any POSTED requisition past closesAt), and a separate BullMQ job keeps their
// retry ladders, DLQ entries and result summaries apart, so a failure in one is
// never retried by re-running the other. Same governing flag as auto-close.
export async function runRequisitionPostingExpiryJob({ now = new Date() } = {}) {
  if (!isRecruitmentFlagEnabled("postingExpiry")) {
    reminderLog.info("requisition posting expiry job: postingExpiry flag off — nothing to do");
    return { skipped: "flag-disabled", tenants: 0, expired: 0, perTenant: [] };
  }
  const at = new Date(now);
  const tenants = await tenantsWith("jobRequisition", { status: "POSTED", closesAt: { lt: at } });
  const perTenant = await sweepTenants("requisition posting expiry job", tenants, async (tenantId) => {
    const expired = await closePostingsPastClosesAt({ tenantId, now: at });
    return { expired: expired.length };
  });
  const expired = perTenant.reduce((sum, row) => sum + (row.expired ?? 0), 0);
  reminderLog.info({ tenants: tenants.length, expired }, "requisition posting expiry job: done");
  return { tenants: tenants.length, expired, perTenant };
}

// ── F-04 — auto-publish on approval ──────────────────────────────────────────
// Governed by its own flag (`autoPublish`, HR_RECRUITMENT_AUTO_PUBLISH, default
// OFF): publication is candidate-facing, so a tenant opts in deliberately.
export async function runRequisitionAutoPublishJob({ now = new Date() } = {}) {
  if (!isRecruitmentFlagEnabled("autoPublish")) {
    reminderLog.info("requisition auto-publish job: autoPublish flag off — nothing to do");
    return { skipped: "flag-disabled", tenants: 0, published: 0, perTenant: [] };
  }
  const at = new Date(now);
  const tenants = await tenantsWith("jobRequisition", { status: "APPROVED" });
  const perTenant = await sweepTenants("requisition auto-publish job", tenants, async (tenantId) => {
    const result = await autoPublishApprovedRequisitions({ tenantId, now: at });
    return { published: result.published.length, skipped: result.skipped.length, failed: result.failed.length };
  });
  const published = perTenant.reduce((sum, row) => sum + (row.published ?? 0), 0);
  reminderLog.info({ tenants: tenants.length, published }, "requisition auto-publish job: done");
  return { tenants: tenants.length, published, perTenant };
}

// ── F-02 — approval SLA reminders and escalation ─────────────────────────────
// Governed by `approvalSla` (HR_RECRUITMENT_APPROVAL_SLA, default OFF). The body
// (thresholds, dedupe, per-enqueue tenant transactions) lives in
// recruitment-approval-sla.service.js; this wrapper only finds the tenants with
// pending REQUISITION/OFFER approvals and isolates them from each other.
export async function runRecruitmentApprovalSlaJob({ now = new Date(), correlationId } = {}) {
  if (!isRecruitmentFlagEnabled("approvalSla")) {
    reminderLog.info("recruitment approval SLA job: approvalSla flag off — nothing to do");
    return { skipped: "flag-disabled", tenants: 0, reminded: 0, escalated: 0, perTenant: [] };
  }
  const at = new Date(now);
  const tenants = await tenantsWith("hrApprovalRequest", {
    kind: { in: [...APPROVAL_SLA_KINDS] },
    stage: { in: [...APPROVAL_SLA_STAGES] },
  });
  const perTenant = await sweepTenants("recruitment approval SLA job", tenants, (tenantId) =>
    sweepApprovalSla({ tenantId, now: at, correlationId }),
  );
  const reminded = perTenant.reduce((sum, row) => sum + (row.reminded ?? 0), 0);
  const escalated = perTenant.reduce((sum, row) => sum + (row.escalated ?? 0), 0);
  reminderLog.info({ tenants: tenants.length, reminded, escalated }, "recruitment approval SLA job: done");
  return { tenants: tenants.length, reminded, escalated, perTenant };
}

// Back-compat shim: the old export name. Now it just logs that scheduling has
// moved to BullMQ — it never registers a cron timer. Kept so any stale import
// does not crash a boot; the canonical entrypoint is startReminderJobs().
export const startReviewReminderScheduler = () => {
  reminderLog.warn(
    "startReviewReminderScheduler is retired — HR reminder/expiry/retention jobs are scheduled by BullMQ (src/jobs/reminder.queue.js)"
  );
};

// Compatibility scheduler entry point; the durable planner owns work dates and deadlines.
export async function runAbsenceMarkingJob() {
  const {planAttendanceFinalization,drainAttendanceFinalization}=await import('./attendanceFinalization.service.js');
  const plan=await planAttendanceFinalization();
  const result=await drainAttendanceFinalization({limit:100});
  if(plan.failures.length||result.failed)throw new Error('Attendance finalization has failed windows; durable jobs retain their work dates');
  return result;
}
