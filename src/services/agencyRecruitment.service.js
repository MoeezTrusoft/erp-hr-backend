import crypto from "node:crypto";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { consumeRecruitmentLimit } from "../lib/recruitmentRateLimit.js";
import { toPublicJob } from "../lib/publicPortal.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { sourceJob } from "./recruitmentDraftSource.service.js";
import { computeRetentionUntil } from "./candidatePrivacy.service.js";
import { queueMailboxMessage } from "./candidateMailboxQueue.service.js";
import { hashDraftToken, DRAFT_TTL_MS } from "./applicationDraft.service.js";
import { transitionApplicationStageInTransaction } from "./applicationWorkflow.service.js";
import { agencyChanged } from "./recruitmentSourcingEvents.service.js";
import {
  AgencyPageInput,
  AgencyProfileInput,
  AgencyProfileQuery,
  AgencyProfileResult,
  AgencyAssignmentInput,
  AgencyAssignmentListInput,
  AgencySubmitInput,
  AgencySubmissionsInput,
  AgencyReviewInput,
  AgencyProfile,
  AgencyAccounts,
  AgencyAssignments,
  AgencyAssignment,
  AgencyJobs,
  AgencyJob,
  AgencySubmissions,
  AgencySubmissionRow,
} from "@trusoft/contracts/recruitment-agency";

const fail = (message = "Agency recruitment operation is not permitted", status = 403) => {
  throw Object.assign(new Error(message), { status, code: "HR-5306" });
};
const received = Object.freeze({ received: true });
const jobInput = z.object({ requisitionId: z.number().int().positive() }).strict();
const profileView = (row) =>
  AgencyProfile.parse({
    id: row.id,
    displayName: row.displayName,
    contactEmail: row.contactEmail,
    version: row.version,
  });
const page = (args) => ({ skip: (args.page - 1) * args.pageSize, take: args.pageSize });
const fingerprint = (args) =>
  crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex");

