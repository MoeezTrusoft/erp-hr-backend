import { Prisma } from "@prisma/client";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { readRecruitmentSettings } from "./recruitmentSettings.service.js";
import { applicationKnockoutEvidence } from "../lib/applicationQuestionSnapshot.js";
import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { actor } from "./separation/base.js";
import {
  resolveRecruitmentScope,
  applicationScopeWhere,
  requisitionScopeWhere,
} from "../lib/recruitmentAccess.js";
import { buildAliasIndex } from "../lib/skillNormalization.js";
import {
  calculateApplicationFit,
  requisitionSkillRequirements,
} from "../lib/applicationFitScore.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const fail = (message, status = 403) => {
  throw Object.assign(new Error(message), { status, code: "HR-5302" });
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
          "Screening evidence is restricted to recruiters and hiring managers",
        );
      if (permission === "hr.recruitment.update" && scope.level !== "ORG")
        fail(
          "Only recruiters can refresh scoring evidence or propose a shortlist",
        );
      return fn(db, { tenantId: ctx.user.tenantId, scope, who });
    },
    { tenantId: ctx.user.tenantId, txOptions: { timeout: 30000 } },
  );
}
export async function refreshFitScore(
  db,
  { tenantId, applicationId, scope, actorId },
) {
  const owner = await db.application.findFirst({
    where: {
      tenantId,
      id: Number(applicationId),
      ...(scope ? applicationScopeWhere(scope) : {}),
    },
    select: { candidateId: true },
  });
  if (!owner) fail("Application not found", 404);
  // Match erasure's lock order; no score can be created after child data is erased.
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    owner.candidateId,
    tenantId,
  );
  await db.$executeRaw`SELECT id FROM "Application" WHERE id=${Number(applicationId)} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
  const application = await db.application.findFirst({
    where: {
      tenantId,
      id: Number(applicationId),
      ...(scope ? applicationScopeWhere(scope) : {}),
    },
    include: {
      candidate: { include: { candidateSkills: true } },
      jobRequisition: true,
      answers: { include: { question: true } },
    },
  });
  if (!application || application.candidate.anonymizedAt)
    fail("Application not found", 404);
  await assertCommunicationsAllowed(
    {
      tenantId,
      candidateId: application.candidateId,
      purpose: "PROCESSING",
      requireExplicitConsent: true,
    },
    { db },
  );
  const aliases = await db.skillAlias.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }], status: "ACTIVE" },
    select: {
      alias: true,
      skillId: true,
      scope: true,
      status: true,
      tenantId: true,
    },
  });
  const skills = await db.skill.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }] },
    select: { id: true, name: true, tenantId: true },
  });
  const fallbackQuestions =
    application.questionSnapshot == null && !application.answers.length
      ? await db.applicationQuestion.findMany({
          where: {
            tenantId,
            requisitionId: application.jobRequisitionId,
            isActive: true,
            createdAt: { lte: application.appliedAt },
          },
          orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
        })
      : [];
  const parsed = application.candidate.parsedResume ?? {};
  let experienceYears = null;
  for (const key of ["yearsOfExperience", "totalExperience", "experienceYears"])
    if (
      parsed[key] != null &&
      parsed[key] !== "" &&
      Number.isFinite(Number(parsed[key]))
    ) {
      experienceYears = Number(parsed[key]);
      break;
    }
  const result = calculateApplicationFit({
    index: buildAliasIndex(aliases, skills, tenantId),
    candidateSkills: [
      ...application.candidate.candidateSkills,
      ...(Array.isArray(parsed.skills) ? parsed.skills : []),
    ],
    requirements: requisitionSkillRequirements(
      application.jobRequisition.jobContent,
      application.jobRequisition.requirements,
    ),
    experienceYears,
    minimumExperienceYears:
      application.jobRequisition.jobContent?.minimumExperienceYears ?? null,
    knockouts: applicationKnockoutEvidence(application, fallbackQuestions),
  });
  const key = {
    tenantId,
    applicationId: application.id,
    modelVersion: result.modelVersion,
    inputHash: result.inputHash,
  };
  let score = await db.applicationScore.findFirst({
    where: { tenantId, applicationId: application.id },
    orderBy: [{ scoredAt: "desc" }, { id: "desc" }],
  });
  if (
    score?.inputHash !== result.inputHash ||
    score?.modelVersion !== result.modelVersion
  )
    score = null;
  if (!score) {
    score = await db.applicationScore.create({
      data: {
        ...key,
        scorePct: result.scorePct,
        knockoutFailed: result.knockoutFailed,
        explanation: result.explanation,
      },
    });
    await enqueueHrDomainEvent(db, {
      tenantId,
      actorId,
      eventName: "hr.recruitment.application_scored.v1",
      aggregateType: "Application",
      aggregateId: application.id,
      payload: {
        applicationId: String(application.id),
        scoreId: String(score.id),
        modelVersion: score.modelVersion,
      },
    });
  }
  await db.$executeRaw`UPDATE "Application" SET "fitScoreCheckedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "fitScoreError" = NULL WHERE id=${application.id} AND "tenantId"=${tenantId}::uuid`;
  return { ...score, advisory: true, humanDecisionRequired: true };
}
export const applicationScoreRefresh = ({ applicationId }) =>
  authorized("hr.recruitment.update", (db, env) =>
    refreshFitScore(db, { ...env, applicationId, actorId: env.who.id }),
  );
