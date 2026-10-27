import {
  offerTermsSchema,
  offerCompensationSchema,
} from "../lib/offerInput.js";
import { resolveStatusLink } from "./candidateVerification.service.js";
import { configuredLibreSign } from "../lib/libresignClient.js";
import { consumeApproval } from "./approval/adapters.js";
import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes
import { createOfferLetter } from "./offerLetter.service.js";
import {
  queueOfferSignature,
  requireOfferSignature,
} from "./offerSignature.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import {
  normalizeExpectedVersion,
  preconditionFailedError,
} from "../lib/optimisticConcurrency.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { offerSentEvent } from "./hrEvents.js";
import { transitionApplicationStageInTransaction } from "./applicationWorkflow.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  getOfferHandoff,
  runOfferHandoff,
} from "./recruitmentHandoff.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import {
  offerScopeWhere,
  maskOfferForScope,
  maskOffersForScope,
} from "../lib/recruitmentAccess.js";
import { offerAcceptedEvent } from "./hrEvents.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into reads and stamped on creates. Offer mutations pre-read
// tenant-scoped so a cross-tenant id is never sent/responded/updated
// (fail-closed); offers carry compensation, so isolation is sensitive.

export const createOffer = async ({
  applicationId,
  candidateId,
  jobRequisitionId,
  employeeCategory,
  salary,
  currency,
  startDate,
  expiryDate,
  notes,
  createdById,
  tenantId,
}) => {
  const candidateFk = Number(candidateId);
  if (!Number.isFinite(candidateFk)) throw new Error("candidateId is required");
  const requisitionFk = Number(jobRequisitionId);
  if (!Number.isFinite(requisitionFk))
    throw new Error("jobRequisitionId is required");
  if (
    salary == null ||
    salary === "" ||
    !Number.isFinite(Number(salary)) ||
    Number(salary) <= 0
  )
    throw new Error("baseSalary is required");
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), {
      status: 400,
      code: "HR-TENANT-REQUIRED",
    });
  }

  return tenantTransaction(
    prisma,
    async (tx) => {
      const [candidate, requisition] = await Promise.all([
        tx.candidate.findFirst({
          where: scopedWhere(tenantId, { id: candidateFk }),
          select: { id: true },
        }),
        tx.jobRequisition.findFirst({
          where: scopedWhere(tenantId, { id: requisitionFk }),
          select: { id: true },
        }),
      ]);
      if (!candidate) throw new Error(`Candidate #${candidateFk} not found`);
      if (!requisition)
        throw new Error(`Job requisition #${requisitionFk} not found`);

      const application = await tx.application.findFirst({
        where: scopedWhere(tenantId, {
          id: Number(applicationId),
          candidateId: candidateFk,
          jobRequisitionId: requisitionFk,
        }),
      });
      if (!application)
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-5507",
        });
      const created = await tx.offer.create({
        data: scopedData(tenantId, {
          applicationId: application.id,
          employeeCategory: employeeCategory ?? null,
          candidateId: candidateFk,
          jobRequisitionId: requisitionFk,
          salary: String(salary),
          currency: currency || "USD",
          startDate: startDate ? new Date(startDate) : null,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          notes,
          createdById: createdById ? Number(createdById) : null,
        }),
      });

      if (applicationId != null) {
        await transitionApplicationStageInTransaction(
          {
            id: Number(applicationId),
            tenantId,
            targetStage: "offer",
            reason: "Offer created",
            actorId: createdById,
            source: "offer-create",
          },
          tx,
        );
      }
      return created;
    },
    { tenantId },
  );
};

// Phase 1.4 — `scope` narrows which offers a caller may read: a hiring manager
// sees the offers for their requisitions, finance the offers it prices, and an
// interviewer or agency none at all. Out-of-scope ids read as not-found.
// FR-09 residue — and the ROWS are masked for compensation on the way out, so a
// MANAGED caller who may legitimately open the offer does not receive its salary.
export const getOffer = async (id, tenantId, scope = null) => {
  const offer = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, {
      id: Number(id),
      ...(scope ? offerScopeWhere(scope) : {}),
    }),
    include: { candidate: true, jobRequisition: true },
  });
  return scope ? maskOfferForScope(offer, scope) : offer;
};

