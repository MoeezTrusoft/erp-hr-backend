import { currentCorrelationId } from "../lib/requestContext.js";
import { randomBytes } from "node:crypto";
import { tenantTransaction } from "../lib/rlsTenant.js";
// src/services/candidatePrivacy.service.js
//
// Phase 2.5 / 10 — candidate privacy, Do-Not-Contact, retention, anonymization.
//
// Candidate records are PERSONAL DATA belonging to someone who is not an employee.
// The rules that matter, and how they are enforced here:
//
//  1. A DNC entry BLOCKS contact, and it is keyed by NORMALIZED EMAIL, not by
//     candidate id — the address is the durable identity. A person who asked not
//     to be contacted stays that way even if a recruiter later re-imports them as
//     a new candidate row.
//  2. DNC and CONSENT are different things and are never conflated: DNC is a
//     request about CONTACT, consent is a basis for PROCESSING. Either can block.
//  3. Withdrawing consent must not erase history — consent rows are append-only,
//     so an audit can see what was consented to, when, and under which policy
//     version.
//  4. Anonymization is IRREVERSIBLE, so it refuses to run while a legal hold is
//     active, and it is idempotent (a second call reports the existing state
//     instead of re-redacting). Aggregate data is deliberately preserved; PII is
//     not.
//  5. Retention is opt-in per tenant. With no policy there is no retention clock,
//     so legacy candidate rows are never deleted by applying a migration.
//
// Every read and write is tenant-scoped, and every id-taking operation verifies
// the row belongs to the caller's tenant before touching it.
import prisma from "../lib/prisma.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordRetentionRun } from "../lib/recruitmentOpsMetrics.js";

import { collectCandidateMedia } from "./candidate-media-cleanup.service.js";
import { logAction } from "../utils/logs.js";

export const DNC_STATUS = Object.freeze({ ACTIVE: "ACTIVE", LIFTED: "LIFTED" });
export const CONSENT_STATUS = Object.freeze({
  UNKNOWN: "UNKNOWN",
  GRANTED: "GRANTED",
  WITHDRAWN: "WITHDRAWN",
});
export const CONSENT_PURPOSES = Object.freeze([
  "PROCESSING",
  "TALENT_POOL",
  "MARKETING",
]);
export const RETENTION_POPULATIONS = Object.freeze([
  "APPLICANT",
  "TALENT_POOL",
]);
export const REQUEST_TYPES = Object.freeze(["ACCESS", "CORRECTION", "ERASURE"]);
export const REQUEST_STATUS = Object.freeze({
  RECEIVED: "RECEIVED",
  IN_PROGRESS: "IN_PROGRESS",
  FULFILLED: "FULFILLED",
  REJECTED: "REJECTED",
});
const CLOSED_REQUEST_STATUSES = Object.freeze([
  REQUEST_STATUS.FULFILLED,
  REQUEST_STATUS.REJECTED,
]);

// Statutory response window when a request is recorded. 30 days is the common
// baseline (GDPR Art.12(3)); a tenant can still pass an explicit dueAt.
const DEFAULT_REQUEST_SLA_DAYS = 30;

const privacyError = (message, code, status = 409) =>
  Object.assign(new Error(message), { status, code });

export const normalizeEmail = (email) =>
  String(email ?? "")
    .trim()
    .toLowerCase();

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), {
      status: 400,
      code: "HR-TENANT-REQUIRED",
    });
  }
};

const requireText = (value, field, code) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw privacyError(`${field} is required`, code, 400);
  return text;
};

const requireEnum = (value, allowed, field, code) => {
  const text = requireText(value, field, code);
  if (!allowed.includes(text)) {
    throw privacyError(
      `${field} must be one of ${allowed.join(", ")} (received "${text}")`,
      code,
      400,
    );
  }
  return text;
};

const requireCandidate = async (db, tenantId, candidateId) => {
  const id = Number(candidateId);
  if (!Number.isInteger(id) || id <= 0) {
    throw privacyError(
      "A valid candidate id is required",
      "HR-RECRUITMENT-CANDIDATE-REQUIRED",
      400,
    );
  }
  const candidate = await db.candidate.findFirst({
    where: withTenant(tenantId, { id }),
    select: {
      id: true,
      email: true,
      consentStatus: true,
      anonymizedAt: true,
      resumeMediaId: true,
      status: true,
      retentionUntil: true,
      archivedAt: true,
    },
  });
  if (!candidate)
    throw privacyError(
      "Candidate not found",
      "HR-RECRUITMENT-CANDIDATE-NOT-FOUND",
      404,
    );
  return candidate;
};

// ── Consent ──────────────────────────────────────────────────────────────────

/**
 * Append a consent decision. `PROCESSING` additionally mirrors the aggregate
 * status onto Candidate.consentStatus so screening/portal queries can filter
 * cheaply; the history row remains the evidence of record.
 */
