import crypto from "node:crypto";
import { referralChanged } from "./recruitmentSourcingEvents.service.js";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { toPublicJob } from "../lib/publicPortal.js";
import {
  employeeMailbox,
  sourceJob,
} from "./recruitmentDraftSource.service.js";
import { hashDraftToken, DRAFT_TTL_MS } from "./applicationDraft.service.js";
import { computeRetentionUntil } from "./candidatePrivacy.service.js";
import { queueMailboxMessage } from "./candidateMailboxQueue.service.js";
import {
  InternalJobQuery,
  InternalJobInput,
  InternalApplyInput,
  InternalReferInput,
  ReferralListInput,
  ReferralReviewInput,
  InternalJobs,
  InternalJob,
  ReferralList,
  ReferralRow,
} from "@trusoft/contracts/recruitment-sourcing";
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5305" });
};
const received = Object.freeze({ received: true });
async function run(input, schema, fn) {
  const args = schema.parse(input),
    ctx = getCtx();
  if (
    !ctx.actorVerified ||
    !ctx.user?.tenantId ||
    !ctx.permissions?.includes("hr.self.read") ||
    ctx.system
  )
    fail("A verified employee self-service account is required", 403);
  if (!isRecruitmentFlagEnabled("portal"))
    fail("Recruitment applications are unavailable", 404);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        env = { tenantId: ctx.user.tenantId, who, now: new Date() };
      return fn(tx, env, args);
    },
    { tenantId: ctx.user.tenantId, txOptions: { timeout: 30000 } },
  );
}
async function audit(tx, env, action, reference) {
  await tx.log.create({
    data: {
      tenantId: env.tenantId,
      employeeId: env.who.id,
      actionById: env.who.id,
      type: "Update",
      action_type: action,
      module: "Internal Recruitment",
      ip: "unknown",
      os: "server",
      result: "SUCCESS",
      notes: String(reference),
    },
  });
}
export async function listInternalJobs(input = {}) {
  return run(input, InternalJobQuery, async (tx, env, args) => {
    const where = {
      tenantId: env.tenantId,
      status: "POSTED",
      OR: [{ closesAt: null }, { closesAt: { gte: env.now } }],
      postings: {
        some: { isActive: true, closedAt: null, channel: args.channel },
      },
      ...(args.q ? { title: { contains: args.q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      tx.jobRequisition.findMany({
        where,
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        orderBy: [{ id: "desc" }],
        include: {
          postings: {
            where: { isActive: true, closedAt: null, channel: args.channel },
          },
        },
      }),
      tx.jobRequisition.count({ where }),
    ]);
    return InternalJobs.parse({
      items: rows.map((row) => toPublicJob(row, { now: env.now })),
      total,
      page: args.page,
      pageSize: args.pageSize,
    });
  });
}
export async function getInternalJob(input) {
  return run(input, InternalJobInput, async (tx, env, args) => {
    const job = await sourceJob(tx, { ...env, ...args });
    if (!job) fail("Position not found", 404);
    return InternalJob.parse(job);
  });
}
async function command(tx, env, args, operation, fn) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ operation, args }))
    .digest("hex");
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    env.tenantId + ":sourcing:" + args.requestKey,
  );
  const prior = await tx.recruitmentSourcingReceipt.findUnique({
    where: {
      tenantId_requestKey: {
        tenantId: env.tenantId,
        requestKey: args.requestKey,
      },
    },
  });
  if (prior) {
    if (
      prior.actorEmployeeId !== env.who.id ||
      prior.fingerprint !== fingerprint ||
      prior.operation !== operation
    )
      fail("This request key belongs to a different action");
    return received;
  }
  const candidateId = await fn(fingerprint);
  await tx.recruitmentSourcingReceipt.create({
    data: {
      tenantId: env.tenantId,
      requestKey: args.requestKey,
      actorEmployeeId: env.who.id,
      candidateId: candidateId || null,
      operation,
      fingerprint,
    },
  });
  return received;
}
async function invite(tx, env, args, source, fingerprint) {
  const address = z
    .email()
    .max(254)
    .parse(
      source === "INTERNAL"
        ? employeeMailbox(env.who)
        : args.email.trim().toLowerCase(),
    );
  if (source === "REFERRAL" && address === employeeMailbox(env.who))
    fail("Use the internal application action for yourself", 422);
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    env.tenantId + ":" + address,
  );
  await tx.$queryRawUnsafe(
    'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=$2 FOR SHARE',
    env.tenantId,
    args.requisitionId,
  );
  const job = await sourceJob(tx, {
    tenantId: env.tenantId,
    requisitionId: args.requisitionId,
    channel: source,
    now: env.now,
  });
  if (!job) fail("Position not found", 404);
  if (
    await tx.candidateDncEntry.findFirst({
      where: { tenantId: env.tenantId, email: address, liftedAt: null },
    })
  )
    return null;
  let candidate = await tx.candidate.findFirst({
    where: { tenantId: env.tenantId, email: address },
  });
  if (
    candidate &&
    (candidate.anonymizedAt ||
      candidate.status !== "active" ||
      (candidate.retentionUntil && candidate.retentionUntil <= env.now))
  )
    return null;
  const firstName =
    source === "INTERNAL"
      ? env.who.first_name || env.who.preferred_name || ""
      : args.firstName;
  const lastName =
    source === "INTERNAL" ? env.who.last_name || "" : args.lastName;
  candidate ??= await tx.candidate.create({
    data: {
      tenantId: env.tenantId,
      email: address,
      firstName,
      lastName: lastName || null,
      source,
      status: "active",
      consentStatus: "UNKNOWN",
      retentionPopulation: "APPLICANT",
      retentionUntil: await computeRetentionUntil(
        { tenantId: env.tenantId, from: env.now },
        { db: tx },
      ),
    },
  });
  await tx.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
    env.tenantId,
    candidate.id,
  );
  candidate = await tx.candidate.findFirst({
    where: { tenantId: env.tenantId, id: candidate.id },
  });
  if (
    candidate.anonymizedAt ||
    candidate.status !== "active" ||
    (candidate.retentionUntil && candidate.retentionUntil <= env.now)
  )
    return candidate.id;
  if (
    await tx.candidateDncEntry.findFirst({
      where: { tenantId: env.tenantId, email: address, liftedAt: null },
    })
  )
    return candidate.id;
  if (
    await tx.application.findFirst({
      where: {
        tenantId: env.tenantId,
        candidateId: candidate.id,
        jobRequisitionId: args.requisitionId,
      },
    })
  )
    return candidate.id;
  const existing = await tx.applicationDraft.findFirst({
    where: {
      tenantId: env.tenantId,
      candidateId: candidate.id,
      requisitionId: args.requisitionId,
    },
  });
  // Preserve the first source. Only its owner can renew the mailbox link.
  if (
    existing &&
    (existing.submittedAt ||
      existing.source !== source ||
      (source === "INTERNAL" && existing.sourceEmployeeId !== env.who.id))
  )
    return candidate.id;
  let referral =
    source === "REFERRAL"
      ? await tx.internalReferral.findFirst({
          where: {
            tenantId: env.tenantId,
            candidateId: candidate.id,
            requisitionId: args.requisitionId,
          },
        })
      : null;
  if (
    referral &&
    (referral.referrerEmployeeId !== env.who.id ||
      referral.state === "SUBMITTED")
  )
    return candidate.id;
  // A new command can recover a lost link, but cannot repeatedly mail a contact.
  const lastSent = existing?.updated_at || referral?.updatedAt;
  if (lastSent && lastSent.getTime() > env.now.getTime() - 5 * 60 * 1000)
    return candidate.id;
  const expiresAt = new Date(env.now.getTime() + DRAFT_TTL_MS);
  if (source === "REFERRAL") {
    referral = referral
      ? await tx.internalReferral.update({
          where: { id: referral.id },
          data: { state: "INVITED", expiresAt, version: { increment: 1 } },
        })
      : await tx.internalReferral.create({
          data: {
            tenantId: env.tenantId,
            candidateId: candidate.id,
            requisitionId: args.requisitionId,
            referrerEmployeeId: env.who.id,
            requestKey: args.requestKey,
            fingerprint,
            suppliedName: [firstName, lastName].filter(Boolean).join(" "),
            expiresAt,
          },
        });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  if (existing)
    await tx.applicationDraft.update({
      where: { id: existing.id },
      data: { tokenHash: hashDraftToken(token), expiresAt },
    });
  else
    await tx.applicationDraft.create({
      data: {
        tenantId: env.tenantId,
        candidateId: candidate.id,
        requisitionId: args.requisitionId,
        payload: { firstName, lastName },
        tokenHash: hashDraftToken(token),
        expiresAt,
        source,
        sourceEmployeeId: source === "INTERNAL" ? env.who.id : null,
        internalReferralId: referral?.id || null,
      },
    });
  await queueMailboxMessage(tx, {
    tenantId: env.tenantId,
    candidate,
    email: address,
    token,
    tokenPurpose: "DRAFT",
    templateKey: "portal_draft_link",
    expiresAt,
  });
  if (referral) await referralChanged(tx, referral);
  await audit(
    tx,
    env,
    source === "INTERNAL" ? "INTERNAL_APPLICATION_LINK" : "EMPLOYEE_REFERRAL",
    referral?.id || args.requisitionId,
  );
  return candidate.id;
}
export async function applyInternally(input) {
  return run(input, InternalApplyInput, (tx, env, args) =>
    command(tx, env, args, "INTERNAL", (fingerprint) =>
      invite(tx, env, args, "INTERNAL", fingerprint),
    ),
  );
}
export async function referContact(input) {
  return run(input, InternalReferInput, (tx, env, args) =>
    command(tx, env, args, "REFERRAL", (fingerprint) =>
      invite(tx, env, args, "REFERRAL", fingerprint),
    ),
  );
}
function referralView(row, review, now) {
  return ReferralRow.parse({
    id: row.id,
    requisitionId: row.requisitionId,
    jobTitle: row.requisition.title,
    suppliedName: row.suppliedName,
    state:
      row.state === "INVITED" && row.expiresAt <= now ? "EXPIRED" : row.state,
    bonusEligibility: row.bonusEligibility,
    bonusReason: row.bonusReason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(review ? { referrerEmployeeId: row.referrerEmployeeId } : {}),
  });
}
export async function listInternalReferrals(input = {}) {
  const args = ReferralListInput.parse(input),
    ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  if (!isRecruitmentFlagEnabled("portal"))
    fail("Recruitment applications are unavailable", 404);
  if (!ctx.actorVerified || !tenantId || ctx.system)
    fail("Verified company context is required", 403);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who =
        args.mode === "REVIEW"
          ? (
              await requireRecruitmentActor(
                { tenantId, allowedScopes: ["ORG"] },
                tx,
              )
            ).who
          : await actor(tx, ctx);
      if (args.mode === "MINE" && !ctx.permissions?.includes("hr.self.read"))
        fail("Employee self-service access is required", 403);
      const where = {
        tenantId,
        ...(args.mode === "MINE" ? { referrerEmployeeId: who.id } : {}),
        ...(args.bonusEligibility
          ? { bonusEligibility: args.bonusEligibility }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.internalReferral.findMany({
          where,
          include: { requisition: { select: { title: true } } },
          skip: (args.page - 1) * args.pageSize,
          take: args.pageSize,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        tx.internalReferral.count({ where }),
      ]);
      return ReferralList.parse({
        items: rows.map((row) =>
          referralView(row, args.mode === "REVIEW", new Date()),
        ),
        total,
        page: args.page,
        pageSize: args.pageSize,
      });
    },
    { tenantId },
  );
}
export async function reviewReferralBonus(input) {
  const args = ReferralReviewInput.parse(input),
    ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  if (!isRecruitmentFlagEnabled("portal"))
    fail("Recruitment applications are unavailable", 404);
  if (!ctx.actorVerified || !tenantId || ctx.system)
    fail("Verified company context is required", 403);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const { who } = await requireRecruitmentActor(
        {
          tenantId,
          permission: "hr.recruitment.update",
          allowedScopes: ["ORG"],
        },
        tx,
      );
      const rows = await tx.$queryRawUnsafe(
        'SELECT id FROM "InternalReferral" WHERE "tenantId"=$1::uuid AND id=$2::uuid FOR UPDATE',
        tenantId,
        args.referralId,
      );
      if (!rows.length) fail("Referral not found", 404);
      const row = await tx.internalReferral.findFirst({
        where: { tenantId, id: args.referralId },
      });
      if (row.referrerEmployeeId === who.id)
        fail("An independent recruiter must review your referral", 403);
      if (row.version !== args.expectedVersion)
        fail("Referral changed. Refresh before reviewing.", 412);
      if (row.state !== "SUBMITTED")
        fail(
          "The candidate must submit their own application before bonus review",
        );
      const updated = await tx.internalReferral.update({
        where: { id: row.id },
        data: {
          bonusEligibility: args.bonusEligibility,
          bonusReason: args.reason,
          bonusReviewedAt: new Date(),
          bonusReviewedById: who.id,
          version: { increment: 1 },
        },
        include: { requisition: { select: { title: true } } },
      });
      await audit(tx, { tenantId, who }, "REFERRAL_BONUS_REVIEW", row.id);
      await referralChanged(tx, updated);
      return referralView(updated, true, new Date());
    },
    { tenantId },
  );
}
