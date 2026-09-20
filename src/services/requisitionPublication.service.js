// src/services/requisitionPublication.service.js
//
// Phase 4 / decision record §2.4 + §2.4a — publication and withdrawal.
//
// The three operations here are deliberately NOT symmetrical, because the
// decision is not:
//
//   * `publishRequisition` is a STATE MOVE (APPROVED → POSTED) on the first
//     channel and an ADDITIVE act on the rest. It goes through the same
//     transition guard and freeze guard as every other advance, so a hiring freeze
//     blocks publication from all four entry points including this one.
//   * `unpublishPosting` closes ONE channel and deliberately leaves the
//     requisition POSTED — "unpublishing a single channel does not close the
//     requisition" (§2.4a). The posting row itself carries who/when/why, which is
//     why no requisition transition row is written for it: the status did not
//     change, and a from==to row in the transition log would read as one.
//   * `withdrawRequisition` is terminal, requires a CODED reason, and closes
//     EVERY active posting in the same transaction, so a withdrawn requisition can
//     never be left advertising itself on a job board.
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { requisitionPostedEvent, requisitionClosedEvent } from "./hrEvents.js";
import {
    assertRequisitionTransition,
    assertRequisitionAdvanceAllowed,
    recordRequisitionTransition,
} from "./requisitionWorkflow.service.js";
import {
    assertPublishableStatus,
    normalizeChannelList,
    normalizePostingCloseReason,
    normalizeWithdrawalReason,
} from "../lib/requisitionPublication.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const actorIdOf = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const POSTING_SELECT = Object.freeze({
    id: true,
    requisitionId: true,
    channel: true,
    channelRef: true,
    externalUrl: true,
    isActive: true,
    postedAt: true,
    postedById: true,
    closedAt: true,
    closeReason: true,
    closedById: true,
});

/** Tenant-scoped requisition read; 404 rather than leaking another tenant's id. */
const requireRequisition = async (tx, id, tenantId) => {
    const requisition = await tx.jobRequisition.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
    });
    if (!requisition) {
        throw fail(`Requisition ${id} not found`, 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    }
    return requisition;
};

/**
 * Publish an approved requisition to one or more channels.
 *
 * Idempotent per channel in the way that matters: an already-ACTIVE posting on a
 * channel is left alone and reported as `unchanged` rather than duplicated, and
 * re-publishing a channel that was previously closed opens a NEW posting (the
 * unique index allows it because the old row is no longer active). That keeps the
 * posting history (when it was live, on what URL, who closed it and why) instead
 * of mutating one row forever.
 */