export async function recordConsent(
  {
    tenantId,
    candidateId,
    purpose,
    status,
    policyVersion = null,
    source = null,
    evidence = null,
    actorId = null,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPurpose = requireEnum(
    purpose,
    CONSENT_PURPOSES,
    "purpose",
    "HR-RECRUITMENT-CONSENT-PURPOSE-INVALID",
  );
  const resolvedStatus = requireEnum(
    status,
    [CONSENT_STATUS.GRANTED, CONSENT_STATUS.WITHDRAWN],
    "status",
    "HR-RECRUITMENT-CONSENT-STATUS-INVALID",
  );
  if (
    resolvedStatus === CONSENT_STATUS.GRANTED &&
    !String(policyVersion ?? "").trim()
  )
    throw privacyError(
      "Consent must identify the policy version the candidate accepted",
      "HR-5701",
      400,
    );
  if (!options.db)
    return tenantTransaction(
      prisma,
      (tx) =>
        recordConsent(
          {
            tenantId,
            candidateId,
            purpose: resolvedPurpose,
            status: resolvedStatus,
            policyVersion,
            source,
            evidence,
            actorId,
          },
          { db: tx },
        ),
      { tenantId },
    );
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    Number(candidateId),
    tenantId,
  );
  const candidate = await requireCandidate(db, tenantId, candidateId);
  if (candidate.anonymizedAt)
    throw privacyError("Candidate data has already been erased", "HR-5701");

  const consent = await db.candidateConsent.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      purpose: resolvedPurpose,
      status: resolvedStatus,
      policyVersion,
      source,
      evidence,
      recordedById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
  });

  let candidateConsentStatus = candidate.consentStatus;
  if (resolvedPurpose === "PROCESSING") {
    candidateConsentStatus = resolvedStatus;
    await db.candidate.updateMany({
      where: withTenant(tenantId, { id: candidate.id }),
      data: { consentStatus: resolvedStatus, consentUpdatedAt: new Date() },
    });
  }

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Update",
    module: "Candidate Consent",
    result: "SUCCESS",
    notes: `Consent ${resolvedStatus} for candidate ${candidate.id} (${resolvedPurpose}).`,
    tenantId,
  });

  return { consent, candidateConsentStatus };
}

export async function listConsent(
  { tenantId, candidateId } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const candidate = await requireCandidate(db, tenantId, candidateId);
  const consents = await db.candidateConsent.findMany({
    where: withTenant(tenantId, { candidateId: candidate.id }),
    orderBy: { occurredAt: "desc" },
  });
  return {
    candidateId: candidate.id,
    consentStatus: candidate.consentStatus,
    consents,
  };
}

// ── Do Not Contact ───────────────────────────────────────────────────────────

const activeDncWhere = (tenantId, email, at) => ({
  ...withTenant(tenantId, { email, status: DNC_STATUS.ACTIVE }),
  OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
});

/** Read-only DNC probe. Never throws for the not-on-DNC case. */
export async function findActiveDnc(
  { tenantId, email, at = new Date() } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return db.candidateDncEntry.findFirst({
    where: activeDncWhere(tenantId, normalized, at),
    orderBy: { effectiveFrom: "desc" },
  });
}

export async function recordDnc(
  {
    tenantId,
    email,
    candidateId = null,
    reasonCode,
    reason,
    scope = "ALL",
    expiresAt = null,
    actorId = null,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const normalized = normalizeEmail(email);
  if (!normalized)
    throw privacyError(
      "A candidate email is required",
      "HR-RECRUITMENT-DNC-EMAIL-REQUIRED",
      400,
    );
  // A DNC without a recorded reason is not a compliance record.
  const resolvedReasonCode = requireText(
    reasonCode,
    "reasonCode",
    "HR-RECRUITMENT-DNC-REASON-CODE-REQUIRED",
  );
  const resolvedReason = requireText(
    reason,
    "reason",
    "HR-RECRUITMENT-DNC-REASON-REQUIRED",
  );

  if (candidateId !== null && candidateId !== undefined) {
    await requireCandidate(db, tenantId, candidateId);
  }

  const existing = await findActiveDnc({ tenantId, email: normalized }, { db });
  if (existing) {
    throw privacyError(
      `${normalized} is already on the do-not-contact register (entry ${existing.id})`,
      "HR-RECRUITMENT-DNC-EXISTS",
    );
  }

  const entry = await db.candidateDncEntry.create({
    data: {
      tenantId,
      email: normalized,
      candidateId: candidateId == null ? null : Number(candidateId),
      reasonCode: resolvedReasonCode,
      reason: resolvedReason,
      scope: scope || "ALL",
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
  });

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Create",
    module: "Candidate DNC",
    result: "SUCCESS",
    notes: `Do-not-contact recorded for ${normalized} (${resolvedReasonCode}).`,
    tenantId,
  });

  return entry;
}

