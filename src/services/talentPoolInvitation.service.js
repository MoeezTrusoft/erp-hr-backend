import { mcpCtx } from "../lib/requestContext.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { candidateScopeWhere } from "../lib/recruitmentAccess.js";
import { resolveStatusLink } from "./candidateVerification.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { tenantTransaction, isTenantTransaction } from "../lib/rlsTenant.js";
import { enqueueCandidateCommunication } from "./candidateCommunicationQueue.service.js";
import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
// src/services/talentPoolInvitation.service.js — FR-10 residue.
//
// The talent-pool INVITATION LIFECYCLE, the SEGMENTATION surface and the pool
// population's RETENTION SWEEP. The DECISIONS (which transitions are legal, how
// long an invitation lives, what a segment means) live in
// lib/talentPoolPolicy.js; this module is the storage and the wiring.
//
// Three problems this closes, in the plan's own words:
//
//   1. "invitation lifecycle" — an invitation is now a row with a status, an
//      expiry and an answer, not a timestamp appended to a note. Re-inviting an
//      answered candidate is refused (a change of mind is a NEW invitation, so
//      the answer stays history), and a lapsed invitation is EXPIRED, which is
//      not a rejection — it records that nobody answered.
//
//   2. "segmentation" — pool candidates can be selected by skills, location,
//      source, experience and invitation state, with the reason a row fell out of
//      the segment attributed to the filter that rejected it.
//
//   3. "talent-pool retention sweep" — the pool clock was already stamped on
//      `Candidate.retentionUntil`, but the only sweep in the codebase was the
//      APPLICANT one, which ERASES a candidate. Erasing someone kept on file for
//      future roles on the applicant basis is the wrong action under the wrong
//      lawful basis, so the pool sweep EXPIRES their pool memberships instead,
//      dry-run by default and flag-gated for apply exactly like the applicant
//      sweep.
import prisma from "../config/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordRetentionRun } from "../lib/recruitmentOpsMetrics.js";
import {
  DEFAULT_INVITATION_VALIDITY_DAYS,
  checkInvitationTransition,
  invitationExpiry,
  isInvitationExpired,
  matchesSegment,
  resolveInvitationResponse,
  segmentRejectionReasons,
  validateSegment,
} from "../lib/talentPoolPolicy.js";

export const TALENT_POOL_RETENTION_POPULATION = "TALENT_POOL";

const poolError = (message, code, status = 409) =>
  Object.assign(new Error(message), { status, code });

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), {
      status: 400,
      code: "HR-TENANT-REQUIRED",
    });
  }
};

// ── The invitation lifecycle ────────────────────────────────────────────────

/**
 * Invite a candidate to apply.
 *
 * Idempotent while the invitation is OPEN: a second call for the same candidate
 * and role returns the live invitation with `reused: true` instead of stacking a
 * second one. That is a deliberate difference from "refuse" — the caller's intent
 * (the candidate has an open invitation) is already satisfied, and a retry after
 * a network blip is not an error.
 */
