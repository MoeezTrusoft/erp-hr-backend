import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../lib/requestContext.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { launchBatch } from "./core.js";

export function launchWork(tenantId, { cycleId } = {}) {
  return mcpCtx.run(
    { user: { tenantId }, servicePrincipal: "svc:hr-appraisals" },
    () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          const config = await tx.perfConfiguration.findUnique({
            where: { tenantId },
          });
          if (!config?.coreEnabled)
            return cycleId ? { done: true, disabled: true } : [];
          if (cycleId) return launchBatch(tx, tenantId, cycleId);
          return tx.perfLaunchRun.findMany({
            where: { tenantId, state: { in: ["QUEUED", "RUNNING"] } },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: 100,
          });
        },
        {
          tenantId,
          txOptions: { isolationLevel: "Serializable", timeout: 30000 },
        },
      ),
  );
}

// PostgreSQL is the recovery journal. Reconcile Redis after a crash or an outage.
export async function reconcileLaunches(queue, tenantId) {
  const runs = await launchWork(tenantId);
  for (const run of runs) {
    const previous = await queue.getJob(run.jobId);
    if (previous) {
      const state = await previous.getState();
      if (state === "failed") {
        // Exhausted jobs require an explicit HR Resume command before another attempt.
        if (run.state === "QUEUED") await previous.retry();
        continue;
      }
      if (state !== "completed") continue;
      await previous.remove();
    }
    await queue.add(
      "launch",
      { tenantId, cycleId: run.cycleId },
      {
        jobId: run.jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
  }
  return runs.length;
}

export async function scanCompany(
  tenantId,
  { now = new Date(), limit = 250, cursor } = {},
) {
  return mcpCtx.run(
    { user: { tenantId }, servicePrincipal: "svc:hr-appraisals" },
    () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          const config = await tx.perfConfiguration.findUnique({
            where: { tenantId },
          });
          if (!config?.coreEnabled) return { disabled: true };
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":appraisal-scan"},0))`;
          const reviews = await tx.perfReview.findMany({
            where: {
              tenantId,
              ...(cursor ? { id: { gt: cursor } } : {}),
              OR: [
                { state: "SELF_OPEN", selfDue: { lte: now } },
                {
                  state: { in: ["SELF_SUBMITTED", "CORRECTION_OPEN"] },
                  managerDue: { lte: now },
                },
              ],
            },
            orderBy: { id: "asc" },
            take: limit,
          });
          let reminders = 0;
          for (const r of reviews) {
            const self = r.state === "SELF_OPEN";
            const recipientId = self ? r.employeeId : r.managerId;
            const employee = await tx.employee.findFirst({
              where: { tenant_id: tenantId, id: r.employeeId },
              select: { managerId: true },
            });
            if (!self && employee?.managerId !== recipientId) continue;
            const dueAt = self ? r.selfDue : r.managerDue;
            const scheduleVersion = r.scheduleVersion;
            const stage =
              (self ? "SELF" : "MANAGER") +
              "_" +
              now.toISOString().slice(0, 10);
            if (
              await tx.perfReminderIntent.findFirst({
                where: {
                  tenantId,
                  reviewId: r.id,
                  recipientId,
                  scheduleVersion,
                  stage,
                },
              })
            )
              continue;
            const intent = await tx.perfReminderIntent.create({
              data: {
                tenantId,
                reviewId: r.id,
                recipientId,
                scheduleVersion,
                stage,
                dueAt,
              },
            });
            await enqueueHrDomainEvent(tx, {
              tenantId,
              eventName: "hr.performance.action.due.v1",
              actorId: "svc:hr-appraisals",
              actorType: "service",
              aggregateType: "AppraisalReminder",
              aggregateId: intent.id,
              correlationId: randomUUID(),
              payload: {
                aggregateId: intent.id,
                aggregateVersion: 0,
                cycleId: r.cycleId,
                schemaVersion: 1,
              },
            });
            reminders++;
          }
          return {
            reminders,
            scanned: reviews.length,
            nextCursor: reviews.length === limit ? reviews.at(-1).id : null,
          };
        },
        {
          tenantId,
          txOptions: { isolationLevel: "Serializable", timeout: 30000 },
        },
      ),
  );
}
