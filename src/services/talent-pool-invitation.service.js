// src/services/talent-pool-invitation.service.js — FR-10 residue.
//
// The talent-pool INVITATION LIFECYCLE, the SEGMENTATION surface and the pool
// population's RETENTION SWEEP. The DECISIONS (which transitions are legal, how
// long an invitation lives, what a segment means) live in
// lib/talent-pool-policy.util.js; this module is the storage and the wiring.
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
//
// Phase 6 (invitationLinks) — the candidate can answer through an emailed,
// single-use link (services/invitation-response.service.js). Every answer goes
// through respondToInvitation, so a nurture acceptance creates the application
// whichever way it arrives; `respondedVia` records who answered (RECRUITER by
// default, CANDIDATE_LINK from the link), and any terminal status clears the
// link's hash and expiry, so an answered, withdrawn or expired invitation has
// no live link left.
import prisma from "../config/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { assertCommunicationsAllowed } from "./candidate-privacy.service.js";
import { recordRetentionRun } from "../lib/recruitment-ops-metrics.util.js";
import {
  DEFAULT_INVITATION_VALIDITY_DAYS,
  checkInvitationTransition,
  invitationExpiry,
  isInvitationExpired,
  matchesSegment,
  resolveInvitationResponse,
  segmentRejectionReasons,
  validateSegment,
} from "../lib/talent-pool-policy.util.js";

export const TALENT_POOL_RETENTION_POPULATION = "TALENT_POOL";

const poolError = (message, code, status = 409) => Object.assign(new Error(message), { status, code });

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  }
};

// ── The invitation lifecycle ────────────────────────────────────────────────

// Phase 6 — what callers (tools, REST, events) get back: never the link's hash.
const presentInvitation = (row) => {
  if (!row) return row;
  const { responseTokenHash: _hash, ...rest } = row;
  return rest;
};

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
  nurtureRunId = null,
  db = prisma,
} = {}) {
  requireTenant(tenantId);
  const cId = Number(candidateId);
  if (!Number.isInteger(cId) || cId <= 0) {
    throw poolError("candidateId is required", "HR-RECRUITMENT-INVITATION-CANDIDATE-REQUIRED", 400);
  }
  const rId = jobRequisitionId === null || jobRequisitionId === undefined || jobRequisitionId === ""
    ? null
    : Number(jobRequisitionId);
  if (rId !== null && (!Number.isInteger(rId) || rId <= 0)) {
    throw poolError("jobRequisitionId must be a positive integer when given", "HR-RECRUITMENT-INVITATION-REQUISITION-INVALID", 400);
  }

  const candidate = await db.candidate.findFirst({
    where: scopedWhere(tenantId, { id: cId }),
    select: { id: true, anonymizedAt: true },
  });
  if (!candidate) throw poolError("Candidate not found", "HR-RECRUITMENT-INVITATION-CANDIDATE-NOT-FOUND", 404);
  // Inviting an erased candidate would re-create a record the erasure removed.
  if (candidate.anonymizedAt) {
    throw poolError(
      "Candidate has been anonymized and cannot be invited",
      "HR-RECRUITMENT-INVITATION-CANDIDATE-ANONYMIZED",
    );
  }
  // D-11 — an invitation is unsolicited outbound contact: a do-not-contact
  // entry or withdrawn consent blocks it, exactly as it blocks an offer send.
  await assertCommunicationsAllowed({ tenantId, candidateId: cId, purpose: "TALENT_POOL" }, { db });

  const open = await db.talentPoolInvitation.findFirst({
    where: scopedWhere(tenantId, { candidateId: cId, jobRequisitionId: rId, status: "INVITED" }),
  });
  if (open && !isInvitationExpired(open)) return { invitation: presentInvitation(open), reused: true };

  const invitedAt = new Date();
  const expiresAt = invitationExpiry({ invitedAt, validityDays });
  const invitation = await db.talentPoolInvitation.create({
    data: scopedData(tenantId, {
      candidateId: cId,
      jobRequisitionId: rId,
      poolName: poolName ? String(poolName).trim() : null,
      status: "INVITED",
      invitedById: Number.isInteger(Number(actorId)) ? Number(actorId) : null,
      invitedAt,
      expiresAt,
      responseNote: note ? String(note).trim() : null,
      // Phase 5 — the nurture run whose approval sent it (absent otherwise, so
      // every other caller writes exactly what it wrote before).
      ...(Number.isInteger(Number(nurtureRunId)) && Number(nurtureRunId) > 0 ? { nurtureRunId: Number(nurtureRunId) } : {}),
    }),
  });

  return { invitation: presentInvitation(invitation), reused: false };
}

