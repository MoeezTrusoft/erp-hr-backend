// src/services/applicationWorkflow.service.js
//
// Canonical Recruitment application workflow. REST, MCP, interview scheduling,
// and future workers must use this service instead of writing Application.stage
// directly. The optional `db` argument lets callers compose the transition into
// an existing transaction (for example, interview creation).
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationStageChangedEvent } from "./hrEvents.js";

export const APPLICATION_STAGES = Object.freeze([
    "applied",
    "screening",
    "interview",
    "offer",
    "hired",
    "rejected",
    "on_hold",
    "withdrawn",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
    applied: new Set(["screening", "rejected", "on_hold", "withdrawn"]),
    screening: new Set(["interview", "rejected", "on_hold", "withdrawn"]),
    interview: new Set(["offer", "rejected", "on_hold", "withdrawn"]),
    offer: new Set(["hired", "rejected", "on_hold", "withdrawn"]),
    hired: new Set(),
    rejected: new Set(),
    on_hold: new Set(["screening", "interview", "rejected", "withdrawn"]),
    withdrawn: new Set(),
});

const normalizeStage = (stage) => String(stage || "").trim().toLowerCase();

const workflowError = (message, code = "HR-RECRUITMENT-WORKFLOW") =>
    Object.assign(new Error(message), { status: 409, code });

const actorNumber = (actorId) => {
    const value = Number(actorId);
    return Number.isInteger(value) && value > 0 ? value : null;
};

const assertReason = (targetStage, reason) => {
    if (["rejected", "on_hold", "withdrawn"].includes(targetStage) && !String(reason || "").trim()) {
        throw workflowError(`${targetStage} transitions require a reason`, "HR-RECRUITMENT-REASON-REQUIRED");
    }
};

async function assertPrerequisites(db, application, targetStage) {
    if (targetStage === "interview") {
        // A scheduled interview is the authoritative prerequisite. The interview
        // creation path invokes this service in the same transaction after the
        // interview row exists.
        const interview = await db.interview.findFirst({
            where: {
                applicationId: application.id,
                tenantId: application.tenantId ?? null,
                status: { not: "CANCELLED" },
            },
            select: { id: true },
        });
        if (!interview) {
            throw workflowError("An active interview is required before moving to interview stage", "HR-RECRUITMENT-INTERVIEW-REQUIRED");
        }
    }

    if (targetStage === "offer") {
        const completedInterview = await db.interview.findFirst({
            where: {
                applicationId: application.id,
                tenantId: application.tenantId ?? null,
                status: "COMPLETED",
                decision: "NEXT_ROUND",
            },
            select: { id: true },
        });
        if (!completedInterview) {
            throw workflowError("A completed interview with a NEXT_ROUND decision is required before an offer stage", "HR-RECRUITMENT-INTERVIEW-OUTCOME-REQUIRED");
        }
    }

    if (targetStage === "hired") {
        const acceptedOffer = await db.offer.findFirst({
            where: {
                applicationId: application.id,
                tenantId: application.tenantId ?? null,
                status: "ACCEPTED",
            },
            select: { id: true },
        });
        if (!acceptedOffer) {
            throw workflowError("An accepted offer is required before moving to hired stage", "HR-RECRUITMENT-ACCEPTED-OFFER-REQUIRED");
        }
    }
}

/**
 * Transition one tenant-scoped application, write immutable transition history,
 * and announce the change on the event fabric.
 *
 * Pass `db` when composing into a caller-owned transaction (interview scheduling,
 * offer creation). With no `db` the whole transition runs in ONE tenant
 * transaction, so the state change, its history row and the outbox event are
 * atomic — previously the REST/MCP path wrote them as separate statements, so a
 * mid-way failure could record a stage move with no history or announce one that
 * rolled back.
 */
export async function transitionApplicationStage(args = {}) {
    const { db, ...rest } = args;
    if (db) return transitionApplicationStageCore({ ...rest, db });
    return tenantTransaction(prisma, (tx) => transitionApplicationStageCore({ ...rest, db: tx }));
}

/** The transition itself. Must be given a client (caller tx or the wrapper's). */
async function transitionApplicationStageCore({
    id,
    tenantId,
    targetStage,
    reason,
    actorId,
    source = "application",
    db = prisma,
} = {}) {
    if (tenantId === undefined || tenantId === null || tenantId === "") {
        // (tenant context is required on every path, including the wrapper's)
        throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
    }

    const normalizedTarget = normalizeStage(targetStage);
    if (!APPLICATION_STAGES.includes(normalizedTarget)) {
        throw workflowError(`Unsupported application stage: ${normalizedTarget}`, "HR-RECRUITMENT-STAGE-INVALID");
    }

    const application = await db.application.findFirst({
        where: { id: Number(id), tenantId },
        include: { offer: { select: { id: true, status: true } } },
    });
    if (!application) throw Object.assign(new Error(`Application "${id}" not found`), { status: 404 });
    if (application.stage === normalizedTarget) {
        return { success: true, changed: false, id: application.id, stage: application.stage };
    }

    if (!ALLOWED_TRANSITIONS[application.stage]?.has(normalizedTarget)) {
        throw workflowError(`Invalid application transition: ${application.stage} → ${normalizedTarget}`, "HR-RECRUITMENT-TRANSITION-INVALID");
    }

    assertReason(normalizedTarget, reason);
    await assertPrerequisites(db, application, normalizedTarget);

    const reasonText = String(reason || "").trim() || null;
    const updateData = {
        stage: normalizedTarget,
        ...(normalizedTarget === "rejected" ? { dispositionReason: reasonText } : {}),
        ...(normalizedTarget === "on_hold" ? { holdReason: reasonText } : {}),
        ...(normalizedTarget === "withdrawn" ? { withdrawnReason: reasonText } : {}),
    };

    const updated = await db.application.update({
        where: { id: application.id },
        data: updateData,
        include: { candidate: true, jobRequisition: true, offer: true },
    });

    await db.applicationStageHistory.create({
        data: {
            applicationId: application.id,
            tenantId,
            fromStage: application.stage,
            toStage: normalizedTarget,
            reason: reasonText,
            actorId: actorNumber(actorId),
            source,
        },
    });

    // Audit logging is best-effort in the legacy log subsystem; the immutable
    // applicationStageHistory row above is the authoritative workflow record.
    await logAction({
        employeeId: actorNumber(actorId),
        type: "UPDATE",
        module: "ApplicationStage",
        result: "SUCCESS",
        notes: `Application "${application.id}" moved from "${application.stage}" to "${normalizedTarget}".`,
        tenantId,
    });

    // Phase 11 — outbox-on-write. The event is enqueued on the SAME client as the
    // state change (the caller's tx when composed), so a rolled-back transition
    // never announces a move that did not happen. Ids-only: no candidate PII and
    // no compensation leave the service.
    await enqueueHrDomainEvent(
        db,
        applicationStageChangedEvent(
            updated,
            { actorId: actorNumber(actorId) },
            { fromStage: application.stage, toStage: normalizedTarget, reason: reasonText },
        ),
    );

    return { success: true, changed: true, data: updated };
}

export async function transitionApplicationStageInTransaction(args, tx) {
    return transitionApplicationStage({ ...args, db: tx });
}

export function canTransitionApplicationStage(fromStage, targetStage) {
    return Boolean(ALLOWED_TRANSITIONS[normalizeStage(fromStage)]?.has(normalizeStage(targetStage)));
}
