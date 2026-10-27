// src/services/scheduled-disposition.service.js
//
// Recruitment Phase 2 — the DELAYED, REVERSIBLE system disposition. Today it
// has one source: an application that fails a knockout question at intake is
// rejected with MINIMUM_REQUIREMENTS_NOT_MET, but not at once. The intake
// schedules the rejection (executeAt = now + the tenant's knockoutDelayHours)
// and a recruiter can cancel it inside that window, because a knockout answer
// is a candidate's self-report and the plan wants a human able to overrule it.
//
// The rules this file holds:
//
//   * ONE PATH TO "REJECTED". The job moves the application through the same
//     workflow transition a recruiter's rejection uses (applicationWorkflow:
//     the transition table, the reason requirement, the stage-history row and
//     the stage_changed event), with source "system.knockout" and no actor.
//   * A RECRUITER WINS. If the application has left the early stages (applied,
//     screening) or was already rejected/withdrawn/hired by the time the job
//     runs, the disposition is CANCELLED (STAGE_CHANGED), not executed. A
//     recruiter who moves the application by hand cancels it immediately
//     (cancelPendingDispositionsForApplication, called from the stage-change
//     path).
//   * IDEMPOTENT. One row per (application, source); the job claims a due row
//     with a guarded status update inside the transaction that executes it, so
//     two overlapping runs cannot both reject the same application.
//   * RETRIES. A failed execution rolls back, increments attempts, keeps the
//     error and is retried later (15 min x attempts); after 5 attempts it is
//     FAILED and left for a human.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { mcpCtx } from "../mcp/context.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { applicationScopeWhere } from "../lib/recruitment-access.util.js";
import { eventContext } from "../lib/event-context.util.js";
import { DEFAULT_DISPOSITION_REASONS } from "../lib/dispositionReasons.js";
import { RECRUITMENT_SETTINGS_DEFAULTS } from "./recruitment-settings.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const COMPONENT = "scheduled-disposition";

export const DISPOSITION_SOURCE = Object.freeze({ KNOCKOUT: "KNOCKOUT" });
export const DISPOSITION_STATUS = Object.freeze({
    PENDING: "PENDING",
    EXECUTED: "EXECUTED",
    CANCELLED: "CANCELLED",
    FAILED: "FAILED",
});
export const KNOCKOUT_REASON_CODE = "MINIMUM_REQUIREMENTS_NOT_MET";
export const KNOCKOUT_STAGE_SOURCE = "system.knockout";
export const STAGE_CHANGED = "STAGE_CHANGED";
export const DISPOSITION_CANCELLED_EVENT = "hr.recruitment.disposition_cancelled.v1";
export const MAX_DISPOSITION_ATTEMPTS = 5;

// The stages a knockout rejection may still act on. Anything later means a
// recruiter has engaged with the application; terminal stages need nothing.
export const EARLY_STAGES = Object.freeze(["applied", "screening"]);

const HOUR_MS = 60 * 60 * 1000;
const RETRY_STEP_MS = 15 * 60 * 1000;
const MAX_REASON_LENGTH = 500;
const MAX_ERROR_LENGTH = 500;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

// Loaded lazily: the portal intake imports this module to schedule, and must
// not pull the whole workflow graph in with it; the workflow may also import
// the cancel hook below, which would otherwise be a static import cycle.
const loadWorkflow = () => import("./application-workflow.service.js");

// ── Event ────────────────────────────────────────────────────────────────────

/**
 * hr.recruitment.disposition_cancelled.v1 — ids and vocabulary only. The
 * recruiter's free-text reason stays on the row; the payload carries the
 * reason CLASS (MANUAL | STAGE_CHANGED). Null when the row has no tenant.
 */
export function scheduledDispositionCancelledEvent(row, ctx = {}, { cancelReasonCode = "MANUAL", cancelledById = null } = {}) {
    if (!row?.tenantId) return null;
    return {
        eventName: DISPOSITION_CANCELLED_EVENT,
        tenantId: row.tenantId,
        aggregateType: "ScheduledDisposition",
        aggregateId: row.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            scheduledDispositionId: String(row.id),
            applicationId: String(row.applicationId),
            source: row.source,
            reasonCode: row.reasonCode,
            status: DISPOSITION_STATUS.CANCELLED,
            cancelReasonCode,
            cancelledById: cancelledById != null ? String(cancelledById) : null,
        },
    };
}

// ── Scheduling (called inside the intake transaction) ───────────────────────

