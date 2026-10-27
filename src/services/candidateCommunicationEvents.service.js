import { EventEnvelope } from "@trusoft/contracts/envelopes";
import { eventPayloadSchema } from "@trusoft/contracts/events";
import logger from "../lib/logger.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { enqueueCandidateCommunication } from "./candidateCommunicationQueue.service.js";
import { readRecruitmentSettings } from "./recruitmentSettings.service.js";
const eventKey = (name) =>
  String(name)
    .replace(/^hr\.recruitment\./, "")
    .replace(/\.v1$/, "");
const mapped = {
  interview_scheduled: "interview_scheduled",
  interview_rescheduled: "interview_rescheduled",
  interview_cancelled: "interview_cancelled",
  interview_reschedule_requested: "interview_update",
  interview_outcome_recorded: "interview_update",
  offer_sent: "offer_sent",
  offer_accepted: "offer_accepted",
  offer_expired: "offer_expired",
  offer_declined: "offer_update",
  offer_withdrawn: "offer_update",
};
const positive = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
export async function projectCandidateCommunicationEvent(
  db,
  row,
  { now = new Date() } = {},
) {
  const checked = EventEnvelope.safeParse(row.payload);
  const schema = eventPayloadSchema(row.eventName);
  if (
    !checked.success ||
    checked.data.name !== row.eventName ||
    checked.data.tenantId !== row.tenantId ||
    (schema && !schema.safeParse(checked.data.payload).success)
  )
    throw Object.assign(
      new Error("Event does not match its recruitment contract"),
      { code: "HR-5806", permanent: true },
    );
  const envelope = checked.data,
    p = envelope.payload ?? {},
    key = eventKey(row.eventName),
    tenantId = row.tenantId;
  const { policy } = await readRecruitmentSettings(db, tenantId);
  let applicationId = positive(p.applicationId),
    interviewId = positive(p.interviewId),
    offerId = positive(p.offerId),
    templateKey = mapped[key],
    applications = [];
  if (key === "application_stage_changed")
    templateKey =
      p.toStage === "rejected"
        ? "application_rejected"
        : "application_stage_changed";
  if (key === "requisition_closed") {
    templateKey = "requisition_closed";
    applications = await db.application.findMany({
      where: {
        tenantId,
        jobRequisitionId: positive(p.requisitionId) ?? -1,
        id: { gt: row.communicationCursor },
        stage: { notIn: ["hired", "rejected", "withdrawn"] },
        candidate: { anonymizedAt: null },
        NOT: { offer: { status: "ACCEPTED" } },
      },
      select: { id: true, candidateId: true },
      orderBy: { id: "asc" },
      take: 100,
    });
  } else if (templateKey) {
    if (!applicationId && interviewId)
      applicationId = (
        await db.interview.findFirst({
          where: { id: interviewId, tenantId },
          select: { applicationId: true },
        })
      )?.applicationId;
    if (!applicationId && offerId)
      applicationId = (
        await db.offer.findFirst({
          where: { id: offerId, tenantId },
          select: { applicationId: true },
        })
      )?.applicationId;
    if (applicationId) {
      const app = await db.application.findFirst({
        where: { tenantId, id: applicationId },
        select: { id: true, candidateId: true },
      });
      if (app) applications = [app];
    }
  }
  for (const app of applications) {
    const context = {};
    if (interviewId) context.interviewId = interviewId;
    if (offerId) context.offerId = offerId;
    if (key === "application_stage_changed") {
      context.expectedStage = p.toStage;
      if (positive(p.applicationVersion))
        context.expectedApplicationVersion = positive(p.applicationVersion);
    }
    if (
      [
        "offer_sent",
        "offer_accepted",
        "offer_expired",
        "offer_declined",
        "offer_withdrawn",
      ].includes(key)
    )
      context.expectedOfferStatus = key.slice(6).toUpperCase();
    if (p.scheduledAt || p.newScheduledAt)
      context.eventTime = new Date(
        p.newScheduledAt ?? p.scheduledAt,
      ).toISOString();
    const occurred = new Date(envelope.occurredAt ?? row.createdAt);
    let scheduledAt =
      templateKey === "application_rejected"
        ? new Date(occurred.getTime() + policy.rejectionDelayHours * 3600000)
        : occurred;
    if (templateKey === "application_rejected") {
      const automatic = await db.applicationAutoDisposition.findUnique({
        where: { applicationId: app.id },
      });
      if (
        automatic &&
        automatic.rejectionVersion === context.expectedApplicationVersion
      )
        scheduledAt = automatic.noticeDueAt;
    }
    await enqueueCandidateCommunication(db, {
      tenantId,
      candidateId: app.candidateId,
      applicationId: app.id,
      templateKey,
      sourceEventId: envelope.id,
      dedupeKey: "event:" + envelope.id + ":" + app.id,
      context,
      scheduledAt,
    });
  }
  const more = key === "requisition_closed" && applications.length === 100;
  await db.outboxEvent.update({
    where: { id: row.id },
    data: {
      communicationProcessedAt: more ? null : now,
      communicationNextAttemptAt: null,
      communicationLastError: null,
      communicationCursor: applications.at(-1)?.id ?? row.communicationCursor,
    },
  });
  return applications.length;
}
export async function runCandidateCommunicationProjection({
  now = new Date(),
  limit = 100,
  tenantId,
  project = projectCandidateCommunicationEvent,
} = {}) {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      eventName: { startsWith: "hr.recruitment." },
      communicationProcessedAt: null,
      communicationFailedAt: null,
      OR: [
        { communicationNextAttemptAt: null },
        { communicationNextAttemptAt: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, tenantId: true },
    take: Math.max(1, Math.min(limit, 500)),
  });
  let queued = 0,
    retried = 0,
    failed = 0,
    unavailable = 0;
  for (const row of rows)
    try {
      const outcome = await runWithRequestContext(
        { system: false, user: { tenantId: row.tenantId } },
        () =>
          tenantTransaction(
            prisma,
            async (db) => {
              const claimed =
                await db.$queryRaw`SELECT id FROM outbox_events WHERE id=${row.id} AND "tenantId"=${row.tenantId}::uuid AND "communicationProcessedAt" IS NULL AND "communicationFailedAt" IS NULL AND ("communicationNextAttemptAt" IS NULL OR "communicationNextAttemptAt" <= ${now}) FOR UPDATE SKIP LOCKED`;
              if (!claimed.length) return {};
              const current = await db.outboxEvent.findUnique({
                where: { id: row.id },
              });
              // Hold the row lock across rollback so another worker cannot observe
              // partially enqueued messages or race the retry-state update.
              await db.$executeRawUnsafe(
                "SAVEPOINT candidate_communication_projection",
              );
              try {
                const count = await project(db, current, { now });
                await db.$executeRawUnsafe(
                  "RELEASE SAVEPOINT candidate_communication_projection",
                );
                return { queued: count };
              } catch (error) {
                await db.$executeRawUnsafe(
                  "ROLLBACK TO SAVEPOINT candidate_communication_projection",
                );
                const attempts = current.communicationAttempts + 1;
                const permanent =
                  error.permanent === true || error.name === "ZodError";
                const exhausted = permanent || attempts >= 5;
                await db.outboxEvent.update({
                  where: { id: row.id },
                  data: {
                    communicationAttempts: attempts,
                    communicationFailedAt: exhausted ? now : null,
                    communicationNextAttemptAt: exhausted
                      ? null
                      : new Date(
                          now.getTime() +
                            Math.min(60, 2 ** (attempts - 1)) * 60000,
                        ),
                    communicationLastError: permanent
                      ? "EVENT_CONTRACT_INVALID"
                      : exhausted
                        ? "PROJECTION_ATTEMPTS_EXHAUSTED"
                        : "PROJECTION_RETRY_PENDING",
                  },
                });
                await db.$executeRawUnsafe(
                  "RELEASE SAVEPOINT candidate_communication_projection",
                );

                logger.warn(
                  {
                    eventId: row.id,
                    tenantId: row.tenantId,
                    attempts,
                    terminal: exhausted,
                  },
                  "Candidate communication event deferred",
                );
                return exhausted ? { failed: 1 } : { retried: 1 };
              }
            },
            { tenantId: row.tenantId, txOptions: { timeout: 30000 } },
          ),
      );
      queued += outcome.queued ?? 0;
      retried += outcome.retried ?? 0;
      failed += outcome.failed ?? 0;
    } catch {
      unavailable++;
      logger.warn(
        { eventId: row.id, tenantId: row.tenantId },
        "Candidate communication projection transaction unavailable",
      );
    }
  return { queued, retried, failed, unavailable };
}