export async function liftDnc(
  { tenantId, id, reason, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(
    reason,
    "reason",
    "HR-RECRUITMENT-DNC-LIFT-REASON-REQUIRED",
  );
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    throw privacyError(
      "A valid do-not-contact entry id is required",
      "HR-RECRUITMENT-DNC-ID-INVALID",
      400,
    );
  }

  const entry = await db.candidateDncEntry.findFirst({
    where: withTenant(tenantId, { id: entryId }),
  });
  if (!entry)
    throw privacyError(
      "Do-not-contact entry not found",
      "HR-RECRUITMENT-DNC-NOT-FOUND",
      404,
    );
  if (entry.status !== DNC_STATUS.ACTIVE) {
    throw privacyError(
      `Do-not-contact entry ${entryId} is already ${entry.status}`,
      "HR-RECRUITMENT-DNC-NOT-ACTIVE",
    );
  }

  const lifted = await db.candidateDncEntry.update({
    where: { id: entry.id },
    data: {
      status: DNC_STATUS.LIFTED,
      liftedAt: new Date(),
      liftedById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
      liftReason: resolvedReason,
    },
  });

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Update",
    module: "Candidate DNC",
    result: "SUCCESS",
    notes: `Do-not-contact lifted for ${entry.email}.`,
    tenantId,
  });

  return lifted;
}

