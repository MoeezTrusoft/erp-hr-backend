import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { actor } from "./separation/base.js";
import {
  resolveRecruitmentScope,
  candidateScopeWhere,
} from "../lib/recruitmentAccess.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const fail = (message, status = 403) => {
  throw Object.assign(new Error(message), { status, code: "HR-5805" });
};
async function authorized(permission, fn) {
  const ctx = getCtx();
  if (
    !ctx.actorVerified ||
    !ctx.user?.tenantId ||
    !ctx.permissions?.includes(permission)
  )
    fail("Recruitment permission required");
  return tenantTransaction(
    prisma,
    async (db) => {
      const who = await actor(db, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (!["ORG", "MANAGED"].includes(scope.level))
        fail(
          "Candidate communication access requires a recruiter or hiring manager",
        );
      return fn(db, { tenantId: ctx.user.tenantId, who, scope });
    },
    { tenantId: ctx.user.tenantId },
  );
}
async function owner(db, env, candidateId) {
  const candidate = await db.candidate.findFirst({
    where: {
      id: Number(candidateId),
      tenantId: env.tenantId,
      anonymizedAt: null,
      ...candidateScopeWhere(env.scope),
    },
    select: { id: true },
  });
  if (!candidate) fail("Candidate not found", 404);
  return candidate;
}
const safeSelect = {
  id: true,
  candidateId: true,
  applicationId: true,
  templateKey: true,
  templateVersion: true,
  channel: true,
  purpose: true,
  status: true,
  scheduledAt: true,
  expiresAt: true,
  attempts: true,
  providerRef: true,
  lastError: true,
  sentAt: true,
  createdAt: true,
};
export const candidateCommunicationsList = ({
  candidateId,
  page = 1,
  pageSize = 25,
}) =>
  authorized("hr.recruitment.read", async (db, env) => {
    await owner(db, env, candidateId);
    const where = { tenantId: env.tenantId, candidateId: Number(candidateId) };
    const items = await db.candidateCommunication.findMany({
      where,
      select: safeSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items,
      total: await db.candidateCommunication.count({ where }),
      page,
      pageSize,
    };
  });
async function change({ id, reason }, retry) {
  return authorized("hr.recruitment.update", async (db, env) => {
    await db.$executeRaw`SELECT id FROM candidate_communications WHERE id=${id} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
    const row = await db.candidateCommunication.findFirst({
      where: { id, tenantId: env.tenantId },
    });
    if (!row) fail("Message not found", 404);
    await owner(db, env, row.candidateId);
    if (
      retry
        ? row.status !== "FAILED"
        : !["PENDING", "FAILED"].includes(row.status)
    )
      fail(
        retry
          ? "Only failed messages can be retried"
          : "Only pending or failed messages can be cancelled",
        409,
      );
    if (retry && row.expiresAt && row.expiresAt <= new Date())
      fail("This message expired; issue a new message", 409);
    if (String(reason ?? "").trim().length < 10)
      fail("Explain this action in at least 10 characters", 422);
    const updated = await db.candidateCommunication.update({
      where: { id },
      data: {
        status: retry ? "PENDING" : "CANCELLED",
        attempts: retry ? 0 : row.attempts,
        scheduledAt: retry ? new Date() : row.scheduledAt,
        lastError: retry ? null : "Cancelled by recruiter",
        encryptedPayload: retry ? undefined : null,
        context: {
          ...row.context,
          operatorActions: [
            ...(row.context?.operatorActions ?? []),
            {
              action: retry ? "RETRY" : "CANCEL",
              actorId: env.who.id,
              reason: reason.trim(),
              at: new Date().toISOString(),
            },
          ],
        },
      },
      select: safeSelect,
    });
    await enqueueHrDomainEvent(db, {
      tenantId: env.tenantId,
      actorId: env.who.id,
      eventName: retry
        ? "hr.recruitment.communication_retry_requested.v1"
        : "hr.recruitment.communication_cancelled.v1",
      aggregateType: "CandidateCommunication",
      aggregateId: id,
      payload: { communicationId: id, candidateId: String(row.candidateId) },
    });
    return updated;
  });
}
export const candidateCommunicationRetry = (args) => change(args, true);
export const candidateCommunicationCancel = (args) => change(args, false);