export const listOffers = async ({
  page = 1,
  limit = 20,
  tenantId,
  scope = null,
}) => {
  const skip = (page - 1) * limit;
  const where = scopedWhere(tenantId, scope ? offerScopeWhere(scope) : {});
  const [items, total] = await Promise.all([
    prisma.offer.findMany({
      where,
      skip,
      take: limit,
      orderBy: { created_at: "desc" },
      include: {
        candidate: true,
        jobRequisition: { include: { position: true } },
        application: true,
      },
    }),
    prisma.offer.count({ where }),
  ]);
  // FR-09 residue — mask the page, not just the detail read: a list that leaks
  // salary is the same leak in a different shape. `total` is unchanged (the
  // caller may know HOW MANY they can see, not what those offers pay).
  return {
    items: scope ? maskOffersForScope(items, scope) : items,
    total,
    page,
    limit,
  };
};

// Tenant-scoped pre-read guard reused by every offer mutation (fail-closed).
const assertOfferInTenant = async (id, tenantId) => {
  const existing = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw new Error("Offer not found");
  return existing;
};

export const sendOffer = async (id, tenantId, ctx = {}) => {
  const existing = await assertOfferInTenant(id, tenantId);
  if (existing.status !== "DRAFT")
    throw Object.assign(new Error("Only draft offers can be sent"), {
      status: 409,
      code: "HR-5501",
    });
  // Phase 10 — an offer IS candidate-facing contact, so it must pass the privacy
  // gate: a recorded do-not-contact request, or a withdrawn processing consent,
  // blocks the send even when every approval stage is in place.
  await assertCommunicationsAllowed({
    tenantId,
    candidateId: existing.candidateId,
    purpose: "PROCESSING",
    requireExplicitConsent: true,
  });
  const signingEnabled = isRecruitmentFlagEnabled("esignature");
  // Validate this company's protected binding before consuming its approval or
  // reporting an offer as sent. This reads local configuration, not provider APIs.
  if (signingEnabled) await configuredLibreSign(tenantId);
  // M1-HR: the SENT flip + hr.recruitment.offer_sent.v1 outbox event are
  // atomic (outbox-on-write, validate-before-write). Ids-only, tenant-scoped.
  return tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        existing.candidateId,
        tenantId,
      );
      await tx.$queryRawUnsafe(
        'SELECT id FROM offers WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        Number(id),
        tenantId,
      );
      const current = await tx.offer.findFirst({
        where: { id: Number(id), tenantId },
      });
      if (current.status !== "DRAFT")
        throw Object.assign(new Error("Only draft offers can be sent"), {
          status: 409,
          code: "HR-5501",
        });
      if (current.expiryDate && current.expiryDate <= new Date())
        throw Object.assign(
          new Error("Extend the expiry before sending this offer"),
          { status: 422, code: "HR-5504" },
        );
      await consumeApproval(tx, tenantId, "OFFER", String(id));
      if (signingEnabled) await queueOfferSignature(tx, current);
      // Re-check inside the transaction: a DNC recorded between the two reads
      // must not be raced by an already-in-flight send.
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: existing.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db: tx },
      );
      const row = await tx.offer.update({
        where: { id: Number(id) },
        data: { status: "SENT", sentAt: new Date() },
      });
      const event = offerSentEvent(
        {
          id: row.id,
          candidateId: row.candidateId,
          tenantId: row.tenantId ?? existing.tenantId ?? tenantId,
        },
        ctx,
      );
      if (event) await enqueueHrDomainEvent(tx, event);
      return row;
    },
    { tenantId },
  );
};