export async function listDnc(
  { tenantId, status = null, email = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const where = withTenant(tenantId, {});
  if (status)
    where.status = requireEnum(
      status,
      Object.values(DNC_STATUS),
      "status",
      "HR-RECRUITMENT-DNC-STATUS-INVALID",
    );
  if (email) where.email = normalizeEmail(email);
  return db.candidateDncEntry.findMany({
    where,
    orderBy: { effectiveFrom: "desc" },
  });
}

// ── Communication gate ───────────────────────────────────────────────────────

/**
 * The single gate every candidate-facing send must pass.
 *
 * DNC is absolute: a recorded request not to be contacted blocks contact whatever
 * the consent status says. Consent withdrawal blocks PROCESSING-requiring contact
 * (screening, offers). `UNKNOWN` consent is deliberately NOT treated as withdrawn
 * — legacy rows predate consent capture, and blocking them would silently break
 * live recruiting; the plan requires explicit withdrawal to stop contact.
 */
export async function assertCommunicationsAllowed(
  {
    tenantId,
    candidateId = null,
    email = null,
    purpose = "PROCESSING",
    requireExplicitConsent = false,
    at = new Date(),
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;

  let resolvedEmail = email ? normalizeEmail(email) : null;
  let consentStatus = null;

  if (candidateId !== null && candidateId !== undefined) {
    const candidate = await requireCandidate(db, tenantId, candidateId);
    resolvedEmail = resolvedEmail ?? normalizeEmail(candidate.email);
    consentStatus = candidate.consentStatus;
    if (
      candidate.anonymizedAt ||
      candidate.archivedAt ||
      (candidate.status && candidate.status !== "active") ||
      (candidate.retentionUntil && candidate.retentionUntil <= at)
    )
      throw privacyError(
        "Candidate is inactive or the retention period has ended",
        "HR-5701",
      );
  }

  if (resolvedEmail) {
    const dnc = await findActiveDnc(
      { tenantId, email: resolvedEmail, at },
      { db },
    );
    if (dnc) {
      throw privacyError(
        `${resolvedEmail} is on the do-not-contact register (${dnc.reasonCode}) — contact is blocked`,
        "HR-RECRUITMENT-DNC-BLOCKED",
      );
    }
  }

  if (
    consentStatus === CONSENT_STATUS.WITHDRAWN &&
    CONSENT_PURPOSES.includes(String(purpose).toUpperCase())
  ) {
    throw privacyError(
      `Candidate ${candidateId} has withdrawn consent for ${String(purpose).toUpperCase()} — contact is blocked`,
      "HR-RECRUITMENT-CONSENT-WITHDRAWN",
    );
  }

  if (
    requireExplicitConsent ||
    ["TALENT_POOL", "MARKETING"].includes(String(purpose).toUpperCase())
  ) {
    const latest = candidateId
      ? await db.candidateConsent.findFirst({
          where: {
            tenantId,
            candidateId: Number(candidateId),
            purpose: String(purpose).toUpperCase(),
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        })
      : null;
    if (latest?.status !== CONSENT_STATUS.GRANTED)
      throw privacyError(
        "Explicit consent for this contact purpose is required",
        "HR-RECRUITMENT-CONSENT-REQUIRED",
      );
  }
  return { allowed: true, email: resolvedEmail, consentStatus };
}

// ── Legal hold ───────────────────────────────────────────────────────────────

export async function hasActiveLegalHold(
  { tenantId, candidateId } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const hold = await db.candidateLegalHold.findFirst({
    where: withTenant(tenantId, {
      candidateId: Number(candidateId),
      releasedAt: null,
    }),
    select: { id: true, reason: true, placedAt: true },
  });
  return hold ?? null;
}

export async function placeLegalHold(
  { tenantId, candidateId, reason, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  if (!options.db)
    return tenantTransaction(
      prisma,
      (tx) =>
        placeLegalHold({ tenantId, candidateId, reason, actorId }, { db: tx }),
      { tenantId },
    );
  await db.$executeRaw`SELECT id FROM "Candidate" WHERE id=${Number(candidateId)} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
  const resolvedReason = requireText(
    reason,
    "reason",
    "HR-RECRUITMENT-LEGAL-HOLD-REASON-REQUIRED",
  );
  const candidate = await requireCandidate(db, tenantId, candidateId);

  if (candidate.anonymizedAt)
    throw privacyError("Candidate data has already been erased", "HR-5701");
  const existing = await hasActiveLegalHold(
    { tenantId, candidateId: candidate.id },
    { db },
  );
  if (existing) {
    throw privacyError(
      `Candidate ${candidate.id} is already under legal hold (${existing.id})`,
      "HR-RECRUITMENT-LEGAL-HOLD-EXISTS",
    );
  }

  const hold = await db.candidateLegalHold.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      reason: resolvedReason,
      placedById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
  });

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Create",
    module: "Candidate Legal Hold",
    result: "SUCCESS",
    notes: `Legal hold placed on candidate ${candidate.id}.`,
    tenantId,
  });

  return hold;
}

export async function releaseLegalHold(
  { tenantId, candidateId, reason, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(
    reason,
    "reason",
    "HR-RECRUITMENT-LEGAL-HOLD-RELEASE-REASON-REQUIRED",
  );
  const candidate = await requireCandidate(db, tenantId, candidateId);

  const existing = await hasActiveLegalHold(
    { tenantId, candidateId: candidate.id },
    { db },
  );
  if (!existing) {
    throw privacyError(
      `Candidate ${candidate.id} has no active legal hold`,
      "HR-RECRUITMENT-LEGAL-HOLD-NOT-FOUND",
      404,
    );
  }

  const released = await db.candidateLegalHold.update({
    where: { id: existing.id },
    data: {
      releasedAt: new Date(),
      releasedById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
      releaseReason: resolvedReason,
    },
  });

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Update",
    module: "Candidate Legal Hold",
    result: "SUCCESS",
    notes: `Legal hold released on candidate ${candidate.id}.`,
    tenantId,
  });

  return released;
}

// ── Retention + anonymization ────────────────────────────────────────────────

export async function setRetentionPolicy(
  {
    tenantId,
    appliesTo,
    retentionMonths,
    legalBasis = null,
    actorId = null,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPopulation = requireEnum(
    appliesTo,
    RETENTION_POPULATIONS,
    "appliesTo",
    "HR-RECRUITMENT-RETENTION-POPULATION-INVALID",
  );
  const months = Number(retentionMonths);
  if (!Number.isInteger(months) || months <= 0) {
    throw privacyError(
      "retentionMonths must be a positive whole number",
      "HR-RECRUITMENT-RETENTION-MONTHS-INVALID",
      400,
    );
  }

  return db.candidateRetentionPolicy.upsert({
    where: { tenantId_appliesTo: { tenantId, appliesTo: resolvedPopulation } },
    create: {
      tenantId,
      appliesTo: resolvedPopulation,
      retentionMonths: months,
      legalBasis,
      createdById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
    update: { retentionMonths: months, legalBasis, isActive: true },
  });
}

export async function getRetentionPolicy(
  { tenantId, appliesTo } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPopulation = requireEnum(
    appliesTo,
    RETENTION_POPULATIONS,
    "appliesTo",
    "HR-RECRUITMENT-RETENTION-POPULATION-INVALID",
  );
  return db.candidateRetentionPolicy.findFirst({
    where: withTenant(tenantId, {
      appliesTo: resolvedPopulation,
      isActive: true,
    }),
  });
}

const addMonths = (date, months) => {
  const out = new Date(date);
  out.setMonth(out.getMonth() + months);
  return out;
};

/**
 * The retention deadline a candidate created now should carry. Returns null when
 * the tenant has no policy — no policy means no clock, never a guessed default.
 */
export async function computeRetentionUntil(
  { tenantId, appliesTo = "APPLICANT", from = new Date() } = {},
  options = {},
) {
  const policy = await getRetentionPolicy({ tenantId, appliesTo }, options);
  if (!policy) return null;
  return addMonths(from, policy.retentionMonths);
}

/** Candidates whose retention window has closed and who may therefore be erased. */
export async function previewRetentionDue(
  { tenantId, asOf = new Date(), limit = 100 } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const due = await db.candidate.findMany({
    where: withTenant(tenantId, {}),
    select: {
      id: true,
      email: true,
      retentionUntil: true,
      retentionPopulation: true,
      anonymizedAt: true,
    },
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 100, 500),
  });

  const cutoff = new Date(asOf);
  // FR-10 residue — ONLY the applicant clock. A TALENT_POOL clock belongs to a
  // different lawful basis (kept on file for future roles), and its population's
  // action is to leave the pool, not to be erased. NULL is a pre-existing clock,
  // stamped before the population was recorded — under the APPLICANT policy,
  // which is the only one that existed then, so it stays readable here.
  const candidates = due.filter(
    (c) =>
      c.retentionUntil &&
      new Date(c.retentionUntil) <= cutoff &&
      !c.anonymizedAt &&
      c.retentionPopulation !== "TALENT_POOL",
  );

  // A legal hold SUSPENDS retention: those rows are reported separately so an
  // operator can see why a due candidate is not being erased.
  const held = [];
  const actionable = [];
  for (const candidate of candidates) {
    const hold = await hasActiveLegalHold(
      { tenantId, candidateId: candidate.id },
      { db },
    );
    if (hold) held.push({ ...candidate, legalHoldId: hold.id });
    else actionable.push(candidate);
  }

  return { asOf: cutoff, due: actionable, suspendedByLegalHold: held };
}

const REDACTED_FIELD_NAMES = Object.freeze([
  "interviewSlotOffers",
  "interviewStaffNotices",
  "firstName",
  "lastName",
  "email",
  "phone",
  "resumeUrl",
  "resumeMediaId",
  "notes",
  "parsedResume",
]);

/**
 * Irreversibly remove a candidate's PII while preserving aggregate facts.
 *
 * Refuses while a legal hold is active (the hold exists precisely to stop this).
 * Idempotent: an already-anonymized candidate is reported, not re-processed.
 */
export async function anonymizeCandidate(
  {
    tenantId,
    candidateId,
    reason,
    legalBasis = null,
    actorId = null,
    at = new Date(),
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  if (!options.db)
    return tenantTransaction(
      prisma,
      (tx) =>
        anonymizeCandidate(
          { tenantId, candidateId, reason, legalBasis, actorId, at },
          { db: tx },
        ),
      { tenantId },
    );
  await db.$queryRaw`SELECT id FROM "Candidate" WHERE id=${Number(candidateId)} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
  const resolvedReason = requireText(
    reason,
    "reason",
    "HR-RECRUITMENT-ANONYMIZE-REASON-REQUIRED",
  );
  const candidate = await requireCandidate(db, tenantId, candidateId);

  if (candidate.anonymizedAt) {
    return {
      candidateId: candidate.id,
      alreadyAnonymized: true,
      anonymizedAt: candidate.anonymizedAt,
    };
  }

  const hold = await hasActiveLegalHold(
    { tenantId, candidateId: candidate.id },
    { db },
  );
  if (hold) {
    throw privacyError(
      `Candidate ${candidate.id} is under legal hold (${hold.id}) — data cannot be anonymized`,
      "HR-RECRUITMENT-LEGAL-HOLD-BLOCKS-ANONYMIZATION",
    );
  }

  // Persist deletion work with the database redaction. DAM is called only after commit.
  const ownedMedia = await collectCandidateMedia(db, tenantId, candidate);
  const uploadedHashes = await db.candidateDocumentUpload.findMany({
    where: { tenantId, candidateId: candidate.id },
    select: { id: true, contentHash: true },
  });
  const damCleanup = {
    state: ownedMedia.length ? "PENDING" : "COMPLETE",
    requested: ownedMedia,
    deleted: [],
    skipped: [],
    failed: [],
    attempts: 0,
  };

  // Aggregate facts survive erasure: pipeline history stays reportable without PII.
  const applications = await db.application.findMany({
    where: withTenant(tenantId, { candidateId: candidate.id }),
    select: { id: true, stage: true, status: true },
  });
  const retainedSummary = {
    applications: applications.length,
    stages: applications.reduce((acc, row) => {
      const key = row.stage || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    anonymizedAt: at.toISOString(),
  };

  // Email must stay unique per tenant (@@unique([tenantId, email])), so the
  // tombstone is derived from the id rather than left as the real address.
  await db.candidate.updateMany({
    where: withTenant(tenantId, { id: candidate.id }),
    data: {
      firstName: "Anonymized",
      lastName: null,
      email: `anon-${candidate.id}@anonymized.invalid`,
      phone: null,
      resumeUrl: null,
      resumeMediaId: null,
      notes: null,
      parsedResume: null,
      location: null,
      source: null,
      parseError: null,
      parseStatus: null,
      parsedAt: null,
      consentStatus: CONSENT_STATUS.WITHDRAWN,
      consentUpdatedAt: at,
      anonymizedAt: at,
    },
  });

  await db.candidateCommunication.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: {
      status: "CANCELLED",
      encryptedPayload: null,
      context: { hubCleanup: "PENDING" },
      leaseToken: null,
      leaseUntil: null,
      lastError: "Candidate data erased",
    },
  });
  const applicationIds = applications.map((a) => a.id);
  await db.$executeRawUnsafe(
    'DELETE FROM "InterviewStaffNotice" WHERE "tenantId"=$1::uuid AND "interviewId" IN (SELECT id FROM interviews WHERE "tenantId"=$1::uuid AND "applicationId"=ANY($2::int[]))',
    tenantId,
    applicationIds,
  );
  await db.$executeRawUnsafe(
    'DELETE FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid AND "applicationId"=ANY($2::int[])',
    tenantId,
    applicationIds,
  );
  await db.applicationScore.deleteMany({
    where: { tenantId, applicationId: { in: applicationIds } },
  });
  const interviews = await db.interview.findMany({
    where: { tenantId, applicationId: { in: applicationIds } },
    select: { id: true },
  });
  const interviewIds = interviews.map((i) => i.id);
  // Database erasure is atomic; a failed child write rolls back the tombstone.
  const sessions = await db.candidateTestSession.findMany({
    where: { tenantId, candidateId: candidate.id },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);
  await db.candidateTestResponse.deleteMany({
    where: { tenantId, sessionId: { in: sessionIds } },
  });
  await db.candidateTestIntegrityEvent.deleteMany({
    where: { tenantId, sessionId: { in: sessionIds } },
  });
  await db.interview.updateMany({
    where: { tenantId, applicationId: { in: applicationIds } },
    data: { assessmentResultId: null },
  });
  await db.candidateTestResult.deleteMany({
    where: { tenantId, sessionId: { in: sessionIds } },
  });
  await db.candidateTestSession.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.candidateCheckIn.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.interviewPacketItem.deleteMany({
    where: { tenantId, interviewId: { in: interviewIds } },
  });
  await db.interviewLifecycleEvent.updateMany({
    where: { tenantId, interviewId: { in: interviewIds } },
    data: { notes: null },
  });
  await db.applicationStageHistory.updateMany({
    where: { tenantId, applicationId: { in: applicationIds } },
    data: { reason: "Redacted under candidate erasure" },
  });
  await db.application.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: { dispositionReason: null, holdReason: null, withdrawnReason: null },
  });
  await db.candidateResumeParseJob.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.candidateDocumentUpload.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: { status: "DELETE_PENDING", lastError: null },
  });
  await db.candidateEvaluationSummary.deleteMany({
    where: { tenantId, applicationId: { in: applicationIds } },
  });
  await db.candidateSkill.deleteMany({ where: { candidateId: candidate.id } });
  await db.candidateTag.deleteMany({ where: { candidateId: candidate.id } });
  await db.applicationDraft.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.candidateEmailVerification.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.aiInferenceRecord.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.talentPoolInvitation.deleteMany({
    where: { tenantId, candidateId: candidate.id },
  });
  await db.talentPool.deleteMany({
    where: { candidateId: candidate.id, tenantId },
  });
  await db.applicationAnswer.deleteMany({
    where: { applicationId: { in: applicationIds } },
  });
  await db.applicationScreening.updateMany({
    where: { tenantId, applicationId: { in: applicationIds } },
    data: { notes: null, criteria: null },
  });
  await db.interviewScorecard.updateMany({
    where: { tenantId, interviewId: { in: interviewIds } },
    data: {
      notes: null,
      scores: {},
      amendmentLog: null,
      criterionScores: [],
      reviewFlags: [],
    },
  });
  await db.interview.updateMany({
    where: { tenantId, id: { in: interviewIds } },
    data: { notes: null },
  });
  await db.offer.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: {
      notes: null,
      offerLetterMediaId: null,
      terms: null,
      approvals: null,
    },
  });
  await db.candidateConsent.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: { evidence: null },
  });
  await db.candidateDataAccessRequest.updateMany({
    where: { tenantId, candidateId: candidate.id },
    data: {
      subjectEmail: "anon-" + candidate.id + "@anonymized.invalid",
      exportManifest: null,
      notes: null,
      rejectionReason: null,
    },
  });
  await db.resumeParseAttempt.deleteMany({
    where: {
      tenantId,
      OR: [
        {
          mediaId: { in: ownedMedia.map(Number).filter(Number.isSafeInteger) },
        },
        { contentHash: { in: uploadedHashes.map((row) => row.contentHash) } },
      ],
    },
  });

  for (const upload of uploadedHashes)
    await db.candidateDocumentUpload.update({
      where: { id: upload.id },
      data: { contentHash: randomBytes(32).toString("hex") },
    });

  const log = await db.candidateAnonymizationLog.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      redactedFields: REDACTED_FIELD_NAMES,
      reason: resolvedReason,
      legalBasis,
      retainedSummary,
      damCleanup,
      performedById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
      performedAt: at,
    },
  });

  await logAction({
    employeeId:
      Number.isInteger(Number(actorId)) && Number(actorId) > 0
        ? Number(actorId)
        : null,
    type: "Update",
    module: "Candidate Privacy",
    result: "SUCCESS",
    notes: `Candidate ${candidate.id} anonymized (retention/erasure).`,
    tenantId,
  });

  return {
    candidateId: candidate.id,
    alreadyAnonymized: false,
    redactedFields: REDACTED_FIELD_NAMES,
    retainedSummary,
    // Reported so the caller sees a partial erasure immediately rather than
    // discovering it in the log during an audit.
    damCleanup,
    log,
  };
}