export async function inviteToApply({
  tenantId,
  candidateId,
  jobRequisitionId = null,
  poolName = null,
  validityDays = DEFAULT_INVITATION_VALIDITY_DAYS,
  note = null,
  actorId = null,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  if (db === prisma)
    return tenantTransaction(
      prisma,
      (tx) =>
        inviteToApply({
          tenantId,
          candidateId,
          jobRequisitionId,
          poolName,
          validityDays,
          note,
          actorId,
          db: tx,
        }),
      { tenantId, txOptions: { timeout: 20000, maxWait: 10000 } },
    );
  const cId = Number(candidateId);
  if (!Number.isInteger(cId) || cId <= 0) {
    throw poolError(
      "candidateId is required",
      "HR-RECRUITMENT-INVITATION-CANDIDATE-REQUIRED",
      400,
    );
  }
  const rId =
    jobRequisitionId === null ||
    jobRequisitionId === undefined ||
    jobRequisitionId === ""
      ? null
      : Number(jobRequisitionId);
  if (rId !== null && (!Number.isInteger(rId) || rId <= 0)) {
    throw poolError(
      "jobRequisitionId must be a positive integer when given",
      "HR-RECRUITMENT-INVITATION-REQUISITION-INVALID",
      400,
    );
  }

  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    cId,
    tenantId,
  );
  if (rId !== null) {
    const job = await db.jobRequisition.findFirst({
      where: { id: rId, tenantId, status: "POSTED" },
      include: { postings: { where: { channel: "CAREER_SITE" } } },
    });
    if (
      !job ||
      !evaluateRequisitionEligibility(job, { postings: job.postings }).eligible
    )
      throw poolError(
        "The invited job is not open on the careers site",
        "HR-5602",
        409,
      );
  }
  const candidate = await db.candidate.findFirst({
    where: scopedWhere(tenantId, { id: cId }),
    select: { id: true, anonymizedAt: true },
  });
  if (!candidate)
    throw poolError(
      "Candidate not found",
      "HR-RECRUITMENT-INVITATION-CANDIDATE-NOT-FOUND",
      404,
    );
  // Inviting an erased candidate would re-create a record the erasure removed.
  if (candidate.anonymizedAt) {
    throw poolError(
      "Candidate has been anonymized and cannot be invited",
      "HR-RECRUITMENT-INVITATION-CANDIDATE-ANONYMIZED",
    );
  }

  await assertCommunicationsAllowed(
    { tenantId, candidateId: cId, purpose: "TALENT_POOL" },
    { db },
  );
  const open = await db.talentPoolInvitation.findFirst({
    where: scopedWhere(tenantId, {
      candidateId: cId,
      jobRequisitionId: rId,
      status: "INVITED",
    }),
  });
  if (open && !isInvitationExpired(open))
    return { invitation: open, reused: true };
  if (open)
    await db.talentPoolInvitation.update({
      where: { id: open.id },
      data: { status: "EXPIRED", respondedAt: new Date() },
    });

  const invitedAt = new Date();
  const expiresAt = invitationExpiry({ invitedAt, validityDays });
  const invitation = await db.talentPoolInvitation.create({
    data: scopedData(tenantId, {
      candidateId: cId,
      jobRequisitionId: rId,
      poolName: poolName ? String(poolName).trim() : null,
      status: "INVITED",
      invitedById:
        actorId != null && Number.isInteger(Number(actorId))
          ? Number(actorId)
          : null,
      invitedAt,
      expiresAt,
      responseNote: note ? String(note).trim() : null,
    }),
  });

  await enqueueCandidateCommunication(db, {
    tenantId,
    candidateId: cId,
    templateKey: "talent_invitation",
    purpose: "TALENT_POOL",
    dedupeKey: "talent-invitation:" + invitation.id,
    context: { invitationId: invitation.id },
    scheduledAt: invitedAt,
    expiresAt,
  });
  return { invitation, reused: false };
}

/** Move an OPEN invitation to a terminal status, enforcing the one-way map. */
const transitionInvitation = async ({
  tenantId,
  invitationId,
  to,
  responseNote = null,
  actorId = null,
  candidateId = null,
  db = prisma,
}) => {
  requireTenant(tenantId);
  if (db === prisma)
    return tenantTransaction(
      prisma,
      (tx) =>
        transitionInvitation({
          tenantId,
          invitationId,
          to,
          responseNote,
          actorId,
          candidateId,
          db: tx,
        }),
      { tenantId, txOptions: { timeout: 20000, maxWait: 10000 } },
    );
  const id = Number(invitationId);
  if (!Number.isInteger(id) || id <= 0)
    throw poolError("Invitation not found", "HR-5602", 404);
  const where = {
    tenantId,
    id,
    ...(candidateId == null ? {} : { candidateId }),
  };
  const found = await db.talentPoolInvitation.findFirst({ where });
  if (!found) throw poolError("Invitation not found", "HR-5602", 404);
  // Use the same lock order as invitation creation and candidate privacy operations.
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    found.candidateId,
    tenantId,
  );
  await db.$queryRawUnsafe(
    'SELECT id FROM talent_pool_invitations WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    id,
    tenantId,
  );
  const invitation = await db.talentPoolInvitation.findFirst({
    where,
    include: { candidate: { select: { anonymizedAt: true, status: true } } },
  });
  if (
    !invitation ||
    invitation.candidate.anonymizedAt ||
    invitation.candidate.status !== "active"
  )
    throw poolError("Invitation not found", "HR-5602", 404);
  if (invitation.status === to) return invitation;
  if (isInvitationExpired(invitation)) to = "EXPIRED";
  const move = checkInvitationTransition(invitation.status, to);
  if (!move.ok) throw poolError(move.error, move.code);
  const note = responseNote == null ? null : String(responseNote).trim();
  if (note?.length > 4000)
    throw poolError(
      "Response note must be at most 4000 characters",
      "HR-5602",
      400,
    );
  const updated = await db.talentPoolInvitation.update({
    where: { id },
    data: {
      status: to,
      respondedAt: new Date(),
      responseNote: note || invitation.responseNote,
    },
  });
  await db.candidateCommunication.updateMany({
    where: {
      tenantId,
      dedupeKey: "talent-invitation:" + id,
      status: { in: ["PENDING", "FAILED"] },
    },
    data: { status: "CANCELLED", lastError: "INVITATION_ANSWERED" },
  });
  await enqueueHrDomainEvent(db, {
    tenantId,
    eventName: "hr.recruitment.talent_invitation_changed.v1",
    aggregateType: "TalentPoolInvitation",
    aggregateId: id,
    payload: {
      invitationId: String(id),
      candidateId: String(invitation.candidateId),
      status: to,
      actorId: actorId == null ? null : String(actorId),
    },
  });
  return updated;
};

