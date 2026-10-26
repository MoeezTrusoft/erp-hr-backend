// src/services/reminderScheduler.service.js
//
// BE-§9.4 (WBS-MODULES §M1): the node-cron scheduler is RETIRED. The job
// BODIES live here as plain, reusable async processors; the SCHEDULING is owned
// by BullMQ (src/jobs/reminder.queue.js) which gives a retry ladder, a DLQ, and
// repeatable de-dup that bare cron cannot. These processors are pure of any
// timer wiring so they are unit-testable and can be invoked from a BullMQ
// worker, a one-shot script, or a request.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { mcpCtx } from "../lib/requestContext.js";
import logger from "../lib/logger.js";
import { generateDocumentExpiryAlerts } from "./documentExpiryAlert.service.js";

const reminderLog = logger.child({ component: "reminder-jobs" });

/**
 * Performance review reminder sweep (was the 9 AM cron). Creates a
 * PENDING_REVIEW reminder row per pending review, idempotent within the day.
 * @returns {Promise<{ scanned: number, created: number }>}
 */
export async function runReviewReminderJob({tenantIds=String(process.env.APPRAISAL_LEGACY_TENANT_IDS||'').split(',').filter(Boolean),now=new Date()}={}) {
  if(!tenantIds.length)return {scanned:0,created:0,disabled:true,reason:'No authorised tenant allowlist'};
  if(tenantIds.some(id=>!/^[-a-f0-9]{36}$/i.test(id)))throw new Error('Invalid reminder tenant allowlist');
  const day=new Date(now.toISOString().slice(0,10)+'T00:00:00Z');
  let scanned=0,created=0;
  for(const tenantId of [...new Set(tenantIds)]){
    let cursor=0;
    for(;;){
      const page=await mcpCtx.run({user:{tenantId},servicePrincipal:'svc:legacy-review-reminders'},()=>tenantTransaction(prisma,async tx=>{
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId+':legacy-reminders:'+day.toISOString()},0))`;
        const reviews=await tx.performanceReview.findMany({where:{tenantId,id:{gt:cursor},status:{in:['DRAFT','IN_PROGRESS']},period_end:{lte:now}},select:{id:true,employeeId:true,reviewerId:true,type:true},orderBy:{id:'asc'},take:250});
        const sent=await tx.reviewReminder.findMany({where:{tenantId,reviewId:{in:reviews.map(r=>r.id)},sentAt:{gte:day}},select:{reviewId:true,sentToId:true}});
        const keys=new Set(sent.map(r=>r.reviewId+':'+r.sentToId));
        const data=reviews.map(r=>({tenantId,reviewId:r.id,sentToId:r.type==='SELF'?r.employeeId:r.reviewerId,type:'PENDING_REVIEW',sentAt:now})).filter(r=>r.sentToId&&!keys.has(r.reviewId+':'+r.sentToId));
        if(data.length)await tx.reviewReminder.createMany({data});
        return {count:reviews.length,created:data.length,cursor:reviews.at(-1)?.id};
      },{tenantId}));
      scanned+=page.count;created+=page.created;if(page.count<250)break;cursor=page.cursor;
    }
  }
  reminderLog.info({scanned,created},'Tenant-scoped legacy reminder intents recorded');
  return {scanned,created};
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
