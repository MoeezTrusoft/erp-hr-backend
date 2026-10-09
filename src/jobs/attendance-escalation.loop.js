import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { mcpCtx } from '../mcp/context.js';
import logger from '../lib/logger.js';
import { enqueueHrDomainEvent } from '../services/hrDomainEvent.service.js';

export async function escalateAttendanceRequests({
  now = new Date(),
  afterId = 0,
} = {}) {
  const rows = await prisma.attendanceAnomaly.findMany({
    where: {
      id: { gt: afterId },
      status: 'PENDING',
      sourceKind: { in: ['REGULARIZATION', 'PAPER_FORM'] },
    },
    take: 1000,
    orderBy: { id: 'asc' },
  });
  let advanced = 0;
  for (const row of rows) {
    const chain = Array.isArray(row.routingSnapshot) ? row.routingSnapshot : [];
    const current = chain.find((c) => c.level === row.currentApprovalLevel);
    if (
      !current?.autoEscalateAfterHours ||
      now - new Date(row.approvalEnteredAt) <
        current.autoEscalateAfterHours * 3600000
    )
      continue;
    // Escalation assigns responsibility to the next configured approver; it
    // never records an approval or skips an unresolved mandatory level.
    const remaining = chain.filter((c) => c.level > current.level);
    const next = remaining.find((c) => c.resolved || !c.skippable);
    if (!next?.resolved) continue;
    await mcpCtx.run({ user: { tenantId: row.tenantId } }, () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          const changed = await tx.attendanceAnomaly.updateMany({
            where: {
              id: row.id,
              tenantId: row.tenantId,
              status: 'PENDING',
              workflowVersion: row.workflowVersion,
              currentApprovalLevel: row.currentApprovalLevel,
            },
            data: {
              currentApprovalLevel: next.level,
              approvalEnteredAt: now,
              workflowVersion: { increment: 1 },
              workflowHistory: [
                ...(Array.isArray(row.workflowHistory)
                  ? row.workflowHistory
                  : []),
                {
                  action: 'ESCALATED',
                  at: now.toISOString(),
                  fromLevel: current.level,
                  toLevel: next.level,
                  approverId: next.approverId,
                },
              ],
            },
          });
          advanced += changed.count;
          if (changed.count)
            await enqueueHrDomainEvent(tx, {
              eventName: 'hr.attendance.approval_escalated.v1',
              tenantId: row.tenantId,
              aggregateType: 'AttendanceAnomaly',
              aggregateId: row.id,
              actorId: 'attendance-escalation',
              payload: {
                anomalyId: String(row.id),
                employeeId: String(row.employeeId),
                approverId: String(next.approverId),
                fromLevel: current.level,
                toLevel: next.level,
              },
            });
        },
        { tenantId: row.tenantId },
      ),
    );
  }
  return {
    examined: rows.length,
    advanced,
    nextCursor: rows.length === 1000 ? rows.at(-1).id : 0,
  };
}
export function startAttendanceEscalationWorker() {
  if (process.env.NODE_ENV === 'test') return { stop() {} };
  let running = false,
    afterId = 0;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await mcpCtx.run({ system: true }, () =>
        escalateAttendanceRequests({ afterId }),
      );
      afterId = result.nextCursor;
    } catch (err) {
      logger.error({ err }, 'Attendance escalation sweep failed');
    } finally {
      running = false;
    }
  }, 60000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
