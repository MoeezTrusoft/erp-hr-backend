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
import { logAction } from "../utils/logs.js";

export const DNC_STATUS = Object.freeze({ ACTIVE: "ACTIVE", LIFTED: "LIFTED" });
export const CONSENT_STATUS = Object.freeze({ UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", WITHDRAWN: "WITHDRAWN" });
export const CONSENT_PURPOSES = Object.freeze(["PROCESSING", "TALENT_POOL", "MARKETING"]);
export const RETENTION_POPULATIONS = Object.freeze(["APPLICANT", "TALENT_POOL"]);
export const REQUEST_TYPES = Object.freeze(["ACCESS", "CORRECTION", "ERASURE"]);
export const REQUEST_STATUS = Object.freeze({
  RECEIVED: "RECEIVED",
  IN_PROGRESS: "IN_PROGRESS",
  FULFILLED: "FULFILLED",
  REJECTED: "REJECTED",
});
const CLOSED_REQUEST_STATUSES = Object.freeze([REQUEST_STATUS.FULFILLED, REQUEST_STATUS.REJECTED]);

// Statutory response window when a request is recorded. 30 days is the common
// baseline (GDPR Art.12(3)); a tenant can still pass an explicit dueAt.
const DEFAULT_REQUEST_SLA_DAYS = 30;

const privacyError = (message, code, status = 409) =>
  Object.assign(new Error(message), { status, code });

export const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
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
    throw privacyError(`${field} must be one of ${allowed.join(", ")} (received "${text}")`, code, 400);
  }
  return text;
};

const requireCandidate = async (db, tenantId, candidateId) => {
  const id = Number(candidateId);
  if (!Number.isInteger(id) || id <= 0) {
    throw privacyError("A valid candidate id is required", "HR-RECRUITMENT-CANDIDATE-REQUIRED", 400);
  }
  const candidate = await db.candidate.findFirst({
    where: withTenant(tenantId, { id }),
    select: { id: true, email: true, consentStatus: true, anonymizedAt: true },
  });
  if (!candidate) throw privacyError("Candidate not found", "HR-RECRUITMENT-CANDIDATE-NOT-FOUND", 404);
  return candidate;
};

// ── Consent ──────────────────────────────────────────────────────────────────

/**
 * Append a consent decision. `PROCESSING` additionally mirrors the aggregate
 * status onto Candidate.consentStatus so screening/portal queries can filter
 * cheaply; the history row remains the evidence of record.
 */
export async function recordConsent(
  { tenantId, candidateId, purpose, status, policyVersion = null, source = null, evidence = null, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPurpose = requireEnum(purpose, CONSENT_PURPOSES, "purpose", "HR-RECRUITMENT-CONSENT-PURPOSE-INVALID");
  const resolvedStatus = requireEnum(
    status,
    [CONSENT_STATUS.GRANTED, CONSENT_STATUS.WITHDRAWN],
    "status",
    "HR-RECRUITMENT-CONSENT-STATUS-INVALID",
  );
  const candidate = await requireCandidate(db, tenantId, candidateId);

  const consent = await db.candidateConsent.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      purpose: resolvedPurpose,
      status: resolvedStatus,
      policyVersion,
      source,
      evidence,
      recordedById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
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
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    type: "Update",
    module: "Candidate Consent",
    result: "SUCCESS",
    notes: `Consent ${resolvedStatus} for candidate ${candidate.id} (${resolvedPurpose}).`,
    tenantId,
  });

  return { consent, candidateConsentStatus };
}

export async function listConsent({ tenantId, candidateId } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const candidate = await requireCandidate(db, tenantId, candidateId);
  const consents = await db.candidateConsent.findMany({
    where: withTenant(tenantId, { candidateId: candidate.id }),
    orderBy: { occurredAt: "desc" },
  });
  return { candidateId: candidate.id, consentStatus: candidate.consentStatus, consents };
}

// ── Do Not Contact ───────────────────────────────────────────────────────────

const activeDncWhere = (tenantId, email, at) => ({
  ...withTenant(tenantId, { email, status: DNC_STATUS.ACTIVE }),
  OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
});

