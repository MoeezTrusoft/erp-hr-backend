import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import { assertAssessmentComplete } from "./candidate-assessment/rules.js";
import {
  resolveForInterview,
  validateSubmission,
} from "./scorecardTemplate.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const fail = (message, status = 409, code = "HR-6102") => {
  throw Object.assign(new Error(message), { status, code });
};
const COMPARABLE_FIELDS = ["scores", "overallScore", "recommendation", "notes"];

const stable = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stable(value[key]);
        return acc;
      }, {});
  }
  return value;
};

/** The stored/incoming values for the fields a reviewer may change. */
const comparable = (row = {}) =>
  COMPARABLE_FIELDS.reduce((acc, field) => {
    if (row[field] !== undefined) acc[field] = row[field];
    return acc;
  }, {});

/** True when the incoming payload would change anything the reviewer owns. */
export const scorecardPayloadChanged = (existing, data = {}) => {
  const before = stable(comparable(existing));
  const after = stable(comparable(data));
  return COMPARABLE_FIELDS.some(
    (field) =>
      JSON.stringify(before[field] ?? null) !==
      JSON.stringify(after[field] ?? null),
  );
};

/** Shared REST/MCP writer. The reviewer is always the verified employee. */
export async function upsertInterviewScorecard({
  interviewId,
  reviewerId,
  data = {},
  tenantId,
  amendment = null,
} = {}) {
  const ctx = getCtx();
  if (
    !ctx.actorVerified ||
    !ctx.user?.tenantId ||
    (tenantId && tenantId !== ctx.user.tenantId)
  )
    fail("Verified company context required", 401);
  assertPermission(ctx.permissions, "PUT", "hr:recruitment", false);
  tenantId = ctx.user.tenantId;
  const id = Number(interviewId);
  if (!Number.isInteger(id) || id <= 0) fail("Valid interview required", 422);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      if (reviewerId != null && Number(reviewerId) !== who.id)
        fail("Feedback must be submitted by its reviewer", 403);
      await tx.$queryRawUnsafe(
        'SELECT id FROM interviews WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
        tenantId,
        id,
      );
      const parent = await tx.interview.findFirst({
        where: { tenantId, id, interviewers: { some: { employeeId: who.id } } },
      });
      if (!parent) fail("Interview not found", 404);
      assertAssessmentComplete(parent);
      if (["CANCELLED", "NO_SHOW"].includes(parent.status))
        fail("This interview cannot receive feedback");
      if (parent.formSnapshot)
        fail(
          "Submit the pinned structured form for this interview",
          409,
          "HR-6101",
        );
      const scores = data.scores ?? {};
      const values = Object.values(scores);
      if (
        !values.length ||
        values.some((n) => !Number.isInteger(n) || n < 1 || n > 5)
      )
        fail("Ratings must be integers from 1 to 5", 422);
      const template = await resolveForInterview({
        interviewId: id,
        tenantId,
        db: tx,
      });
      const verdict = validateSubmission({ template, scores });
      const payload = {
        scores,
        overallScore:
          verdict.overall ??
          values.reduce((sum, n) => sum + n, 0) / values.length,
        recommendation: data.recommendation ?? null,
        notes: data.notes ?? null,
      };
      if (
        payload.notes != null &&
        (typeof payload.notes !== "string" || payload.notes.length > 10000)
      )
        fail("Feedback notes are too long", 422);
      let existing = await tx.interviewScorecard.findFirst({
        where: { tenantId, interviewId: id, reviewerId: who.id },
      });
      if (!existing) {
        // Claim only legacy rows whose interview and verified reviewer both
        // belong to this company. Never reassign a non-NULL company. The
        // parent interview lock serializes submissions and amendments.
        const claimed = await tx.$executeRawUnsafe(
          `UPDATE interview_scorecards AS s SET "tenantId"=$1::uuid
           FROM interviews AS i, "Employee" AS e
           WHERE s."interviewId"=$2 AND s."reviewerId"=$3 AND s."tenantId" IS NULL
             AND i.id=s."interviewId" AND i."tenantId"=$1::uuid
             AND e.id=s."reviewerId" AND e.tenant_id=$1::uuid`,
          tenantId,
          id,
          who.id,
        );
        if (claimed) existing = await tx.interviewScorecard.findFirst({
          where: { tenantId, interviewId: id, reviewerId: who.id },
        });
      }
      if (existing?.submittedAt && !scorecardPayloadChanged(existing, payload))
        return existing;
      const reason = String(amendment?.reason ?? "").trim();
      if (existing?.submittedAt && reason.length < 10)
        fail(
          "A submitted scorecard requires an amendment reason of at least 10 characters",
        );
      const now = new Date();
      const row = existing
        ? await tx.interviewScorecard.update({
            where: { id: existing.id },
            data: {
              ...payload,
              submittedAt: existing.submittedAt ?? now,
              status: "SUBMITTED",
              version: { increment: 1 },
              ...(existing.submittedAt
                ? {
                    lastAmendedAt: now,
                    amendmentLog: [
                      ...(Array.isArray(existing.amendmentLog)
                        ? existing.amendmentLog
                        : []),
                      {
                        at: now.toISOString(),
                        by: who.id,
                        reason,
                        replaced: comparable(existing),
                      },
                    ],
                  }
                : {}),
            },
          })
        : await tx.interviewScorecard.create({
            data: {
              ...payload,
              tenantId,
              interviewId: id,
              reviewerId: who.id,
              submittedAt: now,
              status: "SUBMITTED",
              version: 1,
            },
          }).catch((error) => {
            if (error.code === "P2002")
              fail("A scorecard already belongs to another tenant");
            throw error;
          });
      const queued = await enqueueHrDomainEvent(tx, {
        tenantId,
        actorId: who.id,
        actorType: "user",
        eventName: "hr.recruitment.interview_scorecard_submitted.v1",
        aggregateType: "Application",
        aggregateId: String(parent.applicationId),
        payload: {
          applicationId: parent.applicationId,
          interviewId: id,
          scorecardId: row.id,
          actorId: who.id,
        },
      });
      if (!queued) fail("Feedback event could not be persisted", 503);
      return row;
    },
    { tenantId },
  );
}
export default upsertInterviewScorecard;