export const applicationScoreGet = ({ applicationId }) =>
  authorized("hr.recruitment.read", async (db, env) => {
    const application = await db.application.findFirst({
      where: {
        id: Number(applicationId),
        tenantId: env.tenantId,
        ...applicationScopeWhere(env.scope),
        candidate: { anonymizedAt: null },
      },
      select: { id: true, version: true, stage: true, candidateId: true },
    });
    if (!application) fail("Application not found", 404);
    await assertCommunicationsAllowed(
      {
        tenantId: env.tenantId,
        candidateId: application.candidateId,
        purpose: "PROCESSING",
        requireExplicitConsent: true,
      },
      { db },
    );
    const score = await db.applicationScore.findFirst({
      where: { tenantId: env.tenantId, applicationId: application.id },
      orderBy: [{ scoredAt: "desc" }, { id: "desc" }],
    });
    const disposition = await db.applicationAutoDisposition.findUnique({
      where: { applicationId: application.id },
    });
    return {
      score,
      advisory: true,
      humanDecisionRequired: true,
      automaticDisposition: disposition
        ? {
            ...disposition,
            canReverse:
              !disposition.reversedAt &&
              application.stage === "rejected" &&
              application.version === disposition.rejectionVersion &&
              new Date() < disposition.noticeDueAt,
          }
        : null,
      applicationVersion: application.version,
    };
  });
async function rank(db, env, { requisitionId, page = 1, pageSize = 25 }) {
  const req = await db.jobRequisition.findFirst({
    where: {
      tenantId: env.tenantId,
      id: Number(requisitionId),
      ...requisitionScopeWhere(env.scope),
    },
    select: { id: true },
  });
  if (!req) fail("Requisition not found", 404);
  const offset = (page - 1) * pageSize;
  const eligible = Prisma.sql`a."tenantId"=${env.tenantId}::uuid AND a."jobRequisitionId"=${req.id} AND a.stage NOT IN ('hired','rejected','withdrawn') AND c."anonymizedAt" IS NULL AND c."archivedAt" IS NULL AND c.status='active' AND c."consentStatus"='GRANTED' AND (c."retentionUntil" IS NULL OR c."retentionUntil" > CURRENT_TIMESTAMP)
 AND (SELECT cc.status FROM candidate_consents cc WHERE cc."tenantId"=c."tenantId" AND cc."candidateId"=c.id AND cc.purpose='PROCESSING' ORDER BY cc."occurredAt" DESC,cc.id DESC LIMIT 1)='GRANTED'`;
  const rows = await db.$queryRaw`WITH current_scores AS (
 SELECT a.id AS "applicationId",a."candidateId",s.id AS "scoreId",s."scorePct",COALESCE(s."knockoutFailed",false) AS "knockoutFailed",s."modelVersion",s."scoredAt",
 c."firstName",c."lastName"
 FROM "Application" a JOIN "Candidate" c ON c.id=a."candidateId" AND c."tenantId"=a."tenantId"
 LEFT JOIN LATERAL (SELECT * FROM application_scores s WHERE s."tenantId"=a."tenantId" AND s."applicationId"=a.id ORDER BY s."scoredAt" DESC,s.id DESC LIMIT 1) s ON true
 WHERE ${eligible}

 ), ranks AS (SELECT *,CASE WHEN "scorePct" IS NOT NULL AND NOT "knockoutFailed" THEN RANK() OVER(ORDER BY (CASE WHEN "knockoutFailed" THEN NULL ELSE "scorePct" END) DESC NULLS LAST) ELSE NULL END AS rank,COUNT(*) OVER() AS total FROM current_scores)
 SELECT * FROM ranks ORDER BY rank NULLS LAST,"applicationId" OFFSET ${offset} LIMIT ${pageSize}`;
  return {
    items: rows.map((r) => ({
      ...r,
      rank: r.rank == null ? null : Number(r.rank),
      total: undefined,
    })),
    total: rows.length
      ? Number(rows[0].total)
      : Number(
          (
            await db.$queryRaw`SELECT COUNT(*) AS total FROM "Application" a JOIN "Candidate" c ON c.id=a."candidateId" AND c."tenantId"=a."tenantId" WHERE ${eligible}`
          )[0].total,
        ),
    page,
    pageSize,
    advisory: true,
    humanDecisionRequired: true,
  };
}
export const requisitionRankList = (args) =>
  authorized("hr.recruitment.read", (db, env) => rank(db, env, args));
export const requisitionShortlistPropose = ({ requisitionId, minimumScore }) =>
  authorized("hr.recruitment.update", async (db, env) => {
    minimumScore ??= (await readRecruitmentSettings(db, env.tenantId)).policy
      .shortlistThreshold;
    const ranked = await rank(db, env, {
      requisitionId,
      page: 1,
      pageSize: 1000,
    });
    if (ranked.total > 1000)
      fail(
        "Use the paginated ranking to review this requisition; bulk proposals are limited to 1,000 applications.",
        422,
      );
    const eligible = ranked.items.filter(
        (r) => r.rank != null && !r.knockoutFailed,
      ),
      top = Math.max(eligible.length ? 1 : 0, Math.ceil(eligible.length * 0.1)),
      cutoff = eligible[top - 1]?.scorePct ?? Infinity;
    const proposed = eligible.filter(
      (r) => r.scorePct >= cutoff && r.scorePct >= minimumScore,
    );
    for (const row of [...proposed].sort(
      (a, b) => a.candidateId - b.candidateId,
    )) {
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        row.candidateId,
        env.tenantId,
      );
      await assertCommunicationsAllowed(
        {
          tenantId: env.tenantId,
          candidateId: row.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      await db.applicationScore.update({
        where: { id: row.scoreId },
        data: { rankSnapshot: row.rank },
      });
    }
    return {
      items: proposed,
      total: proposed.length,
      threshold: minimumScore,
      percentile: 90,
      advisory: true,
      humanDecisionRequired: true,
      notice: "Review the evidence and confirm each shortlist decision.",
    };
  });