/**
 * Make sure the tenant can resolve the disposition's reason code. A fresh
 * tenant gets the whole default taxonomy (the same seed the screening service
 * applies on first use — seeding only one code would stop that seed from ever
 * running); a tenant with codes but without this one gets it at version 1.
 * skipDuplicates keeps two concurrent first intakes from colliding.
 */
export async function ensureDispositionReasonCode(tx, tenantId, code = KNOCKOUT_REASON_CODE) {
    const seeded = await tx.dispositionReasonCode.findFirst({ where: { tenantId }, select: { id: true } });
    if (seeded) {
        const existing = await tx.dispositionReasonCode.findFirst({ where: { tenantId, code }, select: { id: true } });
        if (existing) return;
    }
    const rows = seeded ? DEFAULT_DISPOSITION_REASONS.filter((r) => r.code === code) : DEFAULT_DISPOSITION_REASONS;
    if (!rows.length) return;
    await tx.dispositionReasonCode.createMany({
        data: rows.map((r) => ({
            tenantId,
            code: r.code,
            label: r.label,
            requiresNotes: r.requiresNotes,
            version: 1,
            isActive: true,
        })),
        skipDuplicates: true,
    });
}

/**
 * Schedule the knockout rejection for a just-created application. Runs on the
 * intake's transaction so the application and its pending disposition commit
 * together. Idempotent on (application, KNOCKOUT).
 */
export async function scheduleKnockoutDisposition(tx, { tenantId, applicationId, questionIds = [], delayHours, now = new Date() } = {}) {
    await ensureDispositionReasonCode(tx, tenantId, KNOCKOUT_REASON_CODE);
    const hours = Number(delayHours);
    const delay = Number.isFinite(hours) && hours >= 0 ? hours : RECRUITMENT_SETTINGS_DEFAULTS.knockoutDelayHours;
    return tx.scheduledDisposition.upsert({
        where: { applicationId_source: { applicationId, source: DISPOSITION_SOURCE.KNOCKOUT } },
        create: {
            tenantId,
            applicationId,
            source: DISPOSITION_SOURCE.KNOCKOUT,
            reasonCode: KNOCKOUT_REASON_CODE,
            status: DISPOSITION_STATUS.PENDING,
            executeAt: new Date(new Date(now).getTime() + delay * HOUR_MS),
            // ids only — the answers themselves stay on application_answers
            detail: { questionIds: questionIds.map(Number) },
        },
        update: {},
    });
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/** Move one PENDING row to CANCELLED (guarded) and announce it. */
async function cancelRow(tx, row, { actorId = null, cancelReason, cancelReasonCode, now = new Date() }) {
    const { count } = await tx.scheduledDisposition.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: DISPOSITION_STATUS.PENDING },
        data: {
            status: DISPOSITION_STATUS.CANCELLED,
            cancelledAt: now,
            cancelledById: actorId,
            cancelReason,
        },
    });
    if (!count) return false;
    await enqueueHrDomainEvent(
        tx,
        scheduledDispositionCancelledEvent(row, eventContext({ actorId }), { cancelReasonCode, cancelledById: actorId }),
    );
    return true;
}

/**
 * The stage-change hook: a recruiter moved the application by hand, so any
 * pending system disposition is moot. Runs on the caller's transaction.
 * @returns {Promise<number>} how many were cancelled
 */
export async function cancelPendingDispositionsForApplication(tx, { tenantId, applicationId, actorId = null } = {}) {
    const pending = await tx.scheduledDisposition.findMany({
        where: withTenant(tenantId, { applicationId: Number(applicationId), status: DISPOSITION_STATUS.PENDING }),
    });
    let cancelled = 0;
    for (const row of pending) {
        if (await cancelRow(tx, row, { actorId, cancelReason: STAGE_CHANGED, cancelReasonCode: STAGE_CHANGED })) cancelled += 1;
    }
    return cancelled;
}

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A recruiter overrules a pending disposition. ORG scope only, a reason is
 * required, and only a PENDING row can be cancelled.
 *
 * @param {{ id?: number, applicationId?: number, tenantId: string, actorId?: number|null, reason: string, scope?: object }} args
 */