/** Recruiters may record an answer obtained from the candidate, with their own attribution. */
export const respondToInvitation = async ({
  tenantId,
  invitationId,
  response,
  note = null,
  db = prisma,
} = {}) => {
  const { who } = await requireRecruitmentActor(
    { tenantId, permission: "hr.recruitment.update", allowedScopes: ["ORG"] },
    db,
  );
  return transitionInvitation({
    tenantId,
    invitationId,
    to: resolveInvitationResponse(response),
    responseNote: note,
    actorId: who.id,
    db,
  });
};
export const withdrawInvitation = async ({
  tenantId,
  invitationId,
  reason = null,
  db = prisma,
} = {}) => {
  const { who } = await requireRecruitmentActor(
    { tenantId, permission: "hr.recruitment.update", allowedScopes: ["ORG"] },
    db,
  );
  return transitionInvitation({
    tenantId,
    invitationId,
    to: "WITHDRAWN",
    responseNote: reason,
    actorId: who.id,
    db,
  });
};

/** Candidate self-service uses mailbox-token ownership, never a supplied candidate id. */
export const respondToOwnInvitation = async ({
  tenantId,
  token,
  invitationId,
  response,
} = {}) => {
  const subject = await resolveStatusLink({ tenantId, token });
  if (!subject)
    throw poolError(
      "This link is not valid. Request a new status link.",
      "HR-5801",
      404,
    );
  const row = await transitionInvitation({
    tenantId,
    invitationId,
    to: resolveInvitationResponse(response),
    candidateId: subject.candidateId,
  });
  return {
    id: row.id,
    status: row.status,
    jobRequisitionId: row.jobRequisitionId,
  };
};

export const listOwnInvitations = async ({ tenantId, token } = {}) => {
  const subject = await resolveStatusLink({ tenantId, token });
  if (!subject)
    throw poolError(
      "This link is not valid. Request a new status link.",
      "HR-5801",
      404,
    );
  const rows = await prisma.talentPoolInvitation.findMany({
    where: { tenantId, candidateId: subject.candidateId },
    orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      status: true,
      invitedAt: true,
      expiresAt: true,
      jobRequisitionId: true,
      jobRequisition: { select: { title: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      status: isInvitationExpired(row) ? "EXPIRED" : row.status,
      invitedAt: row.invitedAt,
      expiresAt: row.expiresAt,
      jobRequisitionId: row.jobRequisitionId,
      jobTitle: row.jobRequisition?.title ?? "Future opportunities",
    })),
  };
};