async function run(input, schema, permission, mode, fn) {
  const args = schema.parse(input),
    ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  if (!ctx.actorVerified || ctx.system || !tenantId || !ctx.permissions?.includes(permission))
    fail();
  if (!isRecruitmentFlagEnabled("agency") || !isRecruitmentFlagEnabled("portal"))
    fail("Agency recruitment is unavailable", 404);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const env = { tenantId, ctx, now: new Date() };
      if (mode === "RECRUITER")
        env.who = (
          await requireRecruitmentActor({ tenantId, permission, allowedScopes: ["ORG"] }, tx)
        ).who;
      else {
        if (
          resolveRecruitmentScope(ctx.user).level !== "AGENCY" ||
          !Number.isSafeInteger(Number(ctx.user.userId)) ||
          Number(ctx.user.userId) <= 0
        )
          fail();
        env.userId = Number(ctx.user.userId);
        env.agency = await tx.recruitmentAgency.findUnique({
          where: { tenantId_userId: { tenantId, userId: env.userId } },
        });
        if (!env.agency && mode !== "REGISTER") fail("Complete your agency profile first", 409);
      }
      return fn(tx, env, args);
    },
    { tenantId, txOptions: { timeout: 30000 } },
  );
}
async function audit(tx, env, action, reference) {
  await tx.log.create({
    data: {
      tenantId: env.tenantId,
      employeeId: env.who?.id ?? null,
      actionById: env.who?.id ?? null,
      type: "Update",
      action_type: action,
      module: "Agency Recruitment",
      ip: "unknown",
      os: "server",
      result: "SUCCESS",
      notes: JSON.stringify({ reference, actorUserId: env.ctx.user.userId }),
    },
  });
}
export function getAgencyProfile(input = {}) {
  return run(input, AgencyProfileQuery, "hr.recruitment.read", "REGISTER", async (_tx, env) =>
    AgencyProfileResult.parse({ profile: env.agency ? profileView(env.agency) : null }),
  );
}
export function saveAgencyProfile(input) {
  return run(
    input,
    AgencyProfileInput,
    "hr.recruitment.create",
    "REGISTER",
    async (tx, env, args) => {
      const contactEmail = z.email().max(254).parse(env.ctx.user.email);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":agency:" + env.userId},0))`;
      const row = await tx.recruitmentAgency.upsert({
        where: { tenantId_userId: { tenantId: env.tenantId, userId: env.userId } },
        create: {
          tenantId: env.tenantId,
          userId: env.userId,
          displayName: args.displayName,
          contactEmail,
        },
        update: { displayName: args.displayName, contactEmail, version: { increment: 1 } },
      });
      await audit(tx, env, "AGENCY_PROFILE", row.id);
      return profileView(row);
    },
  );
}
export function listAgencyAccounts(input = {}) {
  return run(input, AgencyPageInput, "hr.recruitment.read", "RECRUITER", async (tx, env, args) => {
    const where = {
      tenantId: env.tenantId,
      ...(args.q ? { displayName: { contains: args.q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      tx.recruitmentAgency.findMany({
        where,
        ...page(args),
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
      }),
      tx.recruitmentAgency.count({ where }),
    ]);
    return AgencyAccounts.parse({
      items: rows.map(profileView),
      total,
      page: args.page,
      pageSize: args.pageSize,
    });
  });
}
const assignmentView = (row) =>
  AgencyAssignment.parse({
    agencyId: row.agencyId,
    requisitionId: row.requisitionId,
    displayName: row.agency.displayName,
    active: row.active,
    version: row.version,
  });
export function listAgencyAssignments(input) {
  return run(
    input,
    AgencyAssignmentListInput,
    "hr.recruitment.read",
    "RECRUITER",
    async (tx, env, args) => {
      if (
        !(await tx.jobRequisition.findFirst({
          where: { tenantId: env.tenantId, id: args.requisitionId },
        }))
      )
        fail("Position not found", 404);
      const rows = await tx.requisitionAgencyAssignment.findMany({
        where: { tenantId: env.tenantId, requisitionId: args.requisitionId },
        include: { agency: true },
        orderBy: { createdAt: "asc" },
      });
      return AgencyAssignments.parse({ items: rows.map(assignmentView) });
    },
  );
}
export function setAgencyAssignment(input) {
  return run(
    input,
    AgencyAssignmentInput,
    "hr.recruitment.update",
    "RECRUITER",
    async (tx, env, args) => {
      await tx.$queryRaw`SELECT id FROM "JobRequisition" WHERE "tenantId"=${env.tenantId}::uuid AND id=${args.requisitionId} FOR UPDATE`;
      const job = await tx.jobRequisition.findFirst({
        where: { tenantId: env.tenantId, id: args.requisitionId },
      });
      const agency = await tx.recruitmentAgency.findFirst({
        where: { tenantId: env.tenantId, id: args.agencyId },
      });
      if (!job || !agency) fail("Position or agency not found", 404);
      if (args.active && !["APPROVED", "POSTED"].includes(job.status))
        fail("Approve the position before assigning an agency", 409);
      const key = { tenantId: env.tenantId, requisitionId: job.id, agencyId: agency.id };
      const current = await tx.requisitionAgencyAssignment.findUnique({
        where: { tenantId_requisitionId_agencyId: key },
      });
      if (args.expectedVersion !== (current?.version ?? 0))
        fail("Assignment changed; reload before saving", 412);
      const row = current
        ? await tx.requisitionAgencyAssignment.update({
            where: { id: current.id },
            data: { active: args.active, updatedById: env.who.id, version: { increment: 1 } },
            include: { agency: true },
          })
        : await tx.requisitionAgencyAssignment.create({
            data: { ...key, active: args.active, updatedById: env.who.id },
            include: { agency: true },
          });
      await audit(tx, env, "AGENCY_ASSIGNMENT", row.id);
      await agencyChanged(tx, {
        tenantId: env.tenantId,
        agencyId: agency.id,
        requisitionId: job.id,
        version: row.version,
      });
      return assignmentView(row);
    },
  );
}
export function listAgencyJobs(input = {}) {
  return run(input, AgencyPageInput, "hr.recruitment.read", "AGENCY", async (tx, env, args) => {
    const where = {
      tenantId: env.tenantId,
      status: "POSTED",
      OR: [{ closesAt: null }, { closesAt: { gte: env.now } }],
      agencyAssignments: { some: { agencyId: env.agency.id, active: true } },
      postings: { some: { channel: "AGENCY", isActive: true, closedAt: null } },
      ...(args.q ? { title: { contains: args.q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      tx.jobRequisition.findMany({
        where,
        ...page(args),
        orderBy: { id: "desc" },
        include: { postings: { where: { channel: "AGENCY", isActive: true, closedAt: null } } },
      }),
      tx.jobRequisition.count({ where }),
    ]);
    return AgencyJobs.parse({
      items: rows.map((row) => toPublicJob(row, { now: env.now })),
      total,
      page: args.page,
      pageSize: args.pageSize,
    });
  });
}
async function assignedJob(tx, env, requisitionId) {
  if (
    !(await tx.requisitionAgencyAssignment.findFirst({
      where: { tenantId: env.tenantId, requisitionId, agencyId: env.agency.id, active: true },
    }))
  )
    return null;
  return sourceJob(tx, { tenantId: env.tenantId, requisitionId, channel: "AGENCY", now: env.now });
}
export function getAgencyJob(input) {
  return run(input, jobInput, "hr.recruitment.read", "AGENCY", async (tx, env, args) => {
    const job = await assignedJob(tx, env, args.requisitionId);
    if (!job) fail("Position not found", 404);
    return AgencyJob.parse(job);
  });
}
export function createAgencySubmission(input) {
  return run(input, AgencySubmitInput, "hr.recruitment.create", "AGENCY", async (tx, env, args) => {
    const mark = fingerprint(args),
      email = args.email.trim().toLowerCase();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":agency-request:" + args.requestKey},0))`;
    const prior = await tx.agencyCommandReceipt.findUnique({
      where: { tenantId_requestKey: { tenantId: env.tenantId, requestKey: args.requestKey } },
    });
    if (prior) {
      if (prior.agencyId !== env.agency.id || prior.fingerprint !== mark)
        fail("Request key belongs to another action", 409);
      return received;
    }
    await consumeRecruitmentLimit("agency-contact:" + env.tenantId + ":" + env.agency.id, {
      limit: 30,
      windowSeconds: 3600,
    });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":" + email},0))`;
    await tx.$queryRaw`SELECT id FROM "JobRequisition" WHERE "tenantId"=${env.tenantId}::uuid AND id=${args.requisitionId} FOR SHARE`;
    if (!(await assignedJob(tx, env, args.requisitionId))) fail("Position not found", 404);
    let candidateId = null;
    const act = async () => {
      if (
        await tx.candidateDncEntry.findFirst({
          where: { tenantId: env.tenantId, email, liftedAt: null },
        })
      )
        return;
      let candidate = await tx.candidate.findFirst({ where: { tenantId: env.tenantId, email } });
      candidateId = candidate?.id ?? null; // Private erasure linkage; never returned to the agency.
      // Never claim or reveal a pre-existing candidate from another source/agency.
      if (candidate && candidate.ownerAgencyId !== env.agency.id) return;
      candidate ??= await tx.candidate.create({
        data: {
          tenantId: env.tenantId,
          email,
          firstName: args.firstName,
          lastName: args.lastName || null,
          source: "AGENCY",
          ownerAgencyId: env.agency.id,
          status: "active",
          consentStatus: "UNKNOWN",
          retentionPopulation: "APPLICANT",
          retentionUntil: await computeRetentionUntil(
            { tenantId: env.tenantId, from: env.now },
            { db: tx },
          ),
        },
      });
      candidateId = candidate.id;
      await tx.$queryRaw`SELECT id FROM "Candidate" WHERE id=${candidate.id} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
      candidate = await tx.candidate.findFirst({
        where: { tenantId: env.tenantId, id: candidate.id },
      });
      if (
        !candidate ||
        candidate.ownerAgencyId !== env.agency.id ||
        candidate.anonymizedAt ||
        candidate.status !== "active" ||
        (candidate.retentionUntil && candidate.retentionUntil <= env.now) ||
        (await tx.candidateDncEntry.findFirst({
          where: { tenantId: env.tenantId, email, liftedAt: null },
        }))
      )
        return;
      if (
        await tx.application.findFirst({
          where: { tenantId: env.tenantId, candidateId, jobRequisitionId: args.requisitionId },
        })
      )
        return;
      let submission = await tx.agencySubmission.findFirst({
        where: { tenantId: env.tenantId, candidateId, requisitionId: args.requisitionId },
      });
      const draft = await tx.applicationDraft.findFirst({
        where: { tenantId: env.tenantId, candidateId, requisitionId: args.requisitionId },
      });
      if (submission && (submission.agencyId !== env.agency.id || submission.state !== "INVITED"))
        return;
      if (
        draft &&
        (draft.source !== "AGENCY" || draft.ownerAgencyId !== env.agency.id || draft.submittedAt)
      )
        return;
      const lastSent = draft?.updated_at || submission?.updatedAt;
      if (lastSent && lastSent.getTime() > env.now.getTime() - 300000) return;
      const expiresAt = new Date(env.now.getTime() + DRAFT_TTL_MS);
      submission = submission
        ? await tx.agencySubmission.update({
            where: { id: submission.id },
            data: { expiresAt, version: { increment: 1 } },
          })
        : await tx.agencySubmission.create({
            data: {
              tenantId: env.tenantId,
              agencyId: env.agency.id,
              candidateId,
              requisitionId: args.requisitionId,
              requestKey: args.requestKey,
              fingerprint: mark,
              suppliedName: [args.firstName, args.lastName].filter(Boolean).join(" "),
              expiresAt,
            },
          });
      const token = crypto.randomBytes(32).toString("base64url");
      if (draft)
        await tx.applicationDraft.update({
          where: { id: draft.id },
          data: { tokenHash: hashDraftToken(token), expiresAt },
        });
      else
        await tx.applicationDraft.create({
          data: {
            tenantId: env.tenantId,
            candidateId,
            requisitionId: args.requisitionId,
            source: "AGENCY",
            ownerAgencyId: env.agency.id,
            agencySubmissionId: submission.id,
            tokenHash: hashDraftToken(token),
            expiresAt,
            payload: { firstName: args.firstName, lastName: args.lastName },
          },
        });
      await queueMailboxMessage(tx, {
        tenantId: env.tenantId,
        candidate,
        email,
        token,
        tokenPurpose: "DRAFT",
        templateKey: "portal_draft_link",
        expiresAt,
      });
      await agencyChanged(tx, { ...submission, submissionId: submission.id });
      await audit(tx, env, "AGENCY_CONTACT_INVITED", submission.id);
    };
    await act();
    await tx.agencyCommandReceipt.create({
      data: {
        tenantId: env.tenantId,
        agencyId: env.agency.id,
        requestKey: args.requestKey,
        fingerprint: mark,
        candidateId,
      },
    });
    return received;
  });
}
function submissionView(row, review, now) {
  return AgencySubmissionRow.parse({
    id: row.id,
    requisitionId: row.requisitionId,
    jobTitle: row.requisition.title,
    suppliedName: row.suppliedName,
    state: row.state === "INVITED" && row.expiresAt <= now ? "EXPIRED" : row.state,
    decisionReason: row.decisionReason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(review
      ? {
          agencyId: row.agencyId,
          agencyName: row.agency.displayName,
          applicationId: row.application?.id ?? null,
        }
      : {}),
  });
}
export function listAgencySubmissions(input = {}) {
  const args = AgencySubmissionsInput.parse(input),
    review = args.mode === "REVIEW";
  return run(
    args,
    AgencySubmissionsInput,
    "hr.recruitment.read",
    review ? "RECRUITER" : "AGENCY",
    async (tx, env) => {
      const where = {
        tenantId: env.tenantId,
        ...(review
          ? {}
          : {
              agencyId: env.agency.id,
              requisition: {
                agencyAssignments: { some: { agencyId: env.agency.id, active: true } },
              },
            }),
        ...(args.state ? { state: args.state } : {}),
        ...(args.q ? { suppliedName: { contains: args.q, mode: "insensitive" } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.agencySubmission.findMany({
          where,
          ...page(args),
          include: {
            requisition: { select: { title: true } },
            agency: { select: { displayName: true } },
            application: { select: { id: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        tx.agencySubmission.count({ where }),
      ]);
      return AgencySubmissions.parse({
        items: rows.map((row) => submissionView(row, review, env.now)),
        total,
        page: args.page,
        pageSize: args.pageSize,
      });
    },
  );
}
export function reviewAgencySubmission(input) {
  return run(
    input,
    AgencyReviewInput,
    "hr.recruitment.update",
    "RECRUITER",
    async (tx, env, args) => {
      const initial = await tx.agencySubmission.findFirst({
        where: { tenantId: env.tenantId, id: args.submissionId },
      });
      if (!initial) fail("Submission not found", 404);
      await tx.$queryRaw`SELECT id FROM "JobRequisition" WHERE id=${initial.requisitionId} AND "tenantId"=${env.tenantId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "Candidate" WHERE id=${initial.candidateId} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
      const application = await tx.application.findFirst({
        where: { tenantId: env.tenantId, agencySubmissionId: initial.id },
      });
      if (!application) fail("The candidate must submit their own application first", 409);
      await tx.$queryRaw`SELECT id FROM "Application" WHERE id=${application.id} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AgencySubmission" WHERE id=${initial.id}::uuid AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
      const current = await tx.agencySubmission.findFirst({
        where: { tenantId: env.tenantId, id: initial.id },
        include: { candidate: true },
      });
      const active = await tx.application.findFirst({
        where: { id: application.id, tenantId: env.tenantId },
      });
      if (
        !current ||
        current.candidate.anonymizedAt ||
        current.candidate.consentStatus !== "GRANTED" ||
        current.candidate.status !== "active" ||
        (current.candidate.retentionUntil && current.candidate.retentionUntil <= env.now) ||
        !active ||
        !["applied", "on_hold"].includes(active.stage)
      )
        fail("Submission is no longer available for review", 409);
      if (
        await tx.candidateDncEntry.findFirst({
          where: { tenantId: env.tenantId, email: current.candidate.email, liftedAt: null },
        })
      )
        fail("Submission is no longer available for review", 409);
      if (current.version !== args.expectedVersion)
        fail("Submission changed; reload before reviewing", 412);
      if (current.state !== "SUBMITTED") fail("Submission has already been reviewed", 409);
      const row = await tx.agencySubmission.update({
        where: { id: current.id },
        data: {
          state: args.decision,
          decisionReason: args.reason,
          reviewedById: env.who.id,
          reviewedAt: env.now,
          version: { increment: 1 },
        },
        include: {
          agency: { select: { displayName: true } },
          requisition: { select: { title: true } },
          application: { select: { id: true } },
        },
      });
      if (args.decision === "REJECTED")
        await transitionApplicationStageInTransaction(
          {
            id: active.id,
            tenantId: env.tenantId,
            targetStage: "rejected",
            expectedVersion: active.version,
            reason: args.reason,
            actorId: env.who.id,
            source: "agency-review",
          },
          tx,
        );
      await agencyChanged(tx, { ...row, submissionId: row.id });
      await audit(tx, env, "AGENCY_SUBMISSION_" + args.decision, row.id);
      return submissionView(row, true, env.now);
    },
  );
}