export async function cancelScheduledDisposition({ id, applicationId, tenantId, actorId = null, reason, scope = null } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    if (scope && scope.unrestricted !== true) {
        throw fail("Only recruiters can cancel a scheduled disposition", 403, "HR-RECRUITMENT-DISPOSITION-FORBIDDEN");
    }
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text) throw fail("A reason is required to cancel a scheduled disposition", 400, "HR-RECRUITMENT-DISPOSITION-REASON-REQUIRED");
    if (text.length > MAX_REASON_LENGTH) {
        throw fail(`The reason must be at most ${MAX_REASON_LENGTH} characters`, 400, "HR-RECRUITMENT-DISPOSITION-REASON-REQUIRED");
    }
    const rowId = positiveInt(id);
    const appId = positiveInt(applicationId);
    if (!rowId && !appId) throw fail("id or applicationId is required", 400, "HR-RECRUITMENT-DISPOSITION-ID-REQUIRED");

    return tenantTransaction(
        prisma,
        async (tx) => {
            const row = await tx.scheduledDisposition.findFirst({
                where: withTenant(tenantId, rowId ? { id: rowId } : { applicationId: appId, source: DISPOSITION_SOURCE.KNOCKOUT }),
            });
            if (!row) throw fail("Scheduled disposition not found", 404, "HR-RECRUITMENT-DISPOSITION-NOT-FOUND");
            const notPending = () =>
                fail(`The scheduled disposition is ${row.status.toLowerCase()} and can no longer be cancelled`, 409, "HR-RECRUITMENT-DISPOSITION-NOT-PENDING");
            if (row.status !== DISPOSITION_STATUS.PENDING) throw notPending();
            const actor = positiveInt(actorId);
            const done = await cancelRow(tx, row, { actorId: actor, cancelReason: text, cancelReasonCode: "MANUAL" });
            // Lost a race with the job (or another recruiter) between read and write.
            if (!done) throw notPending();
            return await tx.scheduledDisposition.findFirst({ where: withTenant(tenantId, { id: row.id }) });
        },
        { tenantId },
    );
}

// ── Read ─────────────────────────────────────────────────────────────────────

const LIST_SELECT = Object.freeze({
    id: true,
    applicationId: true,
    source: true,
    reasonCode: true,
    status: true,
    executeAt: true,
    detail: true,
    attempts: true,
    lastError: true,
    executedAt: true,
    cancelledAt: true,
    cancelledById: true,
    cancelReason: true,
    createdAt: true,
    application: { select: { candidateId: true, jobRequisitionId: true, stage: true } },
});

/**
 * Scheduled dispositions the caller can see, cut by applicationScopeWhere.
 * The internal error text is for ORG callers; the free-text cancel reason
 * follows the internal-notes rule.
 */
export async function listScheduledDispositions({ tenantId, scope, requisitionId, applicationId, status, page = 1, limit = 50 } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
    const reqId = positiveInt(requisitionId);
    const where = withTenant(tenantId, {
        ...(status ? { status: String(status).trim().toUpperCase() } : {}),
        ...(positiveInt(applicationId) ? { applicationId: positiveInt(applicationId) } : {}),
        application: {
            is: {
                ...(scope ? applicationScopeWhere(scope) : {}),
                ...(reqId ? { jobRequisitionId: reqId } : {}),
            },
        },
    });
    const [rows, total] = await Promise.all([
        prisma.scheduledDisposition.findMany({ where, select: LIST_SELECT, orderBy: [{ executeAt: "asc" }, { id: "asc" }], skip, take }),
        prisma.scheduledDisposition.count({ where }),
    ]);
    const showErrors = !scope || scope.unrestricted === true;
    const showNotes = !scope || scope.canSeeInternalNotes === true;
    const items = rows.map(({ application, ...row }) => ({
        ...row,
        candidateId: application?.candidateId ?? null,
        requisitionId: application?.jobRequisitionId ?? null,
        stage: application?.stage ?? null,
        lastError: showErrors ? row.lastError : null,
        cancelReason: showNotes ? row.cancelReason : null,
    }));
    return { items, total, page: Math.max(Number(page) || 1, 1), limit: take };
}

// ── The job ──────────────────────────────────────────────────────────────────

