// src/services/offer-expiry.service.js
//
// Recruitment Phase 3a — offer EXPIRY: the reminder before an offer lapses,
// the automatic expiry, and the recruiter's extension.
//
// "Remind the candidate 3 days before expiry; set EXPIRED at expiryDate; notify
// the recruiter. Recruiter may extend."
//
// The sweep (runOfferExpiryJob, hourly) is behind flag offerExpiry (env
// HR_RECRUITMENT_OFFER_EXPIRY, default OFF: the first run expires every SENT
// offer already past its date, so a tenant switches it on after review). The
// extension is a recruiter action on an existing status and is always on.
//
// REMINDER. A SENT offer whose expiryDate falls inside the tenant's
// offerReminderDays (settings) and is still in the future gets
// expiryReminderSentAt stamped and hr.recruitment.offer_expiry_reminder.v1 in
// the same transaction. The stamp is the claim: the conditional update only
// matches an unstamped row with the same expiryDate, so two runs (or a run
// racing an extension) remind at most once per expiry date. The candidate
// communication module maps the event to a candidate template and applies its
// own consent / do-not-contact gate at delivery.
//
// EXPIRY. A SENT offer whose expiryDate has passed becomes EXPIRED (expiredAt,
// version bump) with hr.recruitment.offer_expired.v1, which names the owning
// recruiter (createdById, and the requisition's recruiterId) so the hub can
// notify them. The offer code has no generic status-change event (each move
// has its own: offer_sent, offer_accepted, offer_withdrawn), so expiry gets its
// own too. The APPLICATION IS NOT REJECTED: a recruiter disposes it, possibly
// after extending the offer. The update is conditional on status SENT, so a
// candidate's answer that lands first wins and a re-run is a no-op.
//
// EXTENSION. ORG only. A SENT offer gets a later expiryDate (in the future, at
// most 60 days ahead). An EXPIRED offer may be put back to SENT only within 7
// days of expiring, while its requisition is still open (APPROVED or POSTED)
// and its application is still at the offer stage; later than that it is a
// new offer. expiryExtendedCount +1, the reminder stamp is cleared (so the
// candidate is reminded before the new date), version +1, and
// hr.recruitment.offer_expiry_extended.v1.
//
// The extension never touches APPROVED content. expiryDate is one of the
// fields the HR Approval Centre's source guard freezes once an offer is
// approved, and that freeze is the evidence of what the approvers signed off.
// So an offer whose OFFER request stands APPROVED is refused with 409
// HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL: a new expiry needs a new
// approval through the Approval Centre. Only an offer with no approved request
// (one created before approvals were routed there) can be extended here, and an
// expired offer is never reopened without one.

// Per-row isolation and tenancy follow the other recruitment sweeps: tenants
// are found under SYSTEM context, each tenant runs under its own context, each
// row in its own transaction, and one failure is logged and counted, never
// fatal to the rest.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { eventContext } from "../lib/event-context.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";

const log = logger.child({ component: "offer-expiry" });

export const OFFER_EXPIRY_REMINDER_EVENT = "hr.recruitment.offer_expiry_reminder.v1";
export const OFFER_EXPIRED_EVENT = "hr.recruitment.offer_expired.v1";
export const OFFER_EXPIRY_EXTENDED_EVENT = "hr.recruitment.offer_expiry_extended.v1";

