import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { actor } from "./separation/base.js";
import {
  resolveRecruitmentScope,
  applicationScopeWhere,
} from "../lib/recruitmentAccess.js";
import { readRecruitmentSettings } from "./recruitmentSettings.service.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5303" });
};
// Called only inside the scoring worker's locked transaction. A fit score never
// rejects someone: only an explicit failed answer to a frozen required knockout.
export async function applyAutomaticKnockout(
  db,
  { tenantId, applicationId, score, now = new Date() },
) {
  if (
    !score.knockoutFailed ||
    !score.explanation?.features?.knockouts?.some((k) => k.passed === false)
  )
    return null;
  const { version, policy } = await readRecruitmentSettings(db, tenantId);
  if (!version || !policy.autoRejectKnockouts) return null;
  const app = await db.application.findFirst({
    where: { id: applicationId, tenantId },
    include: { candidate: true, jobRequisition: true },
  });
  if (
    !app ||
    app.stage !== "applied" ||
    app.candidate.anonymizedAt ||
    !["APPROVED", "POSTED"].includes(app.jobRequisition.status)
  )
    return null;
  if (
    await db.applicationAutoDisposition.findUnique({ where: { applicationId } })
  )
    return null;
  const latest = await db.applicationScore.findFirst({
    where: { applicationId, tenantId },
    orderBy: [{ scoredAt: "desc" }, { id: "desc" }],
  });
  if (latest?.id !== score.id) fail("Knockout evidence changed");
  const row = await db.applicationAutoDisposition.create({
    data: {
      tenantId,
      applicationId,
      scoreId: score.id,
      policyVersion: version,
      rejectionVersion: app.version + 1,
      previousStage: app.stage,
      noticeDueAt: new Date(
        now.getTime() + policy.rejectionDelayHours * 3600000,
      ),
    },
  });
  await transitionApplicationStage({
    db,
    id: applicationId,
    tenantId,
    targetStage: "rejected",
    expectedVersion: app.version,
    reason: "MINIMUM_REQUIREMENTS_NOT_MET",
    source: "automatic_knockout",
  });
  return row;
}
export async function reverseAutomaticKnockout({
  applicationId,
  expectedVersion,
  reason,
}) {
  const ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  if (
    !ctx.actorVerified ||
    !tenantId ||
    !ctx.permissions?.includes("hr.recruitment.update")
  )
    fail("Recruitment update permission required", 403);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    fail("Application version is required", 422);
  if (
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.length > 2000
  )
    fail("Explain the reversal in 10 to 2,000 characters", 422);
  return tenantTransaction(
    prisma,
    async (db) => {
      const who = await actor(db, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (scope.level !== "ORG")
        fail("Recruiter permission required", 403);
      await db.$queryRawUnsafe(
        'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        Number(applicationId),
        tenantId,
      );
      const app = await db.application.findFirst({
        where: {
          id: Number(applicationId),
          tenantId,
          ...applicationScopeWhere(scope),
          candidate: { anonymizedAt: null },
        },
        select: { id: true },
      });
      if (!app) fail("Application not found", 404);
      const row = await db.applicationAutoDisposition.findUnique({
        where: { applicationId: app.id },
      });
      if (!row || row.reversedAt) fail("No reversible automatic rejection");
      const result = await transitionApplicationStage({
        db,
        id: app.id,
        tenantId,
        targetStage: row.previousStage,
        expectedVersion,
        scope,
        reason: reason.trim(),
        actorId: who.id,
        automaticReversalId: row.id,
      });
      // Capture after transition validation, within the same transaction and window.
      const now = new Date();
      if (now >= row.noticeDueAt) fail("The reversal window has closed");
      await db.applicationAutoDisposition.update({
        where: { id: row.id },
        data: {
          reversedAt: now,
          reversedById: who.id,
          reversalReason: reason.trim(),
        },
      });
      await db.candidateCommunication.updateMany({
        where: {
          tenantId,
          applicationId: app.id,
          templateKey: "application_rejected",
          status: { in: ["PENDING", "FAILED"] },
          context: {
            path: ["expectedApplicationVersion"],
            equals: row.rejectionVersion,
          },
        },
        data: {
          status: "CANCELLED",
          lastError: "Automatic rejection reversed before notice",
          encryptedPayload: null,
        },
      });
      return {
        applicationId: app.id,
        stage: result.data.stage,
        version: result.data.version,
        reversedAt: now,
      };
    },
    { tenantId, txOptions: { timeout: 30000 } },
  );
}