/** Read-only DNC probe. Never throws for the not-on-DNC case. */
export async function findActiveDnc({ tenantId, email, at = new Date() } = {}, options = {}) {
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
  { tenantId, email, candidateId = null, reasonCode, reason, scope = "ALL", expiresAt = null, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const normalized = normalizeEmail(email);
  if (!normalized) throw privacyError("A candidate email is required", "HR-RECRUITMENT-DNC-EMAIL-REQUIRED", 400);
  // A DNC without a recorded reason is not a compliance record.
  const resolvedReasonCode = requireText(reasonCode, "reasonCode", "HR-RECRUITMENT-DNC-REASON-CODE-REQUIRED");
  const resolvedReason = requireText(reason, "reason", "HR-RECRUITMENT-DNC-REASON-REQUIRED");

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
      createdById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    },
  });

  await logAction({
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    type: "Create",
    module: "Candidate DNC",
    result: "SUCCESS",
    notes: `Do-not-contact recorded for ${normalized} (${resolvedReasonCode}).`,
    tenantId,
  });

  return entry;
}

export async function liftDnc({ tenantId, id, reason, actorId = null } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(reason, "reason", "HR-RECRUITMENT-DNC-LIFT-REASON-REQUIRED");
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    throw privacyError("A valid do-not-contact entry id is required", "HR-RECRUITMENT-DNC-ID-INVALID", 400);
  }

  const entry = await db.candidateDncEntry.findFirst({ where: withTenant(tenantId, { id: entryId }) });
  if (!entry) throw privacyError("Do-not-contact entry not found", "HR-RECRUITMENT-DNC-NOT-FOUND", 404);
  if (entry.status !== DNC_STATUS.ACTIVE) {
    throw privacyError(`Do-not-contact entry ${entryId} is already ${entry.status}`, "HR-RECRUITMENT-DNC-NOT-ACTIVE");
  }

  const lifted = await db.candidateDncEntry.update({
    where: { id: entry.id },
    data: {
      status: DNC_STATUS.LIFTED,
      liftedAt: new Date(),
      liftedById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
      liftReason: resolvedReason,
    },
  });

  await logAction({
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    type: "Update",
    module: "Candidate DNC",
    result: "SUCCESS",
    notes: `Do-not-contact lifted for ${entry.email}.`,
    tenantId,
  });

  return lifted;
}

export async function listDnc({ tenantId, status = null, email = null } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const where = withTenant(tenantId, {});
  if (status) where.status = requireEnum(status, Object.values(DNC_STATUS), "status", "HR-RECRUITMENT-DNC-STATUS-INVALID");
  if (email) where.email = normalizeEmail(email);
  return db.candidateDncEntry.findMany({ where, orderBy: { effectiveFrom: "desc" } });
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
  { tenantId, candidateId = null, email = null, purpose = "PROCESSING", at = new Date() } = {},
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
  }

  if (resolvedEmail) {
    const dnc = await findActiveDnc({ tenantId, email: resolvedEmail, at }, { db });
    if (dnc) {
      throw privacyError(
        `${resolvedEmail} is on the do-not-contact register (${dnc.reasonCode}) — contact is blocked`,
        "HR-RECRUITMENT-DNC-BLOCKED",
      );
    }
  }

  if (consentStatus === CONSENT_STATUS.WITHDRAWN && CONSENT_PURPOSES.includes(String(purpose).toUpperCase())) {
    throw privacyError(
      `Candidate ${candidateId} has withdrawn consent for ${String(purpose).toUpperCase()} — contact is blocked`,
      "HR-RECRUITMENT-CONSENT-WITHDRAWN",
    );
  }

  return { allowed: true, email: resolvedEmail, consentStatus };
}

// ── Legal hold ───────────────────────────────────────────────────────────────

export async function hasActiveLegalHold({ tenantId, candidateId } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const hold = await db.candidateLegalHold.findFirst({
    where: withTenant(tenantId, { candidateId: Number(candidateId), releasedAt: null }),
    select: { id: true, reason: true, placedAt: true },
  });
  return hold ?? null;
}

export async function placeLegalHold({ tenantId, candidateId, reason, actorId = null } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(reason, "reason", "HR-RECRUITMENT-LEGAL-HOLD-REASON-REQUIRED");
  const candidate = await requireCandidate(db, tenantId, candidateId);

  const existing = await hasActiveLegalHold({ tenantId, candidateId: candidate.id }, { db });
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
      placedById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    },
  });

  await logAction({
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    type: "Create",
    module: "Candidate Legal Hold",
    result: "SUCCESS",
    notes: `Legal hold placed on candidate ${candidate.id}.`,
    tenantId,
  });

  return hold;
}