// Who answered: a recruiter recording the answer, or the candidate's link.
export const INVITATION_RESPONDED_VIA = Object.freeze({ RECRUITER: "RECRUITER", CANDIDATE_LINK: "CANDIDATE_LINK" });
const ANSWER_STATUSES = Object.freeze(["ACCEPTED", "DECLINED"]);

const linkNoLongerValid = () =>
  poolError("This invitation link is no longer valid", "HR-RECRUITMENT-INVITATION-LINK-INVALID", 404);

/**
 * Move an OPEN invitation to a terminal status, enforcing the one-way map.
 *
 * Every target status is terminal, so the response link's hash and expiry are
 * cleared with the move. With `tokenHash` (the candidate's link) the write is a
 * guarded claim on that hash: of two concurrent answers through one link,
 * exactly one lands and the other is refused as an invalid link.
 */
const transitionInvitation = async ({
  tenantId,
  invitationId,
  to,
  responseNote = null,
  via = INVITATION_RESPONDED_VIA.RECRUITER,
  tokenHash = null,
  db = prisma,
}) => {
  requireTenant(tenantId);
  const invitation = await db.talentPoolInvitation.findFirst({
    where: scopedWhere(tenantId, { id: Number(invitationId) }),
  });
  if (!invitation) throw poolError("Invitation not found", "HR-RECRUITMENT-INVITATION-NOT-FOUND", 404);

  const move = checkInvitationTransition(invitation.status, to);
  if (!move.ok) throw poolError(move.error, move.code);

  const note = responseNote === null || responseNote === undefined ? null : String(responseNote).trim();
  const respondedAt = new Date();
  const data = {
    status: to,
    respondedAt,
    responseNote: note && note.length ? note : invitation.responseNote,
    // Single-use: no terminal invitation keeps a live link.
    responseTokenHash: null,
    responseTokenExpiresAt: null,
    // Only an answer has a responder; a withdrawal or a lapse does not.
    ...(ANSWER_STATUSES.includes(to) ? { respondedVia: via } : {}),
  };
  if (!tokenHash) {
    return presentInvitation(await db.talentPoolInvitation.update({ where: { id: invitation.id }, data }));
  }
  const claim = await db.talentPoolInvitation.updateMany({
    where: scopedWhere(tenantId, {
      id: invitation.id,
      status: invitation.status,
      responseTokenHash: tokenHash,
      responseTokenExpiresAt: { gt: respondedAt },
    }),
    data,
  });
  if (Number(claim?.count ?? 0) !== 1) throw linkNoLongerValid();
  return presentInvitation(await db.talentPoolInvitation.findFirst({ where: scopedWhere(tenantId, { id: invitation.id }) }));
};

/**
 * The candidate's answer to an open invitation (ACCEPTED / DECLINED).
 *
 * Phase 5 (talentNurture flag) — accepting a NURTURE invitation (one a
 * recruiter-approved nurture run sent for a requisition) is applying: the
 * application is created through the gated intake BEFORE the invitation is
 * marked accepted, so a refusal (applications closed, do-not-contact) refuses
 * the acceptance and leaves the invitation open, and the answer carries the
 * application under `application`. Other invitations are unchanged: a
 * role-specific invitation from hr_talent_pool_invite already moved the
 * candidate into the pipeline when it was sent.
 *
 * Phase 6 — `via` records who answered (RECRUITER unless the candidate's link
 * calls this with CANDIDATE_LINK and the link's `tokenHash`, which makes the
 * answer a guarded single-use claim on that link).
 */
export const respondToInvitation = async ({
  tenantId,
  invitationId,
  response,
  note = null,
  via = INVITATION_RESPONDED_VIA.RECRUITER,
  tokenHash = null,
  db = prisma,
} = {}) => {
  const to = resolveInvitationResponse(response);
  const answeredBy = Object.values(INVITATION_RESPONDED_VIA).includes(via) ? via : INVITATION_RESPONDED_VIA.RECRUITER;
  if (to === "ACCEPTED" && isRecruitmentFlagEnabled("talentNurture")) {
    return acceptInvitation({ tenantId, invitationId, note, via: answeredBy, tokenHash, db });
  }
  return transitionInvitation({ tenantId, invitationId, to, responseNote: note, via: answeredBy, tokenHash, db });
};

