import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { offerSentEvent } from "./hrEvents.js";
import { transitionApplicationStageInTransaction } from "./applicationWorkflow.service.js";
import { assertOfferApproved } from "./offerApproval.service.js";
import { getOfferHandoff, runOfferHandoff } from "./recruitmentHandoff.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { offerScopeWhere } from "../lib/recruitmentAccess.js";
import { offerAcceptedEvent } from "./hrEvents.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into reads and stamped on creates. Offer mutations pre-read
// tenant-scoped so a cross-tenant id is never sent/responded/updated
// (fail-closed); offers carry compensation, so isolation is sensitive.

export const createOffer = async ({ applicationId, candidateId, jobRequisitionId, salary, currency, startDate, expiryDate, notes, createdById, tenantId }) => {
    const candidateFk = Number(candidateId);
    if (!Number.isFinite(candidateFk)) throw new Error("candidateId is required");
    const requisitionFk = Number(jobRequisitionId);
    if (!Number.isFinite(requisitionFk)) throw new Error("jobRequisitionId is required");
    if (salary == null || salary === "") throw new Error("baseSalary is required");
    if (tenantId === undefined || tenantId === null || tenantId === "") {
        throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
    }

    return tenantTransaction(prisma, async (tx) => {
        const [candidate, requisition] = await Promise.all([
            tx.candidate.findFirst({ where: scopedWhere(tenantId, { id: candidateFk }), select: { id: true } }),
            tx.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: requisitionFk }), select: { id: true } }),
        ]);
        if (!candidate) throw new Error(`Candidate #${candidateFk} not found`);
        if (!requisition) throw new Error(`Job requisition #${requisitionFk} not found`);

        const created = await tx.offer.create({
            data: scopedData(tenantId, {
                applicationId: applicationId ? Number(applicationId) : null,
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
            await transitionApplicationStageInTransaction({
                id: Number(applicationId),
                tenantId,
                targetStage: "offer",
                reason: "Offer created",
                actorId: createdById,
                source: "offer-create",
            }, tx);
        }
        return created;
    });
};

// Phase 1.4 — `scope` narrows which offers a caller may read: a hiring manager
// sees the offers for their requisitions, finance the offers it prices, and an
// interviewer or agency none at all. Out-of-scope ids read as not-found.
export const getOffer = async (id, tenantId, scope = null) => {
    return prisma.offer.findFirst({
        where: scopedWhere(tenantId, { id: Number(id), ...(scope ? offerScopeWhere(scope) : {}) }),
        include: { candidate: true, jobRequisition: true },
    });
};

export const listOffers = async ({ page = 1, limit = 20, tenantId, scope = null }) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, scope ? offerScopeWhere(scope) : {});
    const [items, total] = await Promise.all([
        prisma.offer.findMany({
            where,
            skip,
            take: limit,
            orderBy: { created_at: "desc" },
            include: { candidate: true, jobRequisition: { include: { position: true } }, application: true },
        }),
        prisma.offer.count({ where }),
    ]);
    return { items, total, page, limit };
};

// Tenant-scoped pre-read guard reused by every offer mutation (fail-closed).
const assertOfferInTenant = async (id, tenantId) => {
    const existing = await prisma.offer.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Offer not found");
    return existing;
};

export const sendOffer = async (id, tenantId, ctx = {}) => {
    const existing = await assertOfferApproved({ offerId: id, tenantId });
    // Phase 10 — an offer IS candidate-facing contact, so it must pass the privacy
    // gate: a recorded do-not-contact request, or a withdrawn processing consent,
    // blocks the send even when every approval stage is in place.
    await assertCommunicationsAllowed({ tenantId, candidateId: existing.candidateId, purpose: "PROCESSING" });
    // M1-HR: the SENT flip + hr.recruitment.offer_sent.v1 outbox event are
    // atomic (outbox-on-write, validate-before-write). Ids-only, tenant-scoped.
    return tenantTransaction(prisma, async (tx) => {
        await assertOfferApproved({ offerId: id, tenantId, db: tx });
        // Re-check inside the transaction: a DNC recorded between the two reads
        // must not be raced by an already-in-flight send.
        await assertCommunicationsAllowed(
            { tenantId, candidateId: existing.candidateId, purpose: "PROCESSING" },
            { db: tx }
        );
        const row = await tx.offer.update({ where: { id: Number(id) }, data: { status: "SENT", sentAt: new Date() } });
        const event = offerSentEvent(
            { id: row.id, candidateId: row.candidateId, tenantId: row.tenantId ?? existing.tenantId ?? tenantId },
            ctx
        );
        if (event) await enqueueHrDomainEvent(tx, event);
        return row;
    });
};