// ── Archive behaviour (Phase 10 remainder) ───────────────────────────────────
//
// `Candidate.archivedAt` existed with nothing that ever set it, so "archived" was
// a state no record could reach. Archiving is NOT erasure and NOT anonymization:
// the data stays, exactly as it is, and the candidate simply stops appearing as
// live pipeline work. That is the step between "still being considered" and "their
// retention window has closed and they may be erased".
//
// A candidate is archivable when they have NO application in a live stage — every
// application has reached hired/rejected/withdrawn — and their most recent
// activity is older than the cutoff. The activity date is the newest application
// update, falling back to the candidate row's own updatedAt; a candidate with no
// applications at all is judged on the row itself.
//
// Only `archivedAt` is written. `Candidate.status` ("active"|"archived") is left
// alone on purpose: other queries already read it, and silently redefining an
// existing column's meaning would hide records from views that never asked to
// hide them.
const LIVE_APPLICATION_STAGES = Object.freeze([
  "applied",
  "screening",
  "interview",
  "offer",
]);

export async function archiveInactiveCandidates(
  {
    tenantId,
    asOf = new Date(),
    inactiveMonths = 12,
    dryRun = true,
    limit = 200,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const months = Number(inactiveMonths);
  if (!Number.isInteger(months) || months <= 0) {
    throw privacyError(
      "inactiveMonths must be a positive whole number",
      "HR-RECRUITMENT-ARCHIVE-MONTHS-INVALID",
      400,
    );
  }
  const cutoff = addMonths(new Date(asOf), -months);

  const candidates = await db.candidate.findMany({
    // Already-archived and already-anonymized rows are out of scope: the first is
    // idempotent work, the second is a tombstone.
    where: withTenant(tenantId, { archivedAt: null, anonymizedAt: null }),
    select: {
      id: true,
      updatedAt: true,
      applications: { select: { stage: true, updatedAt: true } },
    },
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 200, 500),
  });

  const archivable = candidates
    .filter((candidate) => {
      const applications = candidate.applications || [];
      const live = applications.some((app) =>
        LIVE_APPLICATION_STAGES.includes(String(app.stage || "").toLowerCase()),
      );
      if (live) return false;
      const lastActivity = applications.reduce(
        (latest, app) =>
          app.updatedAt && (!latest || app.updatedAt > latest)
            ? app.updatedAt
            : latest,
        candidate.updatedAt || null,
      );
      return lastActivity != null && new Date(lastActivity) <= cutoff;
    })
    .map((candidate) => candidate.id);

  if (dryRun) {
    return {
      dryRun: true,
      asOf: new Date(asOf),
      inactiveMonths: months,
      cutoff,
      wouldArchive: archivable,
    };
  }

  if (archivable.length) {
    await db.candidate.updateMany({
      where: withTenant(tenantId, { id: { in: archivable } }),
      data: { archivedAt: new Date(asOf) },
    });
  }

  return {
    dryRun: false,
    asOf: new Date(asOf),
    inactiveMonths: months,
    cutoff,
    archived: archivable,
  };
}