/** The tenant's invitations, newest first, optionally narrowed. */
export async function listInvitations({
  tenantId,
  status = null,
  candidateId = null,
  limit = 50,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  const { scope } = await requireRecruitmentActor({ tenantId }, db);
  const where = scopedWhere(tenantId, {
    candidate: { ...candidateScopeWhere(scope), anonymizedAt: null },
  });
  if (status) where.status = String(status).trim().toUpperCase();
  if (candidateId != null) where.candidateId = Number(candidateId);
  const items = await db.talentPoolInvitation.findMany({
    where,
    orderBy: { invitedAt: "desc" },
    take: Math.min(Number(limit) || 50, 200),
  });
  // `expired` is derived, not stored: a row whose expiry has passed is reported as
  // lapsed even before the sweep stamps it, so a reader never sees a live state
  // the clock has already left.
  const asOf = new Date();
  return {
    items: items.map((row) => ({
      ...row,
      responseNote: scope.canSeeInternalNotes ? row.responseNote : null,
      expired: isInvitationExpired(row, asOf),
    })),
    total: items.length,
  };
}

/**
 * The EXPIRY half of the sweep: an INVITED row past its expiry becomes EXPIRED.
 *
 * Dry-run by default, like the applicant sweep — the caller sees which rows it
 * would move, and the transition is the same one the policy module allows.
 */
export async function expireInvitations({
  tenantId,
  asOf = new Date(),
  dryRun = true,
  limit = 500,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  if (!mcpCtx.getStore()?.system && !mcpCtx.getStore()?.recruitmentAutomation)
    await requireRecruitmentActor(
      {
        tenantId,
        permission: "hr.recruitment.update",
        allowedScopes: ["ORG"],
        adminOnly: true,
      },
      db,
    );
  const candidates = await db.talentPoolInvitation.findMany({
    where: scopedWhere(tenantId, {
      status: "INVITED",
      expiresAt: { lte: new Date(asOf) },
      candidate: { status: "active", anonymizedAt: null },
    }),
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 500, 2000),
  });
  const due = candidates.filter((row) => isInvitationExpired(row, asOf));
  if (dryRun)
    return {
      dryRun: true,
      asOf: new Date(asOf),
      wouldExpire: due.map((r) => r.id),
    };

  const expired = [];
  for (const row of due) {
    try {
      const updated = await transitionInvitation({
        tenantId,
        invitationId: row.id,
        to: "EXPIRED",
        db,
      });
      expired.push(updated.id);
    } catch (error) {
      if (![404, 409].includes(error.status)) throw error;
    }
  }
  return { dryRun: false, asOf: new Date(asOf), expired };
}

// ── Segmentation ────────────────────────────────────────────────────────────

/**
 * Select pool candidates by a validated segment.
 *
 * The rows are loaded through the pool memberships (so a candidate with no pool
 * membership is never "segmented" into one), then the pure predicate decides.
 * The projection built here is the contract `lib/talentPoolPolicy.matchesSegment`
 * documents — a change there and a change here have to be made together, which is
 * why the shape is built in ONE place.
 */
export async function segmentTalentPool({
  tenantId,
  filters = {},
  limit = 100,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  await requireRecruitmentActor({ tenantId, allowedScopes: ["ORG"] }, db);
  if (db === prisma)
    return tenantTransaction(
      prisma,
      (tx) => segmentTalentPool({ tenantId, filters, limit, db: tx }),
      {
        tenantId,
        txOptions: {
          isolationLevel: "RepeatableRead",
          maxWait: 10000,
          timeout: 30000,
        },
      },
    );
  return readTalentPoolSegment({ tenantId, filters, limit, db });
}

/** Scheduler-only aggregate projection; never exposes candidate records. */
export async function summarizeTalentPoolSegment({
  tenantId,
  filters,
  db,
} = {}) {
  const ctx = mcpCtx.getStore();
  if (
    !ctx?.recruitmentAutomation ||
    ctx?.user?.tenantId !== tenantId ||
    !isTenantTransaction(db)
  )
    throw poolError("Scheduler company transaction required", "HR-5304", 403);
  const result = await readTalentPoolSegment({
    tenantId,
    filters,
    limit: 1,
    db,
  });
  return { filters: result.filters, counts: result.counts };
}
async function readTalentPoolSegment({ tenantId, filters, limit, db }) {
  requireTenant(tenantId);
  const validated = validateSegment(filters);
  if (!validated.ok)
    throw poolError(
      validated.error,
      validated.code || "HR-RECRUITMENT-SEGMENT-INVALID",
      422,
    );
  const segment = validated.filters;
  if (
    !Number.isSafeInteger(Number(limit)) ||
    Number(limit) < 1 ||
    Number(limit) > 500
  )
    throw poolError("Limit must be between 1 and 500", "HR-5602", 422);
  const asOf = new Date();
  const rowsByCandidate = new Map();
  let cursor = 0;
  // Scan the complete pool by stable candidate id. Limit bounds the returned
  // matches, never the source population or its counts.
  for (;;) {
    const candidates = await db.candidate.findMany({
      where: {
        tenantId,
        id: { gt: cursor },
        talentPools: { some: { tenantId } },
      },
      orderBy: { id: "asc" },
      take: 500,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        location: true,
        source: true,
        parsedResume: true,
        anonymizedAt: true,
        status: true,
        retentionUntil: true,
        candidateSkills: { where: { tenantId }, select: { name: true } },
        talentPools: {
          where: { tenantId },
          select: { poolName: true },
          orderBy: { id: "asc" },
        },
        invitations: {
          where: { tenantId },
          select: { status: true, invitedAt: true, expiresAt: true },
          orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
        },
      },
    });
    for (const candidate of candidates) {
      rowsByCandidate.set(candidate.id, {
        candidateId: candidate.id,
        name:
          [candidate.firstName, candidate.lastName].filter(Boolean).join(" ") ||
          null,
        location: candidate.location ?? null,
        source: candidate.source ?? null,
        experienceYears: deriveExperienceYears(candidate.parsedResume),
        skillNames: candidate.candidateSkills
          .map((s) => s.name)
          .filter(Boolean),
        poolNames: [...new Set(candidate.talentPools.map((p) => p.poolName))],
        anonymized: Boolean(candidate.anonymizedAt),
        inactive: candidate.status !== "active",
        retentionExpired: Boolean(
          candidate.retentionUntil && candidate.retentionUntil <= asOf,
        ),
        hasOpenInvitation: candidate.invitations.some(
          (i) => i.status === "INVITED" && !isInvitationExpired(i, asOf),
        ),
        lastInvitedAt: candidate.invitations[0]?.invitedAt ?? null,
      });
    }
    if (candidates.length < 500) break;
    cursor = candidates.at(-1).id;
  }

  const rows = [...rowsByCandidate.values()];
  const matched = [];
  const excluded = [];
  for (const row of rows) {
    // An erased candidate is not a segment member: their PII is gone, so listing
    // them would be presenting a tombstone as a person.
    if (row.anonymized) {
      excluded.push({ candidateId: row.candidateId, reason: "anonymized" });
      continue;
    }
    if (row.inactive || row.retentionExpired) {
      excluded.push({
        candidateId: row.candidateId,
        reason: row.inactive ? "inactive" : "retention",
      });
      continue;
    }
    if (matchesSegment(row, segment, asOf)) {
      matched.push({
        candidateId: row.candidateId,
        name: row.name,
        location: row.location,
        source: row.source,
        experienceYears: row.experienceYears,
        skills: row.skillNames,
        pools: row.poolNames,
        hasOpenInvitation: row.hasOpenInvitation,
      });
    } else {
      excluded.push({
        candidateId: row.candidateId,
        reason: segmentRejectionReasons(row, segment, asOf)[0] || "filter",
      });
    }
  }

  // Attributable shortfall: a count alone cannot tell an operator whether the
  // segment is empty because the pool is small or because one filter is wrong.
  const excludedByReason = {};
  for (const row of excluded)
    excludedByReason[row.reason] = (excludedByReason[row.reason] || 0) + 1;

  return {
    filters: segment,
    matched: matched.slice(0, Number(limit)),
    truncated: matched.length > Number(limit),
    counts: {
      candidates: rows.length,
      matched: matched.length,
      excluded: excluded.length,
    },
    excludedByReason,
  };
}

/** The candidate's experience in years, derived from the parsed resume when present. */
const deriveExperienceYears = (parsedResume) => {
  if (!parsedResume || typeof parsedResume !== "object") return null;
  const raw =
    parsedResume.totalExperienceYears ??
    parsedResume.experienceYears ??
    parsedResume.yearsOfExperience ??
    parsedResume.totalExperience;
  if (
    !["string", "number"].includes(typeof raw) ||
    !/^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(String(raw))
  )
    return null;
  return Number(raw);
};

// ── The pool population's retention sweep ───────────────────────────────────

/**
 * Expire the POOL memberships of candidates whose TALENT_POOL clock has closed.
 *
 * What it deliberately does NOT do: erase the candidate. `retentionUntil` is
 * stamped under the TALENT_POOL policy when someone is kept on file for future
 * roles, and the candidate may also be a live applicant; the pool action is to
 * stop keeping them for future roles, which is the membership. Erasure stays the
 * APPLICANT sweep's job, under the APPLICANT clock (see previewRetentionDue).
 *
 * Legal holds are honoured: a held candidate is reported as suspended rather than
 * swept, because the hold exists precisely to stop the clock.
 */
export async function sweepTalentPoolRetention({
  tenantId,
  asOf = new Date(),
  dryRun = true,
  limit = 500,
  actorId = null,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  if (!mcpCtx.getStore()?.system) {
    const { who } = await requireRecruitmentActor(
      {
        tenantId,
        permission: "hr.recruitment.update",
        allowedScopes: ["ORG"],
        adminOnly: true,
      },
      db,
    );
    actorId = who.id;
  }
  const cutoff = new Date(asOf);
  if (!Number.isFinite(cutoff.getTime()))
    throw poolError("Invalid retention date", "HR-5602", 400);

  const memberships = await db.talentPool.findMany({
    where: scopedWhere(tenantId, {}),
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 500, 2000),
    include: {
      candidate: {
        select: {
          id: true,
          retentionUntil: true,
          retentionPopulation: true,
          anonymizedAt: true,
        },
      },
    },
  });

  const due = memberships.filter((membership) => {
    const candidate = membership.candidate;
    if (!candidate || candidate.anonymizedAt) return false;
    if (
      !candidate.retentionUntil ||
      new Date(candidate.retentionUntil) > cutoff
    )
      return false;
    // NULL is a pre-existing clock, stamped under the APPLICANT policy — the only
    // one that existed then — so it is NOT the pool's clock to sweep.
    return candidate.retentionPopulation === TALENT_POOL_RETENTION_POPULATION;
  });

  const candidateIds = [...new Set(due.map((m) => m.candidateId))];
  const holds = candidateIds.length
    ? await db.candidateLegalHold.findMany({
        where: scopedWhere(tenantId, {
          candidateId: { in: candidateIds },
          releasedAt: null,
        }),
        select: { candidateId: true },
      })
    : [];
  const heldIds = new Set(holds.map((h) => h.candidateId));

  const sweepable = due.filter((m) => !heldIds.has(m.candidateId));
  const suspended = due
    .filter((m) => heldIds.has(m.candidateId))
    .map((m) => ({ membershipId: m.id, candidateId: m.candidateId }));

  if (dryRun) {
    recordRetentionRun("dry-run");
    return {
      dryRun: true,
      population: TALENT_POOL_RETENTION_POPULATION,
      asOf: cutoff,
      wouldRemoveMemberships: sweepable.map((m) => m.id),
      candidates: [...new Set(sweepable.map((m) => m.candidateId))],
      suspendedByLegalHold: suspended,
      // Stated explicitly so nobody reads this sweep as an erasure.
      candidateErasure:
        "not performed — the pool sweep removes memberships; erasure is the APPLICANT sweep's action",
    };
  }

  if (!isRecruitmentFlagEnabled("retention")) {
    recordRetentionRun("refused-flag");
    return {
      dryRun: true,
      refused: true,
      reason: "flag-disabled",
      population: TALENT_POOL_RETENTION_POPULATION,
      asOf: cutoff,
      wouldRemoveMemberships: sweepable.map((m) => m.id),
      suspendedByLegalHold: suspended,
    };
  }

  const removed = [];
  if (sweepable.length) {
    await db.talentPool.deleteMany({
      where: scopedWhere(tenantId, { id: { in: sweepable.map((m) => m.id) } }),
    });
    removed.push(...sweepable.map((m) => m.id));
    // The clock belongs to the pool basis; with the memberships gone there is
    // nothing left counting down on it, so the marker and clock are cleared for
    // candidates who are no longer in ANY pool. Leaving them stamped would make
    // the next sweep re-report a population that no longer exists.
    const stillPooled = await db.talentPool.findMany({
      where: scopedWhere(tenantId, {
        candidateId: { in: [...new Set(sweepable.map((m) => m.candidateId))] },
      }),
      select: { candidateId: true },
    });
    const stillPooledIds = new Set(stillPooled.map((row) => row.candidateId));
    const cleared = [...new Set(sweepable.map((m) => m.candidateId))].filter(
      (id) => !stillPooledIds.has(id),
    );
    if (cleared.length) {
      await db.candidate.updateMany({
        where: scopedWhere(tenantId, { id: { in: cleared } }),
        data: { retentionUntil: null, retentionPopulation: null },
      });
    }
    logger.info(
      {
        tenantId,
        actorId,
        removed: removed.length,
        candidates: cleared.length,
      },
      "talent pool retention sweep applied",
    );
  }

  recordRetentionRun("applied");
  return {
    dryRun: false,
    population: TALENT_POOL_RETENTION_POPULATION,
    asOf: cutoff,
    removedMemberships: removed,
    suspendedByLegalHold: suspended,
  };
}