const acceptInvitation = async ({ tenantId, invitationId, note, via, tokenHash, db }) => {
  requireTenant(tenantId);
  const invitation = await db.talentPoolInvitation.findFirst({
    where: scopedWhere(tenantId, { id: Number(invitationId) }),
  });
  if (!invitation?.nurtureRunId || !invitation.jobRequisitionId) {
    return transitionInvitation({ tenantId, invitationId, to: "ACCEPTED", responseNote: note, via, tokenHash, db });
  }
  // Refuse an illegal answer before any application is created.
  const move = checkInvitationTransition(invitation.status, "ACCEPTED");
  if (!move.ok) throw poolError(move.error, move.code);
  // A link answer is refused before the intake, too, once the link is spent.
  if (tokenHash && invitation.responseTokenHash !== tokenHash) throw linkNoLongerValid();

  // Loaded on demand: the nurture service depends on this module (inviteToApply),
  // and only a flag-on nurture acceptance needs it.
  const { intakeAcceptedNurtureInvitation } = await import("./talent-nurture.service.js");
  const application = await intakeAcceptedNurtureInvitation({ tenantId, invitation });
  const updated = await transitionInvitation({ tenantId, invitationId, to: "ACCEPTED", responseNote: note, via, tokenHash, db });
  return { ...updated, application };
};

/** A recruiter pulling back an open invitation. */
export const withdrawInvitation = async ({ tenantId, invitationId, reason = null, db = prisma } = {}) =>
  transitionInvitation({ tenantId, invitationId, to: "WITHDRAWN", responseNote: reason, db });

/** An optional positive-integer filter: null when absent, a 400 when malformed. */
const optionalIdFilter = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw Object.assign(new Error(`${field} must be a positive whole number`), {
      status: 400,
      code: "HR-RECRUITMENT-INVITATION-FILTER-INVALID",
    });
  }
  return n;
};

/**
 * The tenant's invitations, newest first, optionally narrowed by status,
 * candidate or (Phase 7) the nurture run whose approval sent them. Every row
 * carries its nurtureRunId (null for a recruiter's own invitation).
 */
export async function listInvitations({ tenantId, status = null, candidateId = null, nurtureRunId = null, limit = 50, db = prisma } = {}) {
  requireTenant(tenantId);
  const runId = optionalIdFilter(nurtureRunId, "nurtureRunId");
  const where = scopedWhere(tenantId, {});
  if (status) where.status = String(status).trim().toUpperCase();
  if (candidateId != null) where.candidateId = Number(candidateId);
  if (runId) where.nurtureRunId = runId;
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
    items: items.map((row) => ({ ...presentInvitation(row), nurtureRunId: row.nurtureRunId ?? null, expired: isInvitationExpired(row, asOf) })),
    total: items.length,
  };
}

/**
 * The EXPIRY half of the sweep: an INVITED row past its expiry becomes EXPIRED.
 *
 * Dry-run by default, like the applicant sweep — the caller sees which rows it
 * would move, and the transition is the same one the policy module allows.
 */