/**
 * Apply retention. Defaults to a DRY RUN: erasure is irreversible, so the
 * destructive path has to be asked for explicitly.
 */
export async function applyRetention(
  {
    tenantId,
    asOf = new Date(),
    actorId = null,
    dryRun = true,
    limit = 100,
  } = {},
  options = {},
) {
  const preview = await previewRetentionDue({ tenantId, asOf, limit }, options);
  if (dryRun) {
    recordRetentionRun("dry-run");
    return {
      dryRun: true,
      asOf: preview.asOf,
      wouldAnonymize: preview.due.map((c) => c.id),
      suspendedByLegalHold: preview.suspendedByLegalHold,
    };
  }
  // Phase 15 — APPLY mode is flag-gated (HR_RECRUITMENT_RETENTION_AUTOMATION).
  // DRY-RUN is always available regardless of the flag; this gate only stops
  // the destructive path, mirroring §8's "dry-run until the policy owner
  // approves, then tenant by tenant". Off → the caller gets the dry-run
  // result with a flag-disabled marker instead of an error.
  if (!isRecruitmentFlagEnabled("retention")) {
    recordRetentionRun("refused-flag");
    return {
      dryRun: true,
      refused: true,
      reason: "flag-disabled",
      asOf: preview.asOf,
      wouldAnonymize: preview.due.map((c) => c.id),
      suspendedByLegalHold: preview.suspendedByLegalHold,
    };
  }

  const anonymized = [];
  for (const candidate of preview.due) {
    const result = await anonymizeCandidate(
      {
        tenantId,
        candidateId: candidate.id,
        reason: "Retention policy expiry",
        actorId,
        at: new Date(asOf),
      },
      options,
    );
    anonymized.push(result.candidateId);
  }
  recordRetentionRun("applied");
  return {
    dryRun: false,
    asOf: preview.asOf,
    anonymized,
    suspendedByLegalHold: preview.suspendedByLegalHold,
  };
}