/** Execute (or cancel) one claimed row on its own tenant transaction. */
async function executeOne(row, now) {
    const { transitionApplicationStage } = await loadWorkflow();
    // Prisma queries are lazy: every callback awaits inside the context, so the
    // query runs while the tenant context (and its RLS GUC) is still active.
    return mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
        await tenantTransaction(
            prisma,
            async (tx) => {
                // The claim: whichever run flips PENDING first owns the row; a
                // concurrent run's update re-checks the status and matches nothing.
                const claim = await tx.scheduledDisposition.updateMany({
                    where: { id: row.id, tenantId: row.tenantId, status: DISPOSITION_STATUS.PENDING, executeAt: { lte: now } },
                    data: { status: DISPOSITION_STATUS.EXECUTED, executedAt: now },
                });
                if (!claim.count) return "skipped";

                const application = await tx.application.findFirst({
                    where: withTenant(row.tenantId, { id: row.applicationId }),
                    select: { id: true, stage: true },
                });
                if (!application || !EARLY_STAGES.includes(application.stage)) {
                    await tx.scheduledDisposition.update({
                        where: { id: row.id },
                        data: { status: DISPOSITION_STATUS.CANCELLED, executedAt: null, cancelledAt: now, cancelReason: STAGE_CHANGED },
                    });
                    await enqueueHrDomainEvent(
                        tx,
                        scheduledDispositionCancelledEvent(row, eventContext({}), { cancelReasonCode: STAGE_CHANGED }),
                    );
                    return "cancelled";
                }

                // The recruiter's path: same transition table, reason, history
                // row and stage_changed event; a system actor (null).
                await transitionApplicationStage({
                    id: application.id,
                    tenantId: row.tenantId,
                    targetStage: "rejected",
                    reason: row.reasonCode,
                    actorId: null,
                    source: KNOCKOUT_STAGE_SOURCE,
                    db: tx,
                });
                return "executed";
            },
            { tenantId: row.tenantId },
        ),
    );
}

/** The failed execution rolled back; count the attempt and decide retry vs FAILED. */
async function recordFailure(row, err, now) {
    const attempts = (row.attempts ?? 0) + 1;
    const exhausted = attempts >= MAX_DISPOSITION_ATTEMPTS;
    const lastError = `${err?.code ? `${err.code}: ` : ""}${err?.message ?? "unknown error"}`.slice(0, MAX_ERROR_LENGTH);
    await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
        await tenantTransaction(
            prisma,
            async (tx) =>
                await tx.scheduledDisposition.updateMany({
                    where: { id: row.id, tenantId: row.tenantId, status: DISPOSITION_STATUS.PENDING },
                    data: {
                        attempts,
                        lastError,
                        ...(exhausted
                            ? { status: DISPOSITION_STATUS.FAILED }
                            : { executeAt: new Date(now.getTime() + RETRY_STEP_MS * attempts) }),
                    },
                }),
            { tenantId: row.tenantId },
        ),
    );
    return exhausted;
}

/**
 * Execute every due PENDING disposition across tenants.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<{ skipped: "FLAG_OFF" } | { scanned:number, executed:number, cancelled:number, skipped:number, retried:number, failed:number }>}
 */
export async function runScheduledDispositionJob({ now = new Date(), limit = 100 } = {}) {
    if (!isRecruitmentFlagEnabled("knockout")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const summary = { scanned: 0, executed: 0, cancelled: 0, skipped: 0, retried: 0, failed: 0 };

    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.scheduledDisposition.findMany({
            where: { status: DISPOSITION_STATUS.PENDING, executeAt: { lte: at } },
            select: { id: true, tenantId: true, applicationId: true, source: true, reasonCode: true, attempts: true },
            orderBy: [{ executeAt: "asc" }, { id: "asc" }],
            take,
        }),
    );
    summary.scanned = due.length;

    for (const row of due) {
        try {
            const outcome = await executeOne(row, at);
            summary[outcome] += 1;
        } catch (err) {
            // One bad row never stops the run.
            logger.warn(
                { component: COMPONENT, scheduledDispositionId: row.id, tenantId: row.tenantId, code: err?.code, errMessage: err?.message },
                "scheduled disposition failed",
            );
            try {
                const exhausted = await recordFailure(row, err, at);
                summary[exhausted ? "failed" : "retried"] += 1;
            } catch (recordErr) {
                logger.error({ component: COMPONENT, scheduledDispositionId: row.id, errMessage: recordErr?.message }, "scheduled disposition: could not record the failure");
                summary.retried += 1;
            }
        }
    }
    if (summary.scanned) logger.info({ component: COMPONENT, ...summary }, "scheduled disposition run");
    return summary;
}

export default {
    scheduleKnockoutDisposition,
    cancelScheduledDisposition,
    cancelPendingDispositionsForApplication,
    listScheduledDispositions,
    runScheduledDispositionJob,
};
