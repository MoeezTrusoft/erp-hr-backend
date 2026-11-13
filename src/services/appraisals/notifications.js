import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { mcpCtx } from '../../lib/requestContext.js';
import { tenantTransaction } from '../../lib/rlsTenant.js';
import { createAppraisalNotificationClient } from './notification-client.js';

const deliverNotification = createAppraisalNotificationClient();
export async function dispatchReminders(tenantId, { deliver = deliverNotification, limit = 25, cursor, now = new Date() } = {}) {
  z.string().uuid().parse(tenantId);
  z.number().int().min(1).max(100).parse(limit);
  if (cursor) z.string().uuid().parse(cursor);
  return mcpCtx.run({ user: { tenantId }, servicePrincipal: 'svc:hr-appraisals' }, async () => {
    const txRun = fn => tenantTransaction(prisma, fn, { tenantId, txOptions: { timeout: 25000 } });
    const candidates = await txRun(async tx => {
      if (!(await tx.perfConfiguration.findUnique({ where: { tenantId } }))?.coreEnabled) return [];
      return tx.perfReminderIntent.findMany({ where: { tenantId, state: 'PENDING', ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' }, take: limit });
    });
    const result = { accepted: 0, cancelled: 0, failed: 0, skipped: 0,
      nextCursor: candidates.length === limit ? candidates.at(-1).id : null };
    for (const candidate of candidates) {
      try {
        const outcome = await txRun(async tx => {
          // Match transition lock order: review first, then its reminder. Keep
          // authority stable until Hub acceptance; calls have bounded timeouts.
          await tx.$queryRaw`SELECT id FROM "PerfReview" WHERE "tenantId"=${tenantId}::uuid AND id=${candidate.reviewId}::uuid FOR UPDATE`;
          const locked = await tx.$queryRaw`SELECT id FROM "PerfReminderIntent" WHERE "tenantId"=${tenantId}::uuid AND id=${candidate.id}::uuid FOR UPDATE SKIP LOCKED`;
          if (!locked.length) return 'skipped';
          const intent = await tx.perfReminderIntent.findFirst({ where: { tenantId, id: candidate.id } });
          if (intent?.state !== 'PENDING') return 'skipped';
          if (!(await tx.perfConfiguration.findUnique({ where: { tenantId } }))?.coreEnabled) return 'skipped';
          const review = await tx.perfReview.findFirst({ where: { tenantId, id: intent.reviewId } });
          if (review) await tx.$queryRaw`SELECT id FROM "Employee" WHERE tenant_id=${tenantId}::uuid AND id IN (${review.employeeId}, ${intent.recipientId}) ORDER BY id FOR SHARE`;
          const cycle = review && await tx.perfCycle.findFirst({ where: { tenantId, id: review.cycleId } });
          const employee = review && await tx.employee.findFirst({ where: { tenant_id: tenantId, id: review.employeeId } });
          const self = intent.stage.startsWith('SELF_');
          const recipient = await tx.employee.findFirst({ where: { tenant_id: tenantId, id: intent.recipientId } });
          const due = self ? review?.selfDue : review?.managerDue;
          const obsolete = !review || !employee || !cycle || ['CLOSED', 'ARCHIVED'].includes(cycle.status)
            || intent.scheduleVersion !== review.scheduleVersion || +due !== +intent.dueAt
            || (self ? review.state !== 'SELF_OPEN' || intent.recipientId !== review.employeeId
              : !['SELF_SUBMITTED', 'CORRECTION_OPEN'].includes(review.state)
                || intent.recipientId !== review.managerId || employee.managerId !== review.managerId)
            || !recipient || /inactive|terminated|exited|offboard|separated/i.test(`${recipient.status} ${recipient.employement_status}`);
          if (obsolete) {
            await tx.perfReminderIntent.update({ where: { id: intent.id }, data: { state: 'CANCELLED' } });
            return 'cancelled';
          }
          if (+due > +now) return 'skipped';
          if (!recipient.userId) throw new Error('Recipient has no linked RBAC account');
          const receipt = await deliver({ tenantId, employeeId: recipient.id, userId: recipient.userId,
            intentId: intent.id, reviewId: review.id, stage: intent.stage, dueAt: intent.dueAt });
          const notificationId = z.string().uuid().parse(receipt?.notificationId);
          await tx.perfReminderIntent.update({ where: { id: intent.id },
            data: { state: 'ACCEPTED', hubReceipt: notificationId } });
          return 'accepted';
        });
        result[outcome]++;
      } catch {
        // Rollback keeps PENDING. Hub's stable dedupe key makes a crash after
        // acceptance safe to replay. Do not log credentials or employee data.
        result.failed++;
      }
    }
    return result;
  });
}