// ── Data-subject requests ────────────────────────────────────────────────────
const auditDataRequest = (db, { tenantId, actorId, id, action }) =>
  db.log.create({
    data: {
      tenantId,
      employeeId: actorId || null,
      actionById: actorId || null,
      type: "Update",
      action_type: action,
      module: "Candidate Privacy",
      result: "SUCCESS",
      ip: "unknown",
      os: "server",
      notes: "Data subject request " + id,
      correlationId: currentCorrelationId() ?? null,
    },
  });

export async function recordDataAccessRequest(
  {
    tenantId,
    subjectEmail,
    type,
    candidateId = null,
    dueAt = null,
    notes = null,
    actorId = null,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  if (!options.db)
    return tenantTransaction(
      prisma,
      (db) =>
        recordDataAccessRequest(
          { tenantId, subjectEmail, type, candidateId, dueAt, notes, actorId },
          { db },
        ),
      { tenantId },
    );
  const db = options.db;
  const normalized = normalizeEmail(subjectEmail);
  if (!normalized)
    throw privacyError(
      "The data subject's email is required",
      "HR-RECRUITMENT-DAR-EMAIL-REQUIRED",
      400,
    );
  const resolvedType = requireEnum(
    type,
    REQUEST_TYPES,
    "type",
    "HR-RECRUITMENT-DAR-TYPE-INVALID",
  );

  if (candidateId !== null && candidateId !== undefined) {
    await db.$queryRawUnsafe(
      'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
      Number(candidateId),
      tenantId,
    );
    const linked = await requireCandidate(db, tenantId, candidateId);
    if (normalizeEmail(linked.email) !== normalized)
      throw privacyError(
        "The request email does not match the linked candidate",
        "HR-5702",
        400,
      );
  }

  const receivedAt = new Date();
  const due = dueAt
    ? new Date(dueAt)
    : new Date(
        receivedAt.getTime() + DEFAULT_REQUEST_SLA_DAYS * 24 * 60 * 60 * 1000,
      );

  if (Number.isNaN(due.getTime()))
    throw privacyError("Choose a valid due date", "HR-5702", 400);
  const created = await db.candidateDataAccessRequest.create({
    data: {
      tenantId,
      candidateId: candidateId == null ? null : Number(candidateId),
      subjectEmail: normalized,
      type: resolvedType,
      dueAt: due,
      notes,
      handledById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
  });
  await auditDataRequest(db, {
    tenantId,
    actorId: created.handledById,
    id: created.id,
    action: "CANDIDATE_REQUEST_RECORDED",
  });
  return created;
}

export async function closeDataAccessRequest(
  {
    tenantId,
    id,
    status,
    notes = null,
    rejectionReason = null,
    actorId = null,
  } = {},
  options = {},
) {
  requireTenant(tenantId);
  if (!options.db)
    return tenantTransaction(
      prisma,
      (db) =>
        closeDataAccessRequest(
          { tenantId, id, status, notes, rejectionReason, actorId },
          { db },
        ),
      { tenantId },
    );
  const db = options.db;
  const resolvedStatus = requireEnum(
    status,
    CLOSED_REQUEST_STATUSES,
    "status",
    "HR-RECRUITMENT-DAR-STATUS-INVALID",
  );
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw privacyError(
      "A valid request id is required",
      "HR-RECRUITMENT-DAR-ID-INVALID",
      400,
    );
  }
  if (resolvedStatus === REQUEST_STATUS.REJECTED) {
    requireText(
      rejectionReason,
      "rejectionReason",
      "HR-RECRUITMENT-DAR-REJECTION-REASON-REQUIRED",
    );
  }

  await db.$queryRawUnsafe(
    'SELECT id FROM candidate_data_access_requests WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    requestId,
    tenantId,
  );
  const existing = await db.candidateDataAccessRequest.findFirst({
    where: withTenant(tenantId, { id: requestId }),
  });
  if (!existing)
    throw privacyError(
      "Data access request not found",
      "HR-RECRUITMENT-DAR-NOT-FOUND",
      404,
    );
  if (CLOSED_REQUEST_STATUSES.includes(existing.status)) {
    throw privacyError(
      `Request ${requestId} is already ${existing.status}`,
      "HR-RECRUITMENT-DAR-ALREADY-CLOSED",
    );
  }

  if (
    resolvedStatus === "FULFILLED" &&
    existing.type === "ACCESS" &&
    !existing.exportManifest
  )
    throw privacyError(
      "Generate and review the access export before fulfilment",
      "HR-5702",
    );
  const closed = await db.candidateDataAccessRequest.update({
    where: { id: existing.id },
    data: {
      status: resolvedStatus,
      closedAt: new Date(),
      notes: notes ?? existing.notes,
      rejectionReason,
      handledById:
        Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? Number(actorId)
          : null,
    },
  });
  await auditDataRequest(db, {
    tenantId,
    actorId: closed.handledById,
    id: closed.id,
    action: "CANDIDATE_REQUEST_" + closed.status,
  });
  return closed;
}

export async function listDataAccessRequests(
  { tenantId, status = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const where = withTenant(tenantId, {});
  if (status) {
    where.status = requireEnum(
      status,
      Object.values(REQUEST_STATUS),
      "status",
      "HR-RECRUITMENT-DAR-STATUS-INVALID",
    );
  }
  return db.candidateDataAccessRequest.findMany({
    where,
    orderBy: { receivedAt: "desc" },
  });
}
