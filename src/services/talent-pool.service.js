import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import logger from "../lib/logger.js";
import { computeRetentionUntil } from "./candidate-privacy.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { talentPoolAddedEvent, talentPoolRemovedEvent } from "./hrEvents.js";
import { eventContext } from "../lib/event-context.util.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// talent-pool reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's talent pools.

export const listPools = async ({ page = 1, limit = 20, tenantId } = {}) => {
    const skip = (page - 1) * limit;
    const where = scopedWhere(tenantId, {});
    const [items, total] = await Promise.all([
        prisma.talentPool.findMany({ where, skip, take: limit, orderBy: { addedAt: "desc" }, include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
        prisma.talentPool.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const addToPool = async ({ candidateId, poolName, notes, addedById, tenantId }) => {
    // F-37 — the membership row and its outbox event commit together. The
    // retention stamp below stays OUTSIDE this transaction on purpose: it is
    // fail-soft, and a failed statement inside a Postgres transaction would abort
    // it (and the pool entry with it) even though the error is caught.
    const id = Number(candidateId);
    if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("candidateId must be a positive integer"), { status: 400, code: "HR-RECRUITMENT-CANDIDATE-INVALID" });
    }
    const entry = await tenantTransaction(prisma, async (tx) => {
        // The foreign key does not know tenants: a pool row in this tenant may
        // only point at this tenant's candidate. Another tenant's id (or an
        // unknown one) reads as not found, never as a row created across tenants.
        const candidate = await tx.candidate.findFirst({ where: scopedWhere(tenantId, { id }), select: { id: true } });
        if (!candidate) {
            throw Object.assign(new Error("Candidate not found"), { status: 404, code: "HR-RECRUITMENT-CANDIDATE-NOT-FOUND" });
        }
        const created = await tx.talentPool.create({
            data: scopedData(tenantId, {
                candidateId: id,
                poolName,
                notes,
                addedById: addedById ? Number(addedById) : null,
            }),
        });
        await enqueueHrDomainEvent(
            tx,
            talentPoolAddedEvent({ ...created, tenantId: created.tenantId ?? tenantId ?? null }, eventContext({ actorId: addedById })),
        );
        return created;
    });

    // Phase 10 (remainder) — TALENT_POOL retention wiring.
    //
    // The privacy model has always supported a per-population policy
    // (`appliesTo: 'TALENT_POOL'` beside `APPLICANT`), but NOTHING read it: the
    // retention clock was stamped only on candidate creation, with the APPLICANT
    // policy. So a candidate kept on file for future roles was still counting down
    // on the applicant clock — the pool is a DIFFERENT lawful basis, and its clock
    // starts when the candidate enters it.
    //
    // No policy for the population ⇒ no clock (unchanged, and never a guessed
    // default). Fail-soft: the pool entry already exists, so a policy lookup
    // failure must not undo it — but it is logged, because a silently missing
    // retention clock is exactly the kind of thing nobody notices until an audit.
    try {
        const retentionUntil = await computeRetentionUntil(
            { tenantId, appliesTo: "TALENT_POOL" },
            { db: prisma },
        );
        if (!retentionUntil) return entry;
        // FR-10 residue — and which clock it is. The candidate may also be a
        // live applicant, so the row has to say which lawful basis is counting
        // down; without the marker the APPLICANT sweep would erase someone kept
        // on file for future roles, under a basis that never applied to them.
        await prisma.candidate.updateMany({
            where: scopedWhere(tenantId, { id: Number(candidateId) }),
            data: { retentionUntil, retentionPopulation: "TALENT_POOL" },
        });
        return { ...entry, retentionUntil, retentionPopulation: "TALENT_POOL" };
    } catch (err) {
        logger.warn(
            { errMessage: err?.message, candidateId, tenantId },
            "talent pool: TALENT_POOL retention clock not stamped",
        );
        return entry;
    }
};

export const removeFromPool = async (id, tenantId, ctx = {}) => {
    const evtCtx = eventContext(ctx);
    // F-37 — pre-read, delete and outbox event in one transaction.
    return tenantTransaction(prisma, async (tx) => {
        const existing = await tx.talentPool.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
        if (!existing) throw new Error("Talent pool entry not found");
        const removed = await tx.talentPool.delete({ where: { id: Number(id) } });
        // The pre-read row's tenant is authoritative (a legacy tenantless entry emits nothing).
        await enqueueHrDomainEvent(tx, talentPoolRemovedEvent({ ...existing, ...(removed ?? {}), tenantId: existing.tenantId ?? null }, evtCtx));
        return removed;
    });
};

export const getCandidatesInPool = async (poolName, tenantId) => {
    return prisma.talentPool.findMany({
        where: scopedWhere(tenantId, { poolName }),
        include: { candidate: { include: { tags: { include: { tag: true } } } } },
    });
};