export const publishRequisition = async ({
    id,
    postingChannels,
    externalUrl = null,
    channelRef = null,
    actorId = null,
    tenantId = null,
} = {}) => {
    const placements = normalizeChannelList(postingChannels, { externalUrl, channelRef });

    // Read + guards OUTSIDE the transaction so a refused publication never opens
    // one. The status is re-read INSIDE the transaction before the flip, so a
    // raced approve/withdraw cannot be published over.
    const pre = await requireRequisition(prisma, id, tenantId);
    assertPublishableStatus(pre.status);
    await assertRequisitionAdvanceAllowed(tenantId, pre, "POSTED");

    const actor = actorIdOf(actorId);

    return tenantTransaction(prisma, async (tx) => {
        const requisition = await requireRequisition(tx, id, tenantId);
        assertPublishableStatus(requisition.status);

        const created = [];
        const unchanged = [];
        for (const placement of placements) {
            const active = await tx.jobPosting.findFirst({
                where: scopedWhere(tenantId, {
                    requisitionId: Number(id),
                    channel: placement.channel,
                    isActive: true,
                }),
                select: POSTING_SELECT,
            });
            if (active) {
                unchanged.push(active);
                continue;
            }
            created.push(
                await tx.jobPosting.create({
                    data: scopedData(tenantId, {
                        requisitionId: Number(id),
                        channel: placement.channel,
                        channelRef: placement.channelRef,
                        externalUrl: placement.externalUrl,
                        isActive: true,
                        postedAt: new Date(),
                        postedById: actor,
                    }),
                    select: POSTING_SELECT,
                }),
            );
        }

        // POSTED is only reached once. Publishing an ADDITIONAL channel to an
        // already-POSTED requisition must not append a second POSTED transition
        // row, which would make the history claim the requisition was published
        // twice on the same day.
        let updated = requisition;
        if (created.length && requisition.status !== "POSTED") {
            await assertRequisitionTransition(requisition.status, "POSTED", { requisition });
            updated = await tx.jobRequisition.update({
                where: { id: Number(id) },
                data: { status: "POSTED" },
            });
            await recordRequisitionTransition(tx, {
                requisitionId: Number(id),
                tenantId,
                fromStatus: requisition.status,
                toStatus: "POSTED",
                actorId: actor,
                source: "requisition.post",
            });
        }

        if (created.length) {
            await logAction({
                employeeId: actor,
                type: "UPDATE",
                module: "Requisition Post",
                result: "SUCCESS",
                notes: `Requisition "${id}" published to ${created.map((p) => p.channel).join(", ")}`,
                tenantId: typeof tenantId !== "undefined" ? tenantId : null,
            });

            // The primary URL is whichever placement recorded one; the career site
            // has none, so the first external link is what the notice carries.
            const primaryUrl =
                created.find((p) => p.externalUrl)?.externalUrl ?? externalUrl ?? null;
            await enqueueHrDomainEvent(
                tx,
                requisitionPostedEvent(
                    { ...updated, externalUrl: primaryUrl },
                    { actorId: actor },
                ),
            );
        }

        return {
            requisition: updated,
            postings: [...unchanged, ...created].sort((a, b) => a.id - b.id),
            published: created.map((p) => p.channel),
            unchanged: unchanged.map((p) => p.channel),
        };
    });
};

/**
 * Close ONE channel's posting (§2.4a). The requisition stays POSTED.
 *
 * A reason is mandatory and coded. This is the operation a recruiter uses when a
 * role is no longer advertised on one board, so it must not be usable as a
 * silent "take it down everywhere".
 */
export const unpublishPosting = async ({
    postingId = null,
    requisitionId = null,
    channel = null,
    reason,
    note = null,
    actorId = null,
    tenantId = null,
} = {}) => {
    const close = normalizePostingCloseReason(reason, note);
    const actor = actorIdOf(actorId);

    const target = await prisma.jobPosting.findFirst({
        where: scopedWhere(tenantId, {
            ...(postingId ? { id: Number(postingId) } : {}),
            ...(requisitionId ? { requisitionId: Number(requisitionId) } : {}),
            ...(channel ? { channel: String(channel).trim().toUpperCase() } : {}),
            isActive: true,
        }),
        orderBy: { id: "desc" },
    });
    if (!target) {
        throw fail(
            "No active posting matches that channel/requisition",
            404,
            "HR-RECRUITMENT-POSTING-NOT-FOUND",
        );
    }

    return tenantTransaction(prisma, async (tx) => {
        // updateMany with the isActive predicate: two concurrent unpublishes of the
        // same posting must produce ONE closure, not an overwritten one whose
        // closeReason depends on which request arrived last.
        const { count } = await tx.jobPosting.updateMany({
            where: scopedWhere(tenantId, { id: target.id, isActive: true }),
            data: {
                isActive: false,
                closedAt: new Date(),
                closeReason: close.reason,
                closedById: actor,
            },
        });
        if (!count) {
            throw fail(
                "Posting was already closed by another request",
                409,
                "HR-RECRUITMENT-POSTING-ALREADY-CLOSED",
            );
        }

        await logAction({
            employeeId: actor,
            type: "UPDATE",
            module: "Requisition Unpublish",
            result: "SUCCESS",
            notes: `Posting "${target.id}" (${target.channel}) closed: ${close.reason}`,
            tenantId: typeof tenantId !== "undefined" ? tenantId : null,
        });

        return tx.jobPosting.findFirst({ where: scopedWhere(tenantId, { id: target.id }), select: POSTING_SELECT });
    });
};