export const MAX_EXTENSION_DAYS = 60;
export const REOPEN_WINDOW_DAYS = 7;
export const OPEN_REQUISITION_STATUSES = Object.freeze(["APPROVED", "POSTED"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDER_DAYS = 30; // the settings CHECK's upper bound
const DEFAULT_LIMIT = 200;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const idStr = (value) => (value != null ? String(value) : null);
const isoStr = (value) => (value ? new Date(value).toISOString() : null);

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Event builders (ids-only, never compensation) ───────────────────────────

const offerEvent = (eventName, offer, ctx, payload) => {
    const tenantId = offer?.tenantId ?? null;
    if (!tenantId) return null;
    return {
        eventName,
        tenantId,
        aggregateType: "Offer",
        aggregateId: offer?.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload,
    };
};

export function offerExpiryReminderEvent(offer, ctx = {}) {
    return offerEvent(OFFER_EXPIRY_REMINDER_EVENT, offer, ctx, {
        offerId: String(offer?.id),
        applicationId: idStr(offer?.applicationId),
        candidateId: idStr(offer?.candidateId),
        expiryDate: isoStr(offer?.expiryDate),
    });
}

export function offerExpiredEvent(offer, ctx = {}) {
    return offerEvent(OFFER_EXPIRED_EVENT, offer, ctx, {
        offerId: String(offer?.id),
        applicationId: idStr(offer?.applicationId),
        candidateId: idStr(offer?.candidateId),
        jobRequisitionId: idStr(offer?.jobRequisitionId),
        status: "EXPIRED",
        previousStatus: "SENT",
        version: offer?.version ?? null,
        expiryDate: isoStr(offer?.expiryDate),
        expiredAt: isoStr(offer?.expiredAt),
        createdById: idStr(offer?.createdById),
        recruiterId: idStr(offer?.recruiterId),
    });
}

export function offerExpiryExtendedEvent(offer, ctx = {}, extra = {}) {
    return offerEvent(OFFER_EXPIRY_EXTENDED_EVENT, offer, ctx, {
        offerId: String(offer?.id),
        applicationId: idStr(offer?.applicationId),
        candidateId: idStr(offer?.candidateId),
        jobRequisitionId: idStr(offer?.jobRequisitionId),
        status: offer?.status ?? null,
        version: offer?.version ?? null,
        previousExpiryDate: isoStr(extra?.previousExpiryDate),
        expiryDate: isoStr(offer?.expiryDate),
        expiryExtendedCount: offer?.expiryExtendedCount ?? null,
        reopened: extra?.reopened === true,
        createdById: idStr(offer?.createdById),
    });
}

// ── Sweep ───────────────────────────────────────────────────────────────────

const SWEEP_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    candidateId: true,
    jobRequisitionId: true,
    expiryDate: true,
    createdById: true,
    jobRequisition: { select: { recruiterId: true } },
});

async function expireOne(tenantId, row, now) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            // The claim: only a still-SENT, still-past-due row moves.
            const { count } = await tx.offer.updateMany({
                where: withTenant(tenantId, { id: row.id, status: "SENT", expiryDate: { lte: now } }),
                data: { status: "EXPIRED", expiredAt: now, version: { increment: 1 } },
            });
            if (count !== 1) return false;
            const fresh = await tx.offer.findFirst({ where: withTenant(tenantId, { id: row.id }) });
            await enqueueHrDomainEvent(
                tx,
                offerExpiredEvent({
                    ...row,
                    ...(fresh ?? {}),
                    tenantId: fresh?.tenantId ?? tenantId,
                    expiredAt: fresh?.expiredAt ?? now,
                    recruiterId: row.jobRequisition?.recruiterId ?? null,
                }),
            );
            return true;
        },
        { tenantId },
    );
}

async function remindOne(tenantId, row, now) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            // Same expiryDate as read: an extension in between is reminded for
            // its own date on a later run, not stamped by this one.
            const { count } = await tx.offer.updateMany({
                where: withTenant(tenantId, {
                    id: row.id,
                    status: "SENT",
                    expiryReminderSentAt: null,
                    expiryDate: row.expiryDate,
                }),
                data: { expiryReminderSentAt: now },
            });
            if (count !== 1) return false;
            await enqueueHrDomainEvent(tx, offerExpiryReminderEvent({ ...row, tenantId: row.tenantId ?? tenantId }));
            return true;
        },
        { tenantId },
    );
}

async function eachRow(rows, fn, summary, okKey, label) {
    for (const row of rows) {
        try {
            if (await fn(row)) summary[okKey] += 1;
            else summary.skipped += 1;
        } catch (err) {
            summary.failed += 1;
            log.error({ errMessage: err?.message, offerId: row.id, tenantId: row.tenantId }, `offer expiry: ${label} failed`);
        }
    }
}

/**
 * One tenant's expiries then reminders (an offer past its date is expired, not
 * reminded). Runs under that tenant's context.
 */
