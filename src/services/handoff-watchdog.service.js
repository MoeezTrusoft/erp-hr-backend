// src/services/handoff-watchdog.service.js
//
// Recruitment Phase 4 — "failures page someone", including the failure that
// never reports itself.
//
// runOfferHandoff marks its offer_handoffs row IN_PROGRESS, provisions in one
// transaction, then writes COMPLETED or FAILED. A process that dies between
// the mark and the outcome (a deploy, an OOM kill, a lost connection) leaves
// the row IN_PROGRESS forever: nothing was provisioned (the transaction rolled
// back), nobody was told, and the failed-handoff counter never moved, so the
// alert in observability/alerts/recruitment-onboarding.rules.yml could not
// fire for it.
//
// runHandoffWatchdogJob settles those rows the same way the handoff's own
// failure path does: a row IN_PROGRESS for longer than 30 minutes (far beyond
// any handoff transaction) becomes FAILED with lastError "stalled", gets a
// FAILED attempt row and announces hr.recruitment.handoff_failed.v1 (the
// existing builder, routed to the offer's recruiter) in the same transaction,
// and the handoff counter records "failed" once the write commits. The claim
// is a conditional update on (IN_PROGRESS, not touched since the cutoff), so a
// handoff retried meanwhile, or a second watchdog, is never double-settled.
// hr_offer_handoff_retry recovers the row as usual.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordHandoff } from "../lib/recruitmentOpsMetrics.js";
import { HANDOFF_STATUS } from "./recruitmentHandoff.service.js";
import { offerHandoffFailedEvent } from "./hrEvents.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const log = logger.child({ component: "handoff-watchdog" });

export const HANDOFF_STALL_MS = 30 * 60 * 1000;
export const STALLED_ERROR = "stalled";
// The same step label the handoff's own failure path records.
const FAILED_STEP = "provision";

export const DEFAULT_WATCHDOG_LIMIT = 100;
const MAX_WATCHDOG_LIMIT = 500;

const clampLimit = (limit) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : DEFAULT_WATCHDOG_LIMIT;
    return n <= 0 ? DEFAULT_WATCHDOG_LIMIT : Math.min(n, MAX_WATCHDOG_LIMIT);
};

/** Settle one stalled handoff under its tenant: "failed" or "raceLost". */
async function settleOne(tenantId, handoffId, cutoff) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const claim = await tx.offerHandoff.updateMany({
                where: withTenant(tenantId, { id: handoffId, status: HANDOFF_STATUS.IN_PROGRESS, updated_at: { lt: cutoff } }),
                data: { status: HANDOFF_STATUS.FAILED, lastError: STALLED_ERROR },
            });
            if (Number(claim?.count ?? 0) !== 1) return "raceLost";
            const row = await tx.offerHandoff.findFirst({ where: withTenant(tenantId, { id: handoffId }) });
            await tx.offerHandoffAttempt.create({
                data: { handoffId, tenantId, step: FAILED_STEP, status: "FAILED", error: STALLED_ERROR },
            });
            const offer = row?.offerId != null
                ? await tx.offer.findFirst({ where: withTenant(tenantId, { id: row.offerId }), select: { createdById: true } })
                : null;
            await enqueueHrDomainEvent(
                tx,
                offerHandoffFailedEvent(
                    { ...row, tenantId },
                    { actorId: null },
                    // The offer's recruiter chases provisioning; never the hire.
                    { step: FAILED_STEP, operatorId: offer?.createdById != null ? String(offer.createdById) : null },
                ),
            );
            return "failed";
        },
        { tenantId },
    );
}

/**
 * One watchdog pass over every tenant's stalled handoffs.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<object>} { scanned, failed, raceLost, errors }, or { skipped: "FLAG_OFF" }
 */
export async function runHandoffWatchdogJob({ now = new Date(), limit } = {}) {
    // The watchdog belongs to the handoff: off with it.
    if (!isRecruitmentFlagEnabled("offerHandoff")) return { skipped: "FLAG_OFF" };
    const cutoff = new Date(new Date(now).getTime() - HANDOFF_STALL_MS);
    const summary = { scanned: 0, failed: 0, raceLost: 0, errors: 0 };

    const stalled = await mcpCtx.run({ system: true }, async () =>
        await prisma.offerHandoff.findMany({
            where: { status: HANDOFF_STATUS.IN_PROGRESS, updated_at: { lt: cutoff } },
            select: { id: true, tenantId: true },
            orderBy: [{ updated_at: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = stalled.length;

    for (const row of stalled) {
        if (!row.tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () => await settleOne(row.tenantId, row.id, cutoff));
            summary[outcome] += 1;
            // After commit, so the alert counts exactly the rows settled.
            if (outcome === "failed") {
                recordHandoff("failed");
                log.warn({ tenantId: row.tenantId, handoffId: row.id }, "handoff watchdog: stalled handoff marked FAILED");
            }
        } catch (err) {
            summary.errors += 1;
            log.error({ tenantId: row.tenantId, handoffId: row.id, code: err?.code, errMessage: err?.message }, "handoff watchdog: row failed");
        }
    }
    if (summary.scanned) log.info(summary, "handoff watchdog: pass done");
    return summary;
}
