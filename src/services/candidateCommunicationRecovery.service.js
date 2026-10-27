import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { currentCorrelationId } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
const safeSelect = {
  id: true,
  eventName: true,
  aggregateType: true,
  aggregateId: true,
  createdAt: true,
  communicationAttempts: true,
  communicationLastError: true,
  communicationNextAttemptAt: true,
  communicationFailedAt: true,
  communicationCursor: true,
};
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5806" });
};
async function context(permission) {
  const tenantId = getCtx().user?.tenantId;
  const { who } = await requireRecruitmentActor({
    tenantId,
    permission,
    allowedScopes: ["ORG"],
    adminOnly: true,
  });
  return { tenantId, who };
}
export async function communicationFailuresList({
  page = 1,
  pageSize = 25,
} = {}) {
  const { tenantId } = await context("hr.recruitment.read");
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    fail("Invalid page", 400);
  return tenantTransaction(
    prisma,
    async (db) => {
      const where = {
        tenantId,
        eventName: { startsWith: "hr.recruitment." },
        communicationProcessedAt: null,
        communicationLastError: { not: null },
      };
      return {
        items: await db.outboxEvent.findMany({
          where,
          select: safeSelect,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        total: await db.outboxEvent.count({ where }),
        page,
        pageSize,
      };
    },
    { tenantId },
  );
}
export async function communicationEventRetry({
  id,
  expectedAttempts,
  reason,
}) {
  const { tenantId, who } = await context("hr.recruitment.update");
  if (
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.length > 2000
  )
    fail("Explain the recovery action in 10 to 2000 characters", 422);
  return tenantTransaction(
    prisma,
    async (db) => {
      await db.$queryRawUnsafe(
        'SELECT id FROM outbox_events WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        id,
        tenantId,
      );
      const row = await db.outboxEvent.findFirst({
        where: { id, tenantId, eventName: { startsWith: "hr.recruitment." } },
      });
      if (!row) fail("Communication event not found", 404);
      if (row.communicationProcessedAt || !row.communicationLastError)
        fail("This event no longer needs recovery");
      if (row.communicationAttempts !== expectedAttempts)
        fail("Event changed; refresh before retrying", 412);
      const updated = await db.outboxEvent.update({
        where: { id },
        data: {
          communicationAttempts: 0,
          communicationNextAttemptAt: null,
          communicationFailedAt: null,
          communicationLastError: null,
        },
        select: safeSelect,
      });
      await db.log.create({
        data: {
          tenantId,
          employeeId: who.id,
          actionById: who.id,
          type: "Update",
          action_type: "CANDIDATE_COMMUNICATION_EVENT_RETRY",
          module: "Recruitment communications",
          result: "SUCCESS",
          ip: "unknown",
          os: "server",
          notes: "Event " + id + ": " + reason.trim(),
          correlationId: currentCorrelationId() ?? null,
        },
      });
      return updated;
    },
    { tenantId },
  );
}