export async function expireInvitations({ tenantId, asOf = new Date(), dryRun = true, limit = 500, db = prisma } = {}) {
  requireTenant(tenantId);
  const candidates = await db.talentPoolInvitation.findMany({
    where: scopedWhere(tenantId, { status: "INVITED" }),
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 500, 2000),
  });
  const due = candidates.filter((row) => isInvitationExpired(row, asOf));
  if (dryRun) return { dryRun: true, asOf: new Date(asOf), wouldExpire: due.map((r) => r.id) };

  const expired = [];
  for (const row of due) {
    const updated = await transitionInvitation({
      tenantId,
      invitationId: row.id,
      to: "EXPIRED",
      db,
    });
    expired.push(updated.id);
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
export async function segmentTalentPool({ tenantId, filters = {}, limit = 100, db = prisma } = {}) {
  requireTenant(tenantId);
  const validated = validateSegment(filters);
  if (!validated.ok) throw poolError(validated.error, validated.code || "HR-RECRUITMENT-SEGMENT-INVALID", 422);
  const segment = validated.filters;

  const memberships = await db.talentPool.findMany({
    where: scopedWhere(tenantId, {}),
    orderBy: { addedAt: "desc" },
    take: Math.min(Number(limit) || 100, 500) * 4,
    include: { candidate: { include: { candidateSkills: true } } },
  });

  const candidateIds = [...new Set(memberships.map((m) => m.candidateId))];
  const openInvitations = candidateIds.length
    ? await db.talentPoolInvitation.findMany({
      where: scopedWhere(tenantId, { candidateId: { in: candidateIds }, status: "INVITED" }),
      select: { candidateId: true, invitedAt: true, expiresAt: true },
    })
    : [];
  const invitationByCandidate = new Map();
  for (const row of openInvitations) {
    const existing = invitationByCandidate.get(row.candidateId);
    if (!existing || row.invitedAt > existing.invitedAt) invitationByCandidate.set(row.candidateId, row);
  }

  const rowsByCandidate = new Map();
  for (const membership of memberships) {
    const candidate = membership.candidate;
    if (!candidate) continue;
    const existing = rowsByCandidate.get(candidate.id) || {
      candidateId: candidate.id,
      name: [candidate.firstName, candidate.lastName].filter(Boolean).join(" ") || null,
      location: candidate.location ?? null,
      source: candidate.source ?? null,
      experienceYears: deriveExperienceYears(candidate.parsedResume),
      skillNames: (candidate.candidateSkills || []).map((s) => s.name).filter(Boolean),
      poolNames: [],
      anonymized: Boolean(candidate.anonymizedAt),
      hasOpenInvitation: false,
      lastInvitedAt: null,
    };
    existing.poolNames.push(membership.poolName);
    const invitation = invitationByCandidate.get(candidate.id);
    if (invitation && !isInvitationExpired(invitation, new Date())) {
      existing.hasOpenInvitation = true;
      existing.lastInvitedAt = invitation.invitedAt;
    } else if (invitation && (!existing.lastInvitedAt || invitation.invitedAt > existing.lastInvitedAt)) {
      existing.lastInvitedAt = invitation.invitedAt;
    }
    rowsByCandidate.set(candidate.id, existing);
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
    if (matchesSegment(row, segment)) {
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
      excluded.push({ candidateId: row.candidateId, reason: segmentRejectionReasons(row, segment)[0] || "filter" });
    }
  }

  // Attributable shortfall: a count alone cannot tell an operator whether the
  // segment is empty because the pool is small or because one filter is wrong.
  const excludedByReason = {};
  for (const row of excluded) excludedByReason[row.reason] = (excludedByReason[row.reason] || 0) + 1;

  return {
    filters: segment,
    matched,
    counts: { candidates: rows.length, matched: matched.length, excluded: excluded.length },
    excludedByReason,
  };
}

/** The candidate's experience in years, derived from the parsed resume when present. */
const deriveExperienceYears = (parsedResume) => {
  if (!parsedResume || typeof parsedResume !== "object") return null;
  const years = Number(parsedResume.totalExperienceYears ?? parsedResume.experienceYears);
  return Number.isFinite(years) ? years : null;
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
  const cutoff = new Date(asOf);

  const memberships = await db.talentPool.findMany({
    where: scopedWhere(tenantId, {}),
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 500, 2000),
    include: { candidate: { select: { id: true, retentionUntil: true, retentionPopulation: true, anonymizedAt: true } } },
  });

  const due = memberships.filter((membership) => {
    const candidate = membership.candidate;
    if (!candidate || candidate.anonymizedAt) return false;
    if (!candidate.retentionUntil || new Date(candidate.retentionUntil) > cutoff) return false;
    // NULL is a pre-existing clock, stamped under the APPLICANT policy — the only
    // one that existed then — so it is NOT the pool's clock to sweep.
    return candidate.retentionPopulation === TALENT_POOL_RETENTION_POPULATION;
  });

  const candidateIds = [...new Set(due.map((m) => m.candidateId))];
  const holds = candidateIds.length
    ? await db.candidateLegalHold.findMany({
      where: scopedWhere(tenantId, { candidateId: { in: candidateIds }, releasedAt: null }),
      select: { candidateId: true },
    })
    : [];
  const heldIds = new Set(holds.map((h) => h.candidateId));

  const sweepable = due.filter((m) => !heldIds.has(m.candidateId));
  const suspended = due.filter((m) => heldIds.has(m.candidateId)).map((m) => ({ membershipId: m.id, candidateId: m.candidateId }));

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
      candidateErasure: "not performed — the pool sweep removes memberships; erasure is the APPLICANT sweep's action",
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
      where: scopedWhere(tenantId, { candidateId: { in: [...new Set(sweepable.map((m) => m.candidateId))] } }),
      select: { candidateId: true },
    });
    const stillPooledIds = new Set(stillPooled.map((row) => row.candidateId));
    const cleared = [...new Set(sweepable.map((m) => m.candidateId))].filter((id) => !stillPooledIds.has(id));
    if (cleared.length) {
      await db.candidate.updateMany({
        where: scopedWhere(tenantId, { id: { in: cleared } }),
        data: { retentionUntil: null, retentionPopulation: null },
      });
    }
    logger.info(
      { tenantId, actorId, removed: removed.length, candidates: cleared.length },
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
