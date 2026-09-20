// tests/unit/candidatePrivacy.service.test.js
//
// Phase 2.5 / 10 — candidate privacy rules.
//
// The behaviours worth defending, and why they are not obvious:
//   * DNC is keyed by NORMALIZED EMAIL and outranks consent — a person who asked
//     not to be contacted must not be contactable just because a later import
//     created a fresh candidate row with the same address.
//   * Consent history is append-only; only the PROCESSING decision is mirrored
//     onto the candidate row.
//   * Anonymization is irreversible, so a legal hold must block it and a repeat
//     call must REPLAY rather than re-redact.
//   * Retention has no default: no policy means no clock, and erasure is a dry run
//     unless explicitly asked for.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = {
  candidate: { findFirst: jest.fn(), updateMany: jest.fn() },
  candidateConsent: { create: jest.fn(), findMany: jest.fn() },
  candidateDncEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  candidateLegalHold: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  candidateAnonymizationLog: { create: jest.fn() },
  candidateDataAccessRequest: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  candidateRetentionPolicy: { findFirst: jest.fn(), upsert: jest.fn() },
  application: { findMany: jest.fn() },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
const logAction = jest.fn();
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));

const privacy = await import("../../src/services/candidatePrivacy.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = { id: 7, email: "Ayesha@Example.com", consentStatus: "GRANTED", anonymizedAt: null };
const ACTOR = 42;

beforeEach(() => {
  jest.clearAllMocks();
  db.candidate.findFirst.mockResolvedValue({ ...CANDIDATE });
  db.candidateConsent.create.mockResolvedValue({ id: 1 });
  db.candidateConsent.findMany.mockResolvedValue([]);
  db.candidateDncEntry.findFirst.mockResolvedValue(null);
  db.candidateDncEntry.create.mockResolvedValue({ id: 3, email: "ayesha@example.com", status: "ACTIVE" });
  db.candidateDncEntry.update.mockResolvedValue({ id: 3, status: "LIFTED" });
  db.candidateDncEntry.findMany.mockResolvedValue([]);
  db.candidateLegalHold.findFirst.mockResolvedValue(null);
  db.candidateLegalHold.create.mockResolvedValue({ id: 9 });
  db.candidateLegalHold.update.mockResolvedValue({ id: 9, releasedAt: new Date() });
  db.candidateAnonymizationLog.create.mockResolvedValue({ id: 11 });
  db.candidateRetentionPolicy.findFirst.mockResolvedValue(null);
  db.application.findMany.mockResolvedValue([{ stage: "screening", status: "active" }]);
});

describe("candidate consent", () => {
  it("records consent and mirrors the PROCESSING decision onto the candidate", async () => {
    const result = await privacy.recordConsent(
      { tenantId: TENANT, candidateId: 7, purpose: "PROCESSING", status: "WITHDRAWN", actorId: ACTOR },
      { db },
    );

    expect(result.candidateConsentStatus).toBe("WITHDRAWN");
    expect(db.candidateConsent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: TENANT, candidateId: 7, purpose: "PROCESSING", status: "WITHDRAWN" }),
      }),
    );
    expect(db.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, id: 7 }),
        data: expect.objectContaining({ consentStatus: "WITHDRAWN" }),
      }),
    );
  });

  it("does NOT fold a non-PROCESSING purpose into the candidate's overall status", async () => {
    const result = await privacy.recordConsent(
      { tenantId: TENANT, candidateId: 7, purpose: "MARKETING", status: "WITHDRAWN" },
      { db },
    );

    expect(result.candidateConsentStatus).toBe("GRANTED");
    expect(db.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown purpose or status instead of storing it", async () => {
    await expect(privacy.recordConsent({ tenantId: TENANT, candidateId: 7, purpose: "WHATEVER", status: "GRANTED" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-CONSENT-PURPOSE-INVALID" });
    await expect(privacy.recordConsent({ tenantId: TENANT, candidateId: 7, purpose: "PROCESSING", status: "MAYBE" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-CONSENT-STATUS-INVALID" });
    expect(db.candidateConsent.create).not.toHaveBeenCalled();
  });

  it("keeps history rather than overwriting it", async () => {
    await privacy.recordConsent({ tenantId: TENANT, candidateId: 7, purpose: "PROCESSING", status: "GRANTED" }, { db });

    // Append-only: a new row, never an update of the previous decision.
    expect(db.candidateConsent.create).toHaveBeenCalledTimes(1);
    expect(db.candidateConsent).not.toHaveProperty("update");
  });
});

describe("do-not-contact register", () => {
  it("requires a compliance reason code AND a reason", async () => {
    await expect(privacy.recordDnc({ tenantId: TENANT, email: "a@b.test", reason: "asked" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-REASON-CODE-REQUIRED" });
    await expect(privacy.recordDnc({ tenantId: TENANT, email: "a@b.test", reasonCode: "CANDIDATE_REQUEST" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-REASON-REQUIRED" });
    expect(db.candidateDncEntry.create).not.toHaveBeenCalled();
  });

  it("normalizes the email so the block survives a re-import", async () => {
    await privacy.recordDnc(
      { tenantId: TENANT, email: "  Ayesha@EXAMPLE.com ", reasonCode: "CANDIDATE_REQUEST", reason: "Asked us to stop", actorId: ACTOR },
      { db },
    );

    expect(db.candidateDncEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "ayesha@example.com" }) }),
    );
  });

  it("refuses a second ACTIVE entry for the same address", async () => {
    db.candidateDncEntry.findFirst.mockResolvedValue({ id: 3, reasonCode: "CANDIDATE_REQUEST" });

    await expect(privacy.recordDnc(
      { tenantId: TENANT, email: "ayesha@example.com", reasonCode: "CANDIDATE_REQUEST", reason: "again" },
      { db },
    )).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-EXISTS" });
  });

  it("treats an EXPIRED entry as no longer blocking", async () => {
    // The probe filters on expiresAt, so an expired row must not be returned.
    db.candidateDncEntry.findFirst.mockResolvedValue(null);

    const found = await privacy.findActiveDnc({ tenantId: TENANT, email: "ayesha@example.com" }, { db });

    expect(found).toBeNull();
    expect(db.candidateDncEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it("requires a reason to lift, and keeps the lifted row", async () => {
    db.candidateDncEntry.findFirst.mockResolvedValue({ id: 3, status: "ACTIVE", email: "ayesha@example.com" });

    await expect(privacy.liftDnc({ tenantId: TENANT, id: 3 }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-LIFT-REASON-REQUIRED" });

    await privacy.liftDnc({ tenantId: TENANT, id: 3, reason: "Candidate re-applied", actorId: ACTOR }, { db });

    expect(db.candidateDncEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "LIFTED", liftReason: "Candidate re-applied" }),
      }),
    );
  });

  it("cannot lift an entry twice or lift another tenant's entry", async () => {
    db.candidateDncEntry.findFirst.mockResolvedValue({ id: 3, status: "LIFTED" });
    await expect(privacy.liftDnc({ tenantId: TENANT, id: 3, reason: "x" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-NOT-ACTIVE" });

    db.candidateDncEntry.findFirst.mockResolvedValue(null);
    await expect(privacy.liftDnc({ tenantId: TENANT, id: 999, reason: "x" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-NOT-FOUND", status: 404 });
  });
});

describe("communication gate", () => {
  it("blocks a DNC candidate even when consent is intact", async () => {
    db.candidateDncEntry.findFirst.mockResolvedValue({ id: 3, reasonCode: "CANDIDATE_REQUEST" });

    await expect(privacy.assertCommunicationsAllowed({ tenantId: TENANT, candidateId: 7 }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
  });

  it("blocks a withdrawn-consent candidate", async () => {
    db.candidate.findFirst.mockResolvedValue({ ...CANDIDATE, consentStatus: "WITHDRAWN" });

    await expect(privacy.assertCommunicationsAllowed({ tenantId: TENANT, candidateId: 7 }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-CONSENT-WITHDRAWN" });
  });

  it("does NOT treat legacy UNKNOWN consent as withdrawn", async () => {
    db.candidate.findFirst.mockResolvedValue({ ...CANDIDATE, consentStatus: "UNKNOWN" });

    const result = await privacy.assertCommunicationsAllowed({ tenantId: TENANT, candidateId: 7 }, { db });

    expect(result).toMatchObject({ allowed: true, consentStatus: "UNKNOWN" });
  });

  it("matches a DNC recorded against the email of a DIFFERENT candidate row", async () => {
    db.candidateDncEntry.findFirst.mockResolvedValue({ id: 4, reasonCode: "LEGAL" });

    await expect(privacy.assertCommunicationsAllowed(
      { tenantId: TENANT, email: "ayesha@example.com" },
      { db },
    )).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
  });
});

describe("legal hold", () => {
  it("requires a reason and refuses a duplicate active hold", async () => {
    await expect(privacy.placeLegalHold({ tenantId: TENANT, candidateId: 7 }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-LEGAL-HOLD-REASON-REQUIRED" });

    db.candidateLegalHold.findFirst.mockResolvedValue({ id: 9, reason: "litigation" });
    await expect(privacy.placeLegalHold({ tenantId: TENANT, candidateId: 7, reason: "litigation" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-LEGAL-HOLD-EXISTS" });
  });

  it("refuses to release a hold that is not active", async () => {
    await expect(privacy.releaseLegalHold({ tenantId: TENANT, candidateId: 7, reason: "done" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-LEGAL-HOLD-NOT-FOUND", status: 404 });
  });
});

describe("anonymization", () => {
  it("redacts PII, keeps aggregate history, and logs what it did", async () => {
    const result = await privacy.anonymizeCandidate(
      { tenantId: TENANT, candidateId: 7, reason: "Erasure request", legalBasis: "GDPR Art.17", actorId: ACTOR },
      { db },
    );

    expect(result.alreadyAnonymized).toBe(false);
    const update = db.candidate.updateMany.mock.calls[0][0];
    expect(update.data).toMatchObject({
      firstName: "Anonymized",
      lastName: null,
      phone: null,
      notes: null,
      parsedResume: null,
      consentStatus: "WITHDRAWN",
    });
    // The real address must be gone, and the tombstone stays unique per tenant.
    expect(update.data.email).toBe("anon-7@anonymized.invalid");
    expect(update.where).toMatchObject({ tenantId: TENANT, id: 7 });
    // Aggregate facts survive: pipeline counts, not personal data.
    expect(db.candidateAnonymizationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          candidateId: 7,
          reason: "Erasure request",
          redactedFields: expect.arrayContaining(["email", "phone", "parsedResume"]),
          retainedSummary: expect.objectContaining({ applications: 1 }),
        }),
      }),
    );
  });

  it("REFUSES while a legal hold is active", async () => {
    db.candidateLegalHold.findFirst.mockResolvedValue({ id: 9, reason: "litigation" });

    await expect(privacy.anonymizeCandidate({ tenantId: TENANT, candidateId: 7, reason: "erasure" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-LEGAL-HOLD-BLOCKS-ANONYMIZATION" });
    expect(db.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("replays an already-anonymized candidate instead of re-redacting", async () => {
    db.candidate.findFirst.mockResolvedValue({ ...CANDIDATE, anonymizedAt: new Date("2026-01-01T00:00:00Z") });

    const result = await privacy.anonymizeCandidate({ tenantId: TENANT, candidateId: 7, reason: "erasure" }, { db });

    expect(result).toMatchObject({ alreadyAnonymized: true });
    expect(db.candidate.updateMany).not.toHaveBeenCalled();
    expect(db.candidateAnonymizationLog.create).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    await expect(privacy.anonymizeCandidate({ tenantId: TENANT, candidateId: 7 }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-ANONYMIZE-REASON-REQUIRED" });
  });
});

describe("retention", () => {
  it("has NO clock when the tenant has no policy", async () => {
    expect(await privacy.computeRetentionUntil({ tenantId: TENANT }, { db })).toBeNull();
  });

  it("derives the deadline from the tenant policy", async () => {
    db.candidateRetentionPolicy.findFirst.mockResolvedValue({ retentionMonths: 6, appliesTo: "APPLICANT" });

    const until = await privacy.computeRetentionUntil(
      { tenantId: TENANT, from: new Date("2026-01-15T00:00:00Z") },
      { db },
    );

    expect(until.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("suspends retention for a candidate under legal hold", async () => {
    db.candidate.findMany = jest.fn().mockResolvedValue([
      { id: 7, email: "a@b.test", retentionUntil: new Date("2026-01-01T00:00:00Z"), anonymizedAt: null },
    ]);
    db.candidateLegalHold.findFirst.mockResolvedValue({ id: 9 });

    const preview = await privacy.previewRetentionDue({ tenantId: TENANT, asOf: new Date("2026-06-01T00:00:00Z") }, { db });

    expect(preview.due).toHaveLength(0);
    expect(preview.suspendedByLegalHold).toHaveLength(1);
  });

  it("defaults applyRetention to a DRY RUN", async () => {
    const result = await privacy.applyRetention({ tenantId: TENANT, asOf: new Date("2026-06-01T00:00:00Z") }, { db });

    expect(result.dryRun).toBe(true);
    expect(db.candidate.updateMany).not.toHaveBeenCalled();
  });
});

describe("data-subject requests", () => {
  it("rejects an invalid request type and defaults the SLA clock", async () => {
    await expect(privacy.recordDataAccessRequest({ tenantId: TENANT, subjectEmail: "a@b.test", type: "SHRED" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DAR-TYPE-INVALID" });

    db.candidateDataAccessRequest.create.mockResolvedValue({ id: 5 });
    await privacy.recordDataAccessRequest({ tenantId: TENANT, subjectEmail: "A@B.test", type: "ACCESS" }, { db });

    const created = db.candidateDataAccessRequest.create.mock.calls[0][0].data;
    expect(created.subjectEmail).toBe("a@b.test");
    expect(created.dueAt).toBeInstanceOf(Date);
  });

  it("requires a rejection reason and refuses to close twice", async () => {
    db.candidateDataAccessRequest.findFirst.mockResolvedValue({ id: 5, status: "RECEIVED" });

    await expect(privacy.closeDataAccessRequest({ tenantId: TENANT, id: 5, status: "REJECTED" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DAR-REJECTION-REASON-REQUIRED" });

    db.candidateDataAccessRequest.findFirst.mockResolvedValue({ id: 5, status: "FULFILLED" });
    await expect(privacy.closeDataAccessRequest({ tenantId: TENANT, id: 5, status: "FULFILLED" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-DAR-ALREADY-CLOSED" });
  });
});

describe("tenancy", () => {
  it("fails closed without a tenant on every entry point", async () => {
    await expect(privacy.assertCommunicationsAllowed({ tenantId: null, candidateId: 7 }, { db }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    await expect(privacy.listDnc({ tenantId: "" }, { db }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    await expect(privacy.previewRetentionDue({ tenantId: undefined }, { db }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });

  it("scopes candidate lookups by tenant", async () => {
    await privacy.recordConsent({ tenantId: TENANT, candidateId: 7, purpose: "PROCESSING", status: "GRANTED" }, { db });

    expect(db.candidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, id: 7 }) }),
    );
  });

  it("cannot reach another tenant's candidate", async () => {
    db.candidate.findFirst.mockResolvedValue(null);

    await expect(privacy.placeLegalHold({ tenantId: TENANT, candidateId: 999, reason: "x" }, { db }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-CANDIDATE-NOT-FOUND", status: 404 });
  });
});
