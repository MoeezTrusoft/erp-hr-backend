import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js"; // TEN-2: GUC-in-tx for FORCE-RLS writes
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { offerSentEvent } from "./hrEvents.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into reads and stamped on creates. Offer mutations pre-read
// tenant-scoped so a cross-tenant id is never sent/responded/updated
// (fail-closed); offers carry compensation, so isolation is sensitive.

export const createOffer = async ({ applicationId, candidateId, jobRequisitionId, salary, currency, startDate, expiryDate, notes, createdById, tenantId }) => {
    // Offer.candidateId / jobRequisitionId / salary are NOT-NULL columns (salary is
    // a C4-encrypted String). Assert the required FKs/amount are present so we never
    // write NaN into an Int FK or null into a NOT-NULL column.
    const candidateFk = Number(candidateId);
    if (!Number.isFinite(candidateFk)) throw new Error("candidateId is required");
    const requisitionFk = Number(jobRequisitionId);
    if (!Number.isFinite(requisitionFk)) throw new Error("jobRequisitionId is required");
    if (salary == null || salary === "") throw new Error("baseSalary is required");
    return prisma.offer.create({
        data: scopedData(tenantId, {
            applicationId: applicationId ? Number(applicationId) : null,
            candidateId: candidateFk,
            jobRequisitionId: requisitionFk,
            salary: String(salary), // NOT-NULL String column (C4-encrypted at rest)
            currency: currency || "USD",
            startDate: startDate ? new Date(startDate) : null,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            notes,
            createdById: createdById ? Number(createdById) : null,
        }),
    });
};

export const getOffer = async (id, tenantId) => {
    return prisma.offer.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { candidate: true, jobRequisition: true },
    });
};

export const listOffers = async ({ page = 1, limit = 20, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
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
    const existing = await assertOfferInTenant(id, tenantId);
    // M1-HR: the SENT flip + hr.recruitment.offer_sent.v1 outbox event are
    // atomic (outbox-on-write, validate-before-write). Ids-only, tenant-scoped.
    return tenantTransaction(prisma, async (tx) => {
        const row = await tx.offer.update({ where: { id: Number(id) }, data: { status: "SENT", sentAt: new Date() } });
        const event = offerSentEvent(
            { id: row.id, candidateId: row.candidateId, tenantId: row.tenantId ?? existing.tenantId ?? tenantId },
            ctx
        );
        if (event) await enqueueHrDomainEvent(tx, event);
        return row;
    });
};

export const respondOffer = async (id, accepted, tenantId) => {
    await assertOfferInTenant(id, tenantId);
    return prisma.offer.update({
        where: { id: Number(id) },
        data: { status: accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date() },
    });
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
