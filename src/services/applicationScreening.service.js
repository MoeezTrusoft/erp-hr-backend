// src/services/applicationScreening.service.js
//
// Phase 6 / decision record §4.1–4.3 — screening records, disposition reason
// codes and the requisition shortlist.
//
// Two things shape this file:
//
//   * §4.1a separation — screening is a RECRUITER/HIRING-TEAM function and is
//     deliberately separate from interview feedback, even when one person holds
//     both roles. This service owns the screening record; interviewMgmt keeps
//     owning structured interview feedback. They never write each other's rows.
//   * §4.2 reason codes — a REJECT/HOLD screening must name an ACTIVE tenant
//     reason code, and OTHER (or any code flagged requiresNotes) demands notes.
//     Free-text-only reasons are what disposition reporting cannot group by.
//     The default taxonomy is seeded LAZILY per tenant, inside the same
//     transaction that validates the first decision against it — so a fresh
//     tenant's first rejection is already coded, with no admin step required.
//
// Recording a REJECT/HOLD screening does NOT by itself move the application
// stage; the stage move goes through applicationWorkflow (which will refuse
// invalid transitions). What this service adds is the recorded, coded WHY —
// the workflow's reason column stays free text for the transition history,
// while the code is the reportable fact.

import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import {
    DEFAULT_DISPOSITION_REASONS,
    SCREENING_OUTCOMES,
    validateCriteria,
    validateScreeningDecision,
} from "../lib/dispositionReasons.js";

export class ScreeningError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.name = "ScreeningError";
        this.status = status;
        this.details = details;
    }
}

const fail = (message, status, details) => new ScreeningError(message, status, details);

/** The tenant's active reason codes, seeding the default taxonomy on first use. */
async function ensureReasonCodes(db, tenantId) {
    const existing = await db.dispositionReasonCode.findMany({
        where: { tenantId, isActive: true },
        select: { code: true, requiresNotes: true, version: true },
        orderBy: [{ code: "asc" }, { version: "desc" }],
    });
    if (existing.length) return existing;

    await db.dispositionReasonCode.createMany({
        data: DEFAULT_DISPOSITION_REASONS.map((r) => ({
            tenantId,
            code: r.code,
            label: r.label,
            requiresNotes: r.requiresNotes,
            version: 1,
            isActive: true,
        })),
    });

    return db.dispositionReasonCode.findMany({
        where: { tenantId, isActive: true },
        select: { code: true, requiresNotes: true, version: true },
        orderBy: [{ code: "asc" }, { version: "desc" }],
    });
}

/**
 * Record one screening decision. ADVANCE/REJECT/HOLD with the §4.2 code rules.
 * The application must belong to the caller's tenant. Runs in one tenant
 * transaction with the (possibly first-use) reason-code seed.
 */
export async function recordScreening({ applicationId, tenantId, outcome, reasonCode = null, notes = null, criteria = null, actorId = null } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400);

    return tenantTransaction(prisma, async (tx) => {
        const application = await tx.application.findFirst({
            where: { id: Number(applicationId), tenantId },
            select: { id: true, stage: true },
        });
        if (!application) throw fail("Application not found", 404);

        const activeCodes = await ensureReasonCodes(tx, tenantId);

        const criteriaCheck = validateCriteria(criteria);
        if (!criteriaCheck.ok) {
            throw fail("Invalid screening criteria", 400, { errors: criteriaCheck.errors });
        }

        const decision = validateScreeningDecision({ outcome, reasonCode, notes, activeCodes });
        if (!decision.ok) {
            throw fail("Invalid screening decision", 400, { errors: decision.errors });
        }

        const row = await tx.applicationScreening.create({
            data: {
                applicationId: application.id,
                tenantId,
                outcome,
                reasonCode: outcome === "ADVANCE" ? null : reasonCode,
                notes: decision.notes,
                criteria: criteriaCheck.normalized ?? undefined,
                reviewedById: actorId ?? null,
            },
        });

        await logAction({
            employeeId: actorId ?? null,
            type: "CREATE",
            module: "Application Screening",
            result: "SUCCESS",
            notes: `Screening ${outcome}${reasonCode ? ` (${reasonCode})` : ""} recorded on application "${application.id}"`,
            tenantId,
        });

        return row;
    });
}