export const respondOffer = async (id, accepted, tenantId, ctx = {}) => {
    const existing = await assertOfferInTenant(id, tenantId);
    const acceptedFlag = accepted === true || accepted === "true" || accepted === "ACCEPTED";
    const desired = acceptedFlag ? "ACCEPTED" : "DECLINED";

    // A replayed response is RETURNED, never re-processed: repeating an
    // acceptance hands back the same handoff instead of provisioning a second
    // employee (recruitmentHandoff.service.js owns that idempotency).
    if (existing.status === desired) {
        return {
            offer: existing,
            handoff: acceptedFlag ? await getOfferHandoff({ offerId: existing.id, tenantId }) : null,
            replayed: true,
        };
    }
    if (["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"].includes(existing.status)) {
        throw Object.assign(
            new Error(`Offer is already finalized as ${existing.status}`),
            { status: 409, code: "HR-RECRUITMENT-OFFER-FINALIZED" },
        );
    }
    // Only a SENT offer is answerable — a draft was never put to the candidate.
    if (existing.status !== "SENT") {
        throw Object.assign(
            new Error(`Only a SENT offer can be responded to (current status: ${existing.status})`),
            { status: 409, code: "HR-RECRUITMENT-OFFER-NOT-SENT" },
        );
    }

    const updated = await tenantTransaction(prisma, async (tx) => {
        const row = await tx.offer.update({
            where: { id: Number(id) },
            data: { status: desired, respondedAt: new Date() },
        });
        // Acceptance closes the pipeline: offer → hired. The canonical workflow
        // re-reads the now-ACCEPTED offer inside this same transaction, so the
        // "accepted offer required" invariant holds here too.
        if (acceptedFlag) {
            await enqueueHrDomainEvent(tx, offerAcceptedEvent(row, { actorId: ctx.actorId }));
        }
        if (acceptedFlag && row.applicationId) {
            await transitionApplicationStageInTransaction({
                id: Number(row.applicationId),
                tenantId,
                targetStage: "hired",
                reason: "Offer accepted",
                actorId: ctx.actorId,
                source: "offer-accept",
            }, tx);
        }
        return row;
    }, { tenantId });

    if (!acceptedFlag) return { offer: updated, handoff: null, replayed: false };

    // Provisioning runs AFTER acceptance commits: a failed handoff must not undo
    // the candidate's decision. Its FAILED row is retryable.
    const { handoff } = await runOfferHandoff({ offerId: updated.id, tenantId, actorId: ctx.actorId });
    return { offer: updated, handoff, replayed: false };
};

export const uploadOfferLetter = async (id, file, tenantId) => {
    await assertOfferInTenant(id, tenantId);
    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.offer.update({
        where: { id: Number(id) },
        data: { offerLetterMediaId: uploaded[0].id },
    });
};

export const updateOffer = async (id, { applicationId, candidateId, jobRequisitionId, salary, currency, startDate, expiryDate, notes, status, expectedVersion }, tenantId) => {
    await assertOfferInTenant(id, tenantId);
    // API-2 — optimistic-concurrency guard (opt-in). Absent ⇒ no reject.
    const expected = normalizeExpectedVersion(expectedVersion);
    const data = {};
    if (applicationId !== undefined) data.applicationId = applicationId ? Number(applicationId) : null;
    // candidateId / jobRequisitionId are NOT-NULL FKs: only overwrite when a truthy
    // value is supplied so a partial update (or an explicit null) never clobbers
    // them to 0/NaN.
    if (candidateId) data.candidateId = Number(candidateId);
    if (jobRequisitionId) data.jobRequisitionId = Number(jobRequisitionId);
    if (salary !== undefined && salary != null && salary !== "") data.salary = String(salary); // NOT-NULL C4-encrypted String column
    if (currency !== undefined) data.currency = currency || "USD";
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (expiryDate !== undefined) data.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (notes !== undefined) data.notes = notes;
    if (status !== undefined) data.status = status;

    // API-2 — atomic compare-and-set + version bump, still tenant-scoped.
    const versionWhere = expected == null ? {} : { version: expected };
    const { count } = await prisma.offer.updateMany({
        where: scopedWhere(tenantId, { id: Number(id), ...versionWhere }),
        data: { ...data, version: { increment: 1 } },
    });
    if (count === 0 && expected != null) {
        const fresh = await prisma.offer.findFirst({
            where: scopedWhere(tenantId, { id: Number(id) }),
            select: { version: true },
        });
        throw preconditionFailedError(fresh?.version);
    }
    return prisma.offer.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
};
