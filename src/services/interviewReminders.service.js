import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueCandidateCommunication } from "./candidateCommunicationQueue.service.js";
const HOUR = 3600000;
export function interviewReminderKind(scheduledAt, now) {
  const remaining = +new Date(scheduledAt) - +now;
  return remaining > 0 && remaining <= HOUR
    ? "ONE_HOUR"
    : remaining > HOUR && remaining <= 24 * HOUR
      ? "DAY_BEFORE"
      : null;
}
export async function runInterviewReminders({
  now = new Date(),
  tenantId,
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
      code: "HR-5304",
    });
  if (!isRecruitmentFlagEnabled("communications"))
    return { skipped: true, reason: "flag-disabled" };
  const window = { gt: now, lte: new Date(+now + 24 * HOUR) };
  const tenants = await prisma.interview.findMany({
    where: {
      tenantId: tenantId ?? { not: null },
      status: "SCHEDULED",
      scheduledAt: window,
    },
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  const result = { scanned: 0, eligible: 0, paused: 0 };
  for (const tenant of tenants)
    await runWithRequestContext(
      { system: false, user: { tenantId: tenant.tenantId } },
      async () => {
        let cursor = 0;
        for (;;) {
          const page = await prisma.interview.findMany({
            where: {
              tenantId: tenant.tenantId,
              id: { gt: cursor },
              status: "SCHEDULED",
              scheduledAt: window,
            },
            select: { id: true, applicationId: true },
            orderBy: { id: "asc" },
            take: 200,
          });
          for (const ref of page) {
            result.scanned++;
            await tenantTransaction(
              prisma,
              async (db) => {
                // Match the application -> interview lock order used by candidate requests.
                await db.$queryRawUnsafe(
                  'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
                  ref.applicationId,
                  tenant.tenantId,
                );
                await db.$queryRawUnsafe(
                  'SELECT id FROM interviews WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
                  ref.id,
                  tenant.tenantId,
                );
                const row = await db.interview.findFirst({
                  where: { id: ref.id, tenantId: tenant.tenantId },
                  include: {
                    application: {
                      select: {
                        candidateId: true,
                        stage: true,
                        candidate: {
                          select: { status: true, anonymizedAt: true },
                        },
                      },
                    },
                  },
                });
                if (
                  !row ||
                  row.status !== "SCHEDULED" ||
                  ["hired", "rejected", "withdrawn"].includes(
                    row.application.stage,
                  ) ||
                  row.application.candidate.anonymizedAt ||
                  row.application.candidate.status !== "active"
                )
                  return;
                const kind = interviewReminderKind(row.scheduledAt, now);
                if (!kind) return;
                const latest = await db.interviewLifecycleEvent.findFirst({
                  where: { tenantId: tenant.tenantId, interviewId: row.id },
                  orderBy: { id: "desc" },
                  select: { id: true, eventType: true },
                });
                if (latest?.eventType === "RESCHEDULE_REQUESTED") {
                  result.paused++;
                  return;
                }
                const lifecycleId = latest?.id ?? 0;
                await enqueueCandidateCommunication(db, {
                  tenantId: tenant.tenantId,
                  candidateId: row.application.candidateId,
                  applicationId: row.applicationId,
                  templateKey: "interview_reminder",
                  dedupeKey:
                    "interview-reminder:" +
                    row.id +
                    ":" +
                    row.scheduledAt.toISOString() +
                    ":" +
                    lifecycleId +
                    ":" +
                    kind,
                  context: {
                    interviewId: row.id,
                    eventTime: row.scheduledAt.toISOString(),
                    reminderKind: kind,
                    interviewLifecycleId: lifecycleId,
                  },
                  scheduledAt: now,
                  expiresAt:
                    kind === "DAY_BEFORE"
                      ? new Date(+row.scheduledAt - HOUR)
                      : row.scheduledAt,
                });
                result.eligible++;
              },
              { tenantId: tenant.tenantId },
            );
          }
          if (page.length < 200) break;
          cursor = page.at(-1).id;
        }
      },
    );
  return result;
}