export async function releaseLegalHold({ tenantId, candidateId, reason, actorId = null } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(reason, "reason", "HR-RECRUITMENT-LEGAL-HOLD-RELEASE-REASON-REQUIRED");
  const candidate = await requireCandidate(db, tenantId, candidateId);

  const existing = await hasActiveLegalHold({ tenantId, candidateId: candidate.id }, { db });
  if (!existing) {
    throw privacyError(`Candidate ${candidate.id} has no active legal hold`, "HR-RECRUITMENT-LEGAL-HOLD-NOT-FOUND", 404);
  }

  const released = await db.candidateLegalHold.update({
    where: { id: existing.id },
    data: {
      releasedAt: new Date(),
      releasedById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
      releaseReason: resolvedReason,
    },
  });

  await logAction({
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
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
  { tenantId, appliesTo, retentionMonths, legalBasis = null, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPopulation = requireEnum(appliesTo, RETENTION_POPULATIONS, "appliesTo", "HR-RECRUITMENT-RETENTION-POPULATION-INVALID");
  const months = Number(retentionMonths);
  if (!Number.isInteger(months) || months <= 0) {
    throw privacyError("retentionMonths must be a positive whole number", "HR-RECRUITMENT-RETENTION-MONTHS-INVALID", 400);
  }

  return db.candidateRetentionPolicy.upsert({
    where: { tenantId_appliesTo: { tenantId, appliesTo: resolvedPopulation } },
    create: {
      tenantId,
      appliesTo: resolvedPopulation,
      retentionMonths: months,
      legalBasis,
      createdById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    },
    update: { retentionMonths: months, legalBasis, isActive: true },
  });
}

export async function getRetentionPolicy({ tenantId, appliesTo } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedPopulation = requireEnum(appliesTo, RETENTION_POPULATIONS, "appliesTo", "HR-RECRUITMENT-RETENTION-POPULATION-INVALID");
  return db.candidateRetentionPolicy.findFirst({
    where: withTenant(tenantId, { appliesTo: resolvedPopulation, isActive: true }),
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
export async function previewRetentionDue({ tenantId, asOf = new Date(), limit = 100 } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const due = await db.candidate.findMany({
    where: withTenant(tenantId, {}),
    select: { id: true, email: true, retentionUntil: true, anonymizedAt: true },
    orderBy: { id: "asc" },
    take: Math.min(Number(limit) || 100, 500),
  });

  const cutoff = new Date(asOf);
  const candidates = due.filter(
    (c) => c.retentionUntil && new Date(c.retentionUntil) <= cutoff && !c.anonymizedAt,
  );

  // A legal hold SUSPENDS retention: those rows are reported separately so an
  // operator can see why a due candidate is not being erased.
  const held = [];
  const actionable = [];
  for (const candidate of candidates) {
    const hold = await hasActiveLegalHold({ tenantId, candidateId: candidate.id }, { db });
    if (hold) held.push({ ...candidate, legalHoldId: hold.id });
    else actionable.push(candidate);
  }

  return { asOf: cutoff, due: actionable, suspendedByLegalHold: held };
}

const REDACTED_FIELD_NAMES = Object.freeze([
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
  { tenantId, candidateId, reason, legalBasis = null, actorId = null, at = new Date() } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedReason = requireText(reason, "reason", "HR-RECRUITMENT-ANONYMIZE-REASON-REQUIRED");
  const candidate = await requireCandidate(db, tenantId, candidateId);

  if (candidate.anonymizedAt) {
    return { candidateId: candidate.id, alreadyAnonymized: true, anonymizedAt: candidate.anonymizedAt };
  }

  const hold = await hasActiveLegalHold({ tenantId, candidateId: candidate.id }, { db });
  if (hold) {
    throw privacyError(
      `Candidate ${candidate.id} is under legal hold (${hold.id}) — data cannot be anonymized`,
      "HR-RECRUITMENT-LEGAL-HOLD-BLOCKS-ANONYMIZATION",
    );
  }

  // Aggregate facts survive erasure: pipeline history stays reportable without PII.
  const applications = await db.application.findMany({
    where: withTenant(tenantId, { candidateId: candidate.id }),
    select: { stage: true, status: true },
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
      consentStatus: CONSENT_STATUS.WITHDRAWN,
      consentUpdatedAt: at,
      anonymizedAt: at,
    },
  });

  const log = await db.candidateAnonymizationLog.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      redactedFields: REDACTED_FIELD_NAMES,
      reason: resolvedReason,
      legalBasis,
      retainedSummary,
      performedById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
      performedAt: at,
    },
  });

  await logAction({
    employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    type: "Update",
    module: "Candidate Privacy",
    result: "SUCCESS",
    notes: `Candidate ${candidate.id} anonymized (retention/erasure).`,
    tenantId,
  });

  return { candidateId: candidate.id, alreadyAnonymized: false, redactedFields: REDACTED_FIELD_NAMES, retainedSummary, log };
}

/**
 * Apply retention. Defaults to a DRY RUN: erasure is irreversible, so the
 * destructive path has to be asked for explicitly.
 */
export async function applyRetention({ tenantId, asOf = new Date(), actorId = null, dryRun = true, limit = 100 } = {}, options = {}) {
  const preview = await previewRetentionDue({ tenantId, asOf, limit }, options);
  if (dryRun) {
    return { dryRun: true, asOf: preview.asOf, wouldAnonymize: preview.due.map((c) => c.id), suspendedByLegalHold: preview.suspendedByLegalHold };
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
  return { dryRun: false, asOf: preview.asOf, anonymized, suspendedByLegalHold: preview.suspendedByLegalHold };
}

// ── Data-subject requests ────────────────────────────────────────────────────

export async function recordDataAccessRequest(
  { tenantId, subjectEmail, type, candidateId = null, dueAt = null, notes = null, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const normalized = normalizeEmail(subjectEmail);
  if (!normalized) throw privacyError("The data subject's email is required", "HR-RECRUITMENT-DAR-EMAIL-REQUIRED", 400);
  const resolvedType = requireEnum(type, REQUEST_TYPES, "type", "HR-RECRUITMENT-DAR-TYPE-INVALID");

  if (candidateId !== null && candidateId !== undefined) {
    await requireCandidate(db, tenantId, candidateId);
  }

  const receivedAt = new Date();
  const due = dueAt ? new Date(dueAt) : new Date(receivedAt.getTime() + DEFAULT_REQUEST_SLA_DAYS * 24 * 60 * 60 * 1000);

  return db.candidateDataAccessRequest.create({
    data: {
      tenantId,
      candidateId: candidateId == null ? null : Number(candidateId),
      subjectEmail: normalized,
      type: resolvedType,
      dueAt: due,
      notes,
      handledById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    },
  });
}

export async function closeDataAccessRequest(
  { tenantId, id, status, notes = null, rejectionReason = null, actorId = null } = {},
  options = {},
) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const resolvedStatus = requireEnum(
    status,
    CLOSED_REQUEST_STATUSES,
    "status",
    "HR-RECRUITMENT-DAR-STATUS-INVALID",
  );
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw privacyError("A valid request id is required", "HR-RECRUITMENT-DAR-ID-INVALID", 400);
  }
  if (resolvedStatus === REQUEST_STATUS.REJECTED) {
    requireText(rejectionReason, "rejectionReason", "HR-RECRUITMENT-DAR-REJECTION-REASON-REQUIRED");
  }

  const existing = await db.candidateDataAccessRequest.findFirst({
    where: withTenant(tenantId, { id: requestId }),
  });
  if (!existing) throw privacyError("Data access request not found", "HR-RECRUITMENT-DAR-NOT-FOUND", 404);
  if (CLOSED_REQUEST_STATUSES.includes(existing.status)) {
    throw privacyError(`Request ${requestId} is already ${existing.status}`, "HR-RECRUITMENT-DAR-ALREADY-CLOSED");
  }

  return db.candidateDataAccessRequest.update({
    where: { id: existing.id },
    data: {
      status: resolvedStatus,
      closedAt: new Date(),
      notes: notes ?? existing.notes,
      rejectionReason,
      handledById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    },
  });
}

export async function listDataAccessRequests({ tenantId, status = null } = {}, options = {}) {
  requireTenant(tenantId);
  const db = options.db ?? prisma;
  const where = withTenant(tenantId, {});
  if (status) {
    where.status = requireEnum(status, Object.values(REQUEST_STATUS), "status", "HR-RECRUITMENT-DAR-STATUS-INVALID");
  }
  return db.candidateDataAccessRequest.findMany({ where, orderBy: { receivedAt: "desc" } });
}