/**
 * Withdraw a requisition (§2.4a / FR-01.07) — terminal, coded reason, and it
 * closes EVERY active posting in the same transaction.
 *
 * The order matters: the postings close first, then the status flips, so a
 * rollback can never leave a WITHDRAWN requisition still live on a job board.
 * A hiring freeze does NOT block this — closing an in-flight requisition is
 * exactly what a freeze is for (§2.7).
 */
export const withdrawRequisition = async ({
    id,
    reason,
    note = null,
    actorId = null,
    tenantId = null,
} = {}) => {
    const withdrawal = normalizeWithdrawalReason(reason, note);
    const actor = actorIdOf(actorId);
    // The coded reason is the reportable fact and the note is the explanation, so
    // both are preserved in the transition history (which has one text column).
    const historyReason = [withdrawal.reason, withdrawal.note].filter(Boolean).join(" — ");

    const pre = await requireRequisition(prisma, id, tenantId);

    return tenantTransaction(prisma, async (tx) => {
        const requisition = await requireRequisition(tx, id, tenantId);
        assertRequisitionTransition(requisition.status, "WITHDRAWN", {
            comments: historyReason,
            requisition,
        });

        const closedCount = await closeActivePostingsForRequisition(tx, {
            requisitionId: Number(id),
            tenantId,
            closeReason: "REQUISITION_WITHDRAWN",
            actorId: actor,
        });

        const updated = await tx.jobRequisition.update({
            where: { id: Number(id) },
            data: { status: "WITHDRAWN" },
        });

        await recordRequisitionTransition(tx, {
            requisitionId: Number(id),
            tenantId,
            fromStatus: requisition.status,
            toStatus: "WITHDRAWN",
            reason: historyReason,
            actorId: actor,
            source: "requisition.withdraw",
        });

        await logAction({
            employeeId: actor,
            type: "UPDATE",
            module: "Requisition Withdraw",
            result: "SUCCESS",
            notes: `Requisition "${id}" withdrawn (${withdrawal.reason}); ${closedCount} active posting(s) closed`,
            tenantId: typeof tenantId !== "undefined" ? tenantId : null,
        });

        // Reuse the closed event rather than inventing a name no consumer maps:
        // the hub's requisition_closed mapper already carries the reason, and the
        // payload states WITHDRAWN so analytics does not have to guess. A new event
        // name would reach the fabric and find no mapper.
        await enqueueHrDomainEvent(
            tx,
            requisitionClosedEvent(updated, { actorId: actor }, {
                reason: historyReason,
                status: "WITHDRAWN",
            }),
        );

        return {
            requisition: updated,
            closedPostings: closedCount,
            reason: withdrawal.reason,
            preReadFrom: pre.status,
        };
    });
};

/**
 * Close EVERY active posting for a requisition — the shared half of §2.4a's
 * "withdraw/close ... closes all active postings".
 *
 * Exported and takes the caller's transaction client on purpose: WITHDRAWAL is
 * not the only way a requisition stops being advertised (CLOSED does it too, from
 * three different services), and a helper that opened its own transaction could
 * not be joined to the status flip — leaving a window where the requisition reads
 * CLOSED while a job board is still live.
 *
 * Returns the number of postings closed. Deliberately not an error when there are
 * none: closing a requisition that was never published is normal.
 */
export const closeActivePostingsForRequisition = async (
    tx,
    { requisitionId, tenantId = null, closeReason = "REQUISITION_CLOSED", actorId = null, excludePostingId = null } = {},
) => {
    const closedAt = new Date();
    const { count } = await tx.jobPosting.updateMany({
        where: scopedWhere(tenantId, {
            requisitionId: Number(requisitionId),
            isActive: true,
            ...(excludePostingId ? { id: { not: Number(excludePostingId) } } : {}),
        }),
        data: {
            isActive: false,
            closedAt,
            closeReason,
            closedById: actorIdOf(actorId),
        },
    });
    return count;
};