/** Newest-first screening history for one application. */
export async function listScreenings(applicationId, tenantId) {
    return prisma.applicationScreening.findMany({
        where: { applicationId: Number(applicationId), tenantId },
        orderBy: { reviewedAt: "desc" },
    });
}

/** List the tenant's active reason codes (admin picker source), seeding if fresh. */
export async function listDispositionReasons(tenantId) {
    return tenantTransaction(prisma, (tx) => ensureReasonCodes(tx, tenantId));
}

/** Deactivate one code for the tenant. Versioning keeps history resolvable. */
export async function deactivateDispositionReason(tenantId, code) {
    const result = await prisma.dispositionReasonCode.updateMany({
        where: { tenantId, code, isActive: true },
        data: { isActive: false },
    });
    if (result.count === 0) throw fail(`Reason code "${code}" not found or already inactive`, 404);
    return { code, deactivated: true };
}

/** Create a new VERSION of a code (label/notes-requirement change), not an edit. */
export async function versionDispositionReason({ tenantId, code, label, requiresNotes = false, actorId = null } = {}) {
    if (!code || !label) throw fail("code and label are required", 400);
    return tenantTransaction(prisma, async (tx) => {
        const current = await tx.dispositionReasonCode.findFirst({
            where: { tenantId, code, isActive: true },
            orderBy: { version: "desc" },
        });
        if (!current) {
            // New code entirely — the tenant extends the taxonomy.
            return tx.dispositionReasonCode.create({
                data: { tenantId, code, label, requiresNotes, version: 1, isActive: true },
            });
        }
        // Same shape: nothing to version.
        if (current.label === label && current.requiresNotes === requiresNotes) return current;
        return tx.dispositionReasonCode.create({
            data: { tenantId, code, label, requiresNotes, version: current.version + 1, isActive: true },
        });
    });
}

// ── §4.3 — the requisition shortlist ─────────────────────────────────────────

/**
 * Mark an application onto its requisition's shortlist. Idempotent: a repeat
 * add returns the existing row (reported as alreadyListed) rather than 409 —
 * marking is a toggle-like intent, not a creation race to police.
 */
export async function addToShortlist({ applicationId, tenantId, note = null, actorId = null } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400);
    return tenantTransaction(prisma, async (tx) => {
        const application = await tx.application.findFirst({
            where: { id: Number(applicationId), tenantId },
            select: { id: true, jobRequisitionId: true },
        });
        if (!application) throw fail("Application not found", 404);

        const existing = await tx.shortlistEntry.findUnique({ where: { applicationId: application.id } });
        if (existing) {
            // Refresh the note if provided; otherwise leave the row untouched.
            if (note != null) {
                return tx.shortlistEntry.update({
                    where: { applicationId: application.id },
                    data: { note },
                });
            }
            return { ...existing, alreadyListed: true };
        }

        return tx.shortlistEntry.create({
            data: {
                applicationId: application.id,
                requisitionId: application.jobRequisitionId,
                tenantId,
                note,
                addedById: actorId ?? null,
            },
        });
    });
}

/** The requisition's current shortlist, oldest-first (matches marking order). */
export async function listShortlist(requisitionId, tenantId) {
    return prisma.shortlistEntry.findMany({
        where: { requisitionId: Number(requisitionId), tenantId },
        orderBy: { addedAt: "asc" },
        include: {
            application: {
                select: {
                    id: true,
                    stage: true,
                    status: true,
                    candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            },
        },
    });
}

/** Remove an application from the shortlist. The screening/disposition record is the audit of WHY. */
export async function removeFromShortlist({ applicationId, tenantId } = {}) {
    const deleted = await prisma.shortlistEntry.deleteMany({
        where: { applicationId: Number(applicationId), tenantId },
    });
    if (deleted.count === 0) throw fail("Application is not on the shortlist", 404);
    return { removed: true };
}

export const SCREENING_OUTCOME_VALUES = SCREENING_OUTCOMES;

export default {
    recordScreening,
    listScreenings,
    listDispositionReasons,
    deactivateDispositionReason,
    versionDispositionReason,
    addToShortlist,
    listShortlist,
    removeFromShortlist,
};