export async function sweepTenantOfferExpiry({ tenantId, now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    const at = new Date(now);
    const summary = { expired: 0, reminded: 0, skipped: 0, failed: 0 };

    const due = await prisma.offer.findMany({
        where: withTenant(tenantId, { status: "SENT", expiryDate: { lte: at } }),
        select: SWEEP_SELECT,
        orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
        take: limit,
    });
    await eachRow(due, (row) => expireOne(tenantId, row, at), summary, "expired", "expire");

    const settings = await getRecruitmentSettings({ tenantId });
    const days = Math.min(Math.max(Number(settings?.offerReminderDays) || 0, 0), MAX_REMINDER_DAYS);
    if (days > 0) {
        const windowEnd = new Date(at.getTime() + days * DAY_MS);
        const upcoming = await prisma.offer.findMany({
            where: withTenant(tenantId, { status: "SENT", expiryReminderSentAt: null, expiryDate: { gt: at, lte: windowEnd } }),
            select: SWEEP_SELECT,
            orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
            take: limit,
        });
        await eachRow(upcoming, (row) => remindOne(tenantId, row, at), summary, "reminded", "reminder");
    }
    return summary;
}

/**
 * Scheduled job (hourly). Flag offerExpiry. Finds the tenants with SENT offers
 * expiring inside the widest reminder window under SYSTEM context, then sweeps
 * each under its own tenant context.
 */
export async function runOfferExpiryJob({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("offerExpiry")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const horizon = new Date(at.getTime() + MAX_REMINDER_DAYS * DAY_MS);

    // Prisma queries are lazy: await inside the callback so the query runs
    // under the SYSTEM context.
    const tenantRows = await mcpCtx.run({ system: true }, async () =>
        await prisma.offer.findMany({
            where: { tenantId: { not: null }, status: "SENT", expiryDate: { lte: horizon } },
            select: { tenantId: true },
            distinct: ["tenantId"],
        }),
    );
    const tenants = tenantRows.map((row) => row.tenantId).filter(Boolean);

    const totals = { expired: 0, reminded: 0, skipped: 0, failed: 0 };
    const perTenant = [];
    for (const tenantId of tenants) {
        try {
            const result = await mcpCtx.run({ user: { tenantId } }, async () =>
                await sweepTenantOfferExpiry({ tenantId, now: at, limit }),
            );
            for (const key of Object.keys(totals)) totals[key] += result[key];
            perTenant.push({ tenantId, ...result });
        } catch (err) {
            log.error({ errMessage: err?.message, tenantId }, "offer expiry: tenant failed");
            perTenant.push({ tenantId, error: err?.message ?? "unknown" });
        }
    }
    log.info({ tenants: tenants.length, ...totals }, "offer expiry job: done");
    return { tenants: tenants.length, ...totals, perTenant };
}

// ── Extension ───────────────────────────────────────────────────────────────

function parseNewExpiry(expiryDate, now) {
    const date = expiryDate instanceof Date ? new Date(expiryDate) : new Date(String(expiryDate ?? ""));
    if (!expiryDate || Number.isNaN(date.getTime())) {
        throw fail("expiryDate must be a valid ISO 8601 date", 400, "HR-RECRUITMENT-OFFER-EXPIRY-INVALID");
    }
    if (date.getTime() <= now.getTime()) {
        throw fail("The new expiryDate must be in the future", 400, "HR-RECRUITMENT-OFFER-EXPIRY-INVALID");
    }
    if (date.getTime() > now.getTime() + MAX_EXTENSION_DAYS * DAY_MS) {
        throw fail(`The new expiryDate may be at most ${MAX_EXTENSION_DAYS} days ahead`, 400, "HR-RECRUITMENT-OFFER-EXPIRY-INVALID");
    }
    return date;
}

// Which moves the extension allows; throws the refusal otherwise.
function assertExtendable(offer, newExpiry, now) {
    if (offer.status === "SENT") {
        if (offer.expiryDate && newExpiry.getTime() <= new Date(offer.expiryDate).getTime()) {
            throw fail("The new expiryDate must be later than the current one", 400, "HR-RECRUITMENT-OFFER-EXPIRY-INVALID");
        }
        return { reopen: false };
    }
    if (offer.status !== "EXPIRED") {
        throw fail(`Only a SENT or recently EXPIRED offer can be extended (current status: ${offer.status})`, 409, "HR-RECRUITMENT-OFFER-STATUS");
    }
    const expiredAt = offer.expiredAt ? new Date(offer.expiredAt).getTime() : null;
    if (expiredAt == null || now.getTime() - expiredAt > REOPEN_WINDOW_DAYS * DAY_MS) {
        throw fail(
            `An offer can be reopened only within ${REOPEN_WINDOW_DAYS} days of expiring; create a new offer instead`,
            409,
            "HR-RECRUITMENT-OFFER-EXTEND-WINDOW-CLOSED",
        );
    }
    if (!OPEN_REQUISITION_STATUSES.includes(offer.jobRequisition?.status)) {
        throw fail("The requisition is no longer open; the offer cannot be reopened", 409, "HR-RECRUITMENT-OFFER-REQUISITION-CLOSED");
    }
    if (offer.application && offer.application.stage !== "offer") {
        throw fail("The application has been moved on from the offer stage; the offer cannot be reopened", 409, "HR-RECRUITMENT-OFFER-APPLICATION-DISPOSED");
    }
    return { reopen: true };
}

// An approved offer's expiry is frozen by the Approval Centre (see header):
// refuse rather than write around the freeze.
async function assertNoStandingApproval(tx, tenantId, offerId, reopen) {
    const approval = await tx.hrApprovalRequest.findUnique({
        where: { tenantId_kind_sourceRef: { tenantId, kind: "OFFER", sourceRef: String(offerId) } },
        select: { id: true, stage: true },
    });
    if (approval?.stage === "APPROVED") {
        throw fail(
            "This offer's terms were approved in the HR Approval Centre; a new expiry date needs a new approval there",
            409,
            "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL",
        );
    }
    if (reopen) {
        throw fail("The offer's approval no longer stands; send a new offer through the HR Approval Centre", 409, "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED");
    }
}

/**
 * hr_offer_expiry_extend. ORG only; an optional expectedVersion is the
 * optimistic-concurrency guard (412 when stale).
 *
 * @param {{ tenantId: string, id: number|string, expiryDate: string|Date, expectedVersion?: number, scope?: object, actorId?: number|null, now?: Date }} args
 */
export async function extendOfferExpiry({ tenantId, id, expiryDate, expectedVersion, scope = null, actorId = null, now = new Date() } = {}) {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    if (scope && scope.unrestricted !== true) {
        throw fail("Only recruiters can extend an offer", 403, "HR-RECRUITMENT-OFFER-EXTEND-FORBIDDEN");
    }
    const offerId = positiveInt(id);
    if (!offerId) throw fail("A valid offer id is required", 400, "HR-RECRUITMENT-OFFER-ID-REQUIRED");
    const at = new Date(now);
    const newExpiry = parseNewExpiry(expiryDate, at);
    const expected = normalizeExpectedVersion(expectedVersion);

    return tenantTransaction(
        prisma,
        async (tx) => {
            // Serialize with respond / expiry on the same row.
            await tx.$queryRaw`SELECT id FROM "offers" WHERE id=${offerId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
            const offer = await tx.offer.findFirst({
                where: withTenant(tenantId, { id: offerId }),
                include: { application: { select: { stage: true } }, jobRequisition: { select: { status: true } } },
            });
            if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
            if (expected != null && offer.version !== expected) throw preconditionFailedError(offer.version);

            const { reopen } = assertExtendable(offer, newExpiry, at);
            // Extending keeps the offer in front of the candidate: same gate as a send.
            await assertCommunicationsAllowed({ tenantId, candidateId: offer.candidateId, purpose: "PROCESSING" }, { db: tx });
            await assertNoStandingApproval(tx, tenantId, offerId, reopen);

            const { count } = await tx.offer.updateMany({
                where: withTenant(tenantId, { id: offerId, status: offer.status, version: offer.version }),
                data: {
                    expiryDate: newExpiry,
                    expiryExtendedCount: { increment: 1 },
                    expiryReminderSentAt: null,
                    version: { increment: 1 },
                    ...(reopen ? { status: "SENT", expiredAt: null } : {}),
                },
            });
            if (count !== 1) throw preconditionFailedError(offer.version);
            const fresh = await tx.offer.findFirst({ where: withTenant(tenantId, { id: offerId }) });
            await enqueueHrDomainEvent(
                tx,
                offerExpiryExtendedEvent(
                    { ...fresh, tenantId: fresh?.tenantId ?? tenantId },
                    eventContext({ actorId }),
                    { previousExpiryDate: offer.expiryDate, reopened: reopen },
                ),
            );
            return { ...fresh, reopened: reopen, previousExpiryDate: offer.expiryDate ?? null };
        },
        { tenantId },
    );
}