// ── Phase 4 / §2.5 — auto-close when filled ─────────────────────────────────
//
// "A hire happens" and "the requisition should stop advertising" are different
// events at different moments, so NEITHER the hired transition nor this sweep
// closes the requisition as a side effect of the other. The sweep is the one
// place auto-close happens, it only touches requisitions that OPTED IN
// (autoCloseWhenFilled), and it is deliberately NOT irreversible: it stamps
// autoClosedAt and moves the status to CLOSED — a plain state move a human can
// reopen. It never deletes postings, never locks fields, and never touches a
// requisition that did not ask for it.

/**
 * Auto-close every eligible requisition whose required openings are filled.
 *
 * "Filled" means applications in the HIRED stage >= `openings` — the same
 * definition the fill-rate analytics uses, so a dashboard and the sweep cannot
 * disagree about whether a requisition is filled. Returns the closed rows.
 *
 * Designed as a sweep (not a hook on the hired transition) so a backfilled hire,
 * a data fix, or a batch of hires landing out of order all converge on the same
 * outcome without re-running per-hire side effects.
 */
export const autoCloseFilledRequisitions = async ({ tenantId = null, now = new Date() } = {}) => {
    const candidates = await prisma.jobRequisition.findMany({
        where: scopedWhere(tenantId, {
            status: { in: ["APPROVED", "POSTED"] },
            autoCloseWhenFilled: true,
            autoClosedAt: null,
        }),
        select: { id: true, tenantId: true, status: true, openings: true },
    });

    const closed = [];
    for (const requisition of candidates) {
        const hiredCount = await prisma.application.count({
            where: scopedWhere(requisition.tenantId ?? tenantId, {
                jobRequisitionId: requisition.id,
                stage: "hired",
            }),
        });
        if (hiredCount < Number(requisition.openings || 1)) continue;

        const closedAt = now;
        await tenantTransaction(
            prisma,
            async (tx) => {
                // The postings-closure helper is the SAME one close and withdraw
                // use, so an auto-closed requisition leaves no channel advertising.
                const closedPostings = await closeActivePostingsForRequisition(tx, {
                    requisitionId: requisition.id,
                    tenantId: requisition.tenantId ?? tenantId,
                    closeReason: "FILLED",
                    actorId: null,
                });
                const updated = await tx.jobRequisition.update({
                    where: { id: requisition.id },
                    data: { status: "CLOSED", closedAt, autoClosedAt: closedAt },
                });
                await recordRequisitionTransition(tx, {
                    requisitionId: requisition.id,
                    tenantId: requisition.tenantId ?? tenantId,
                    fromStatus: requisition.status,
                    toStatus: "CLOSED",
                    reason: `Auto-closed: all ${requisition.openings} opening(s) filled`,
                    actorId: null,
                    source: "requisition.autoclose",
                });
                await logAction({
                    employeeId: null,
                    type: "UPDATE",
                    module: "Requisition Auto-close",
                    result: "SUCCESS",
                    notes: `Requisition "${requisition.id}" auto-closed (${hiredCount}/${requisition.openings} filled); ${closedPostings} posting(s) closed`,
                    tenantId: requisition.tenantId ?? tenantId,
                });
                await enqueueHrDomainEvent(
                    tx,
                    requisitionClosedEvent(updated, {}, { reason: "AUTO_CLOSED_FILLED" }),
                );
                closed.push({ id: requisition.id, hiredCount, closedPostings });
            },
            { tenantId: requisition.tenantId ?? tenantId },
        );
    }
    return closed;
};

/** Every posting for a requisition, active first. Tenant-scoped read. */
export const listRequisitionPostings = async (id, tenantId, { includeClosed = true } = {}) => {
    const requisition = await requireRequisition(prisma, id, tenantId);
    const postings = await prisma.jobPosting.findMany({
        where: scopedWhere(tenantId, {
            requisitionId: Number(id),
            ...(includeClosed ? {} : { isActive: true }),
        }),
        select: POSTING_SELECT,
        orderBy: [{ isActive: "desc" }, { id: "desc" }],
    });
    return {
        requisitionId: requisition.id,
        status: requisition.status,
        postings,
        activeChannels: postings.filter((p) => p.isActive).map((p) => p.channel),
    };
};