export const respondOffer = async (id, accepted, tenantId, ctx = {}) => {
  if (typeof ctx === "string") ctx = { employeeCategory: ctx };
  if (!isRecruitmentFlagEnabled("offerHandoff"))
    throw Object.assign(new Error("Offer acceptance is disabled"), {
      status: 503,
      code: "HR-5502",
    });
  const existing = await assertOfferInTenant(id, tenantId);
  if (ctx.candidateId != null && ctx.candidateId !== existing.candidateId)
    throw Object.assign(new Error("Offer not found"), {
      status: 404,
      code: "HR-5507",
    });
  const acceptedFlag =
    accepted === true || accepted === "true" || accepted === "ACCEPTED";
  const desired = acceptedFlag ? "ACCEPTED" : "DECLINED";
  const category = ctx.employeeCategory ?? existing.employeeCategory;

  // A replayed response is RETURNED, never re-processed: repeating an
  // acceptance hands back the same handoff instead of provisioning a second
  // employee (recruitmentHandoff.service.js owns that idempotency).
  if (existing.status === desired) {
    return tenantTransaction(
      prisma,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Candidate" WHERE id=${existing.candidateId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM offers WHERE id=${Number(id)} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const fresh = await tx.offer.findFirst({
          where: { id: Number(id), tenantId },
        });
        if (!fresh || fresh.status !== desired)
          throw Object.assign(new Error("Offer response has changed"), {
            status: 409,
            code: "HR-5504",
          });
        if (ctx.candidateToken) {
          const subject = await resolveStatusLink({
            tenantId,
            token: ctx.candidateToken,
            db: tx,
          });
          if (!subject || subject.candidateId !== fresh.candidateId)
            throw Object.assign(new Error("Offer not found"), {
              status: 404,
              code: "HR-5507",
            });
        }
        await assertCommunicationsAllowed(
          {
            tenantId,
            candidateId: fresh.candidateId,
            purpose: "PROCESSING",
            requireExplicitConsent: true,
          },
          { db: tx },
        );
        return {
          offer: fresh,
          handoff: acceptedFlag
            ? await getOfferHandoff({ offerId: fresh.id, tenantId, db: tx })
            : null,
          replayed: true,
        };
      },
      { tenantId },
    );
  }
  if (
    ["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"].includes(existing.status)
  ) {
    throw Object.assign(
      new Error(`Offer is already finalized as ${existing.status}`),
      { status: 409, code: "HR-RECRUITMENT-OFFER-FINALIZED" },
    );
  }
  // Only a SENT offer is answerable — a draft was never put to the candidate.
  if (existing.status !== "SENT") {
    throw Object.assign(
      new Error(
        `Only a SENT offer can be responded to (current status: ${existing.status})`,
      ),
      { status: 409, code: "HR-RECRUITMENT-OFFER-NOT-SENT" },
    );
  }

  if (
    acceptedFlag &&
    !["MANAGEMENT", "EMPLOYEE", "INTERNEE"].includes(category)
  )
    throw Object.assign(
      new Error("Choose an employee category before accepting"),
      { status: 422, code: "HR-5503" },
    );

  const updated = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        existing.candidateId,
        tenantId,
      );
      await tx.$queryRaw`SELECT id FROM offers WHERE id=${Number(id)} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      const fresh = await tx.offer.findFirst({
        where: { id: Number(id), tenantId },
      });
      if (ctx.candidateToken) {
        const subject = await resolveStatusLink({
          tenantId,
          token: ctx.candidateToken,
          db: tx,
        });
        if (!subject || subject.candidateId !== fresh.candidateId)
          throw Object.assign(new Error("Offer not found"), {
            status: 404,
            code: "HR-5507",
          });
      }
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: fresh.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db: tx },
      );
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      const signature = acceptedFlag
        ? await requireOfferSignature(tx, fresh)
        : null;
      const timelySignature =
        signature?.state === "SIGNED" &&
        signature.signedAt &&
        (!fresh.expiryDate || signature.signedAt <= fresh.expiryDate);
      if (fresh.status === desired) return fresh;
      if (
        fresh.status !== "SENT" ||
        (fresh.expiryDate && fresh.expiryDate <= new Date() && !timelySignature)
      )
        throw Object.assign(new Error("Offer is no longer answerable"), {
          status: 409,
          code: "HR-5504",
        });
      const row = await tx.offer.update({
        where: { id: Number(id) },
        data: {
          status: desired,
          respondedAt: new Date(),
          ...(acceptedFlag ? { employeeCategory: category } : {}),
        },
      });
      // Acceptance closes the pipeline: offer → hired. The canonical workflow
      // re-reads the now-ACCEPTED offer inside this same transaction, so the
      // "accepted offer required" invariant holds here too.
      if (acceptedFlag) {
        await enqueueHrDomainEvent(
          tx,
          offerAcceptedEvent(row, { actorId: ctx.actorId }),
        );
      }
      if (acceptedFlag && row.applicationId) {
        await transitionApplicationStageInTransaction(
          {
            id: Number(row.applicationId),
            tenantId,
            targetStage: "hired",
            reason: "Offer accepted",
            actorId: ctx.actorId,
            source: "offer-accept",
          },
          tx,
        );
      }
      return row;
    },
    { tenantId },
  );

  if (!acceptedFlag) return { offer: updated, handoff: null, replayed: false };

  // Provisioning runs AFTER acceptance commits: a failed handoff must not undo
  // the candidate's decision. Its FAILED row is retryable.
  const { handoff } = await runOfferHandoff({
    offerId: updated.id,
    tenantId,
    actorId: ctx.actorId,
  });
  return { offer: updated, handoff, replayed: false };
};

export const uploadOfferLetter = async (
  id,
  file,
  tenantId,
  expectedVersion,
) => {
  await assertOfferInTenant(id, tenantId);
  return createOfferLetter(
    { offerId: Number(id), expectedVersion: Number(expectedVersion) },
    { file },
  );
};

export const updateOffer = async (
  id,
  {
    applicationId,
    candidateId,
    jobRequisitionId,
    salary,
    currency,
    startDate,
    expiryDate,
    notes,
    status,
    expectedVersion,
    employeeCategory,
    employmentType,
    offerType,
    terms,
    compensation,
  },
  tenantId,
) => {
  const prior = await assertOfferInTenant(id, tenantId);
  if (prior.status !== "DRAFT")
    throw Object.assign(new Error("Sent and final offers are immutable"), {
      status: 409,
      code: "HR-5505",
    });
  if (status !== undefined && status !== "DRAFT")
    throw Object.assign(
      new Error("Use the offer lifecycle action to change status"),
      { status: 409, code: "HR-5506" },
    );
  // API-2 — optimistic-concurrency guard (opt-in). Absent ⇒ no reject.
  const expected = normalizeExpectedVersion(expectedVersion);
  const data = {};
  if (
    (applicationId !== undefined &&
      Number(applicationId) !== prior.applicationId) ||
    (candidateId !== undefined && Number(candidateId) !== prior.candidateId) ||
    (jobRequisitionId !== undefined &&
      Number(jobRequisitionId) !== prior.jobRequisitionId)
  )
    throw Object.assign(new Error("Offer application identity is immutable"), {
      status: 409,
      code: "HR-5509",
    });
  if (applicationId !== undefined)
    data.applicationId = applicationId ? Number(applicationId) : null;
  // candidateId / jobRequisitionId are NOT-NULL FKs: only overwrite when a truthy
  // value is supplied so a partial update (or an explicit null) never clobbers
  // them to 0/NaN.
  if (candidateId) data.candidateId = Number(candidateId);
  if (jobRequisitionId) data.jobRequisitionId = Number(jobRequisitionId);
  if (salary !== undefined) {
    if (
      salary == null ||
      salary === "" ||
      !Number.isFinite(Number(salary)) ||
      Number(salary) <= 0
    )
      throw Object.assign(new Error("Base salary must be greater than zero"), {
        status: 422,
        code: "HR-5511",
      });
    data.salary = String(salary);
  } // NOT-NULL C4-encrypted String column
  if (currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(currency || ""))
      throw Object.assign(new Error("Use a three-letter currency code"), {
        status: 422,
        code: "HR-5511",
      });
    data.currency = currency;
  }
  if (startDate !== undefined)
    data.startDate = startDate ? new Date(startDate) : null;
  if (expiryDate !== undefined)
    data.expiryDate = expiryDate ? new Date(expiryDate) : null;
  if (notes !== undefined) data.notes = notes;
  if (employeeCategory !== undefined) {
    if (!["EMPLOYEE", "MANAGEMENT", "INTERNEE"].includes(employeeCategory))
      throw Object.assign(new Error("Choose an employee category"), {
        status: 422,
        code: "HR-5503",
      });
    data.employeeCategory = employeeCategory;
  }
  if (employmentType !== undefined)
    data.employmentType = String(employmentType).slice(0, 100);
  if (offerType !== undefined) data.offerType = String(offerType).slice(0, 100);
  if (terms !== undefined) data.terms = offerTermsSchema.parse(terms);
  if (
    compensation !== undefined ||
    salary !== undefined ||
    currency !== undefined
  )
    data.compensation = {
      ...(prior.compensation ?? {}),
      ...(compensation === undefined
        ? {}
        : offerCompensationSchema.parse(compensation)),
      baseSalary: Number(data.salary ?? prior.salary),
      currency: data.currency ?? prior.currency,
    };
  if (status !== undefined) data.status = status;

  // API-2 — atomic compare-and-set + version bump, still tenant-scoped.
  const versionWhere = expected == null ? {} : { version: expected };
  const { count } = await prisma.offer.updateMany({
    where: scopedWhere(tenantId, {
      id: Number(id),
      status: "DRAFT",
      ...versionWhere,
    }),
    data: {
      ...data,
      offerLetterMediaId: null,
      approvalStatus: "PENDING",
      version: { increment: 1 },
    },
  });
  if (count === 0) {
    const fresh = await prisma.offer.findFirst({
      where: scopedWhere(tenantId, { id: Number(id) }),
      select: { version: true },
    });
    throw preconditionFailedError(fresh?.version);
  }
  return prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
};
