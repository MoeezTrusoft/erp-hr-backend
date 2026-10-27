import prisma from "../lib/prisma.js";
import { userIdToUuid } from "@trusoft/contracts/identity";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { interviewReminderKind } from "./interviewReminders.service.js";
const HOUR = 3600000;
export function interviewStaffActions(row, now) {
  const panel = row.interviewers.map((p) => p.employeeId);
  const completed = new Set(
    row.scorecards.filter((c) => c.submittedAt).map((c) => c.reviewerId),
  );
  const missing = panel.filter((id) => !completed.has(id));
  const req = row.application.jobRequisition;
  if (row.status === "NO_SHOW")
    return [{ kind: "NO_SHOW_REVIEW", ids: [req.recruiterId] }];
  const before = interviewReminderKind(row.scheduledAt, now);
  if (before) return [{ kind: before, ids: panel }];
  if (+row.scheduledAt > +now) return [];
  if (panel.length && !missing.length && !row.decision)
    return [{ kind: "DECISION_DUE", ids: [req.requestedById] }];
  const elapsed = +now - (+row.scheduledAt + row.durationMinutes * 60000);
  if (missing.length && elapsed >= 24 * HOUR)
    return [{ kind: "FEEDBACK_OVERDUE", ids: [req.recruiterId] }];
  if (missing.length && elapsed >= 2 * HOUR)
    return [{ kind: "FEEDBACK_DUE", ids: missing }];
  return [];
}
export async function runInterviewStaffNotices({
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
  const filter = {
    tenantId: tenantId ?? { not: null },
    status: { in: ["SCHEDULED", "NO_SHOW"] },
    scheduledAt: { lte: new Date(+now + 24 * HOUR) },
  };
  const tenants = await prisma.interview.findMany({
    where: filter,
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  const result = { scanned: 0, enqueued: 0, paused: 0, unroutable: 0 };
  for (const tenant of tenants)
    await runWithRequestContext(
      { system: false, user: { tenantId: tenant.tenantId } },
      async () => {
        let cursor = 0;
        for (;;) {
          const page = await prisma.interview.findMany({
            where: { ...filter, tenantId: tenant.tenantId, id: { gt: cursor } },
            select: { id: true, applicationId: true },
            orderBy: { id: "asc" },
            take: 200,
          });
          for (const ref of page) {
            result.scanned++;
            await tenantTransaction(
              prisma,
              async (db) => {
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
                      include: {
                        candidate: {
                          select: {
                            tenantId: true,
                            status: true,
                            anonymizedAt: true,
                          },
                        },
                        jobRequisition: {
                          select: {
                            tenantId: true,
                            recruiterId: true,
                            requestedById: true,
                          },
                        },
                      },
                    },
                    interviewers: {
                      where: { tenantId: tenant.tenantId },
                      select: { employeeId: true },
                    },
                    scorecards: {
                      where: { tenantId: tenant.tenantId },
                      select: { reviewerId: true, submittedAt: true },
                    },
                  },
                });
                if (
                  !row ||
                  !["SCHEDULED", "NO_SHOW"].includes(row.status) ||
                  row.application.tenantId !== tenant.tenantId ||
                  row.application.jobRequisition.tenantId !== tenant.tenantId ||
                  row.application.candidate.tenantId !== tenant.tenantId ||
                  row.application.candidate.status !== "active" ||
                  row.application.candidate.anonymizedAt ||
                  ["hired", "rejected", "withdrawn"].includes(
                    row.application.stage,
                  )
                )
                  return;
                const latest = await db.interviewLifecycleEvent.findFirst({
                  where: { tenantId: tenant.tenantId, interviewId: row.id },
                  orderBy: { id: "desc" },
                  select: { id: true, eventType: true },
                });
                if (latest?.eventType === "RESCHEDULE_REQUESTED") {
                  result.paused++;
                  return;
                }
                for (const action of interviewStaffActions(row, now)) {
                  const wanted = [
                    ...new Set(action.ids.filter(Number.isSafeInteger)),
                  ];
                  const recipients = wanted.length
                    ? await db.employee.findMany({
                        where: {
                          tenant_id: tenant.tenantId,
                          id: { in: wanted },
                          status: "Active",
                          employement_status: "Active",
                          userId: { gt: 0 },
                        },
                        select: { id: true, userId: true },
                      })
                    : [];
                  result.unroutable += wanted.length
                    ? wanted.length - recipients.length
                    : 1;
                  for (const recipient of recipients) {
                    const inserted = await db.$queryRawUnsafe(
                      'INSERT INTO "InterviewStaffNotice" ("tenantId","interviewId","recipientUserId","scheduledAt","scheduleRevision",kind,"createdAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
                      tenant.tenantId,
                      row.id,
                      recipient.userId,
                      row.scheduledAt,
                      latest?.id ?? 0,
                      action.kind,
                      now,
                    );
                    if (!inserted.length) continue;
                    await enqueueHrDomainEvent(db, {
                      tenantId: tenant.tenantId,
                      eventName: "hr.recruitment.interview_action_due.v1",
                      aggregateType: "Interview",
                      aggregateId: String(row.id),
                      occurredAt: now.toISOString(),
                      payload: {
                        interviewId: String(row.id),
                        applicationId: String(row.applicationId),
                        scheduledAt: row.scheduledAt.toISOString(),
                        kind: action.kind,
                        recipientUserIds: [
                          userIdToUuid(tenant.tenantId, recipient.userId),
                        ],
                      },
                    });
                    result.enqueued++;
                  }
                }
              },
              {
                tenantId: tenant.tenantId,
                txOptions: { maxWait: 10000, timeout: 30000 },
              },
            );
          }
          if (page.length < 200) break;
          cursor = page.at(-1).id;
        }
      },
    );
  return result;
}
