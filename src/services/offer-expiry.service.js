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
//
// RE-APPROVAL (Phase 6, flag offerExtensionApproval, env
// HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL, default OFF). With the flag on, the
// extension of a SENT offer whose request stands APPROVED is not refused: it
// submits a NEW staged OFFER request to the Approval Centre (line manager, HR,
// management, the same chain and rules as the original) whose sourceRef is
// "<offerId>@x<sequence>.<attempt>.<proposedMs>" (src/lib/offer-extension.util.js
// explains the format). The offer keeps its current expiry while the request
// is open, so the sweep may still expire it. The Centre's applyDecision hands
// the final decision to applyOfferExtensionDecision below, in the decision's
// own transaction: on APPROVE the proposed date is written under the
// finalizing marker the hr_approval_source_guard trigger expects
// ("OFFER:<id>"), conditional on the offer still being SENT at the revision
// the request named; on REJECT nothing changes. A recruiter may withdraw an
// open extension request (withdrawOfferExtension); the offer is unchanged.
// Each decision emits hr.recruitment.offer_expiry_extension_decided.v1
// (ids-only). An EXPIRED offer is still never reopened, flag or not.

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
import {
    OFFER_EXTENSION_OPEN_STAGES,
    buildOfferExtensionRef,
    offerExtensionRefPrefix,
    offerExtensionSequencePrefix,
    parseOfferExtensionRef,
} from "../lib/offer-extension.util.js";
import { createHash } from "node:crypto";

const log = logger.child({ component: "offer-expiry" });

export const OFFER_EXPIRY_REMINDER_EVENT = "hr.recruitment.offer_expiry_reminder.v1";
export const OFFER_EXPIRED_EVENT = "hr.recruitment.offer_expired.v1";
export const OFFER_EXPIRY_EXTENDED_EVENT = "hr.recruitment.offer_expiry_extended.v1";
export const OFFER_EXPIRY_EXTENSION_DECIDED_EVENT = "hr.recruitment.offer_expiry_extension_decided.v1";

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

/**
 * Phase 6 — the Approval Centre's final word on an extension request:
 * decision APPROVED (the new expiry is applied), REJECTED or WITHDRAWN (the
 * offer is unchanged). Routed to the offer's creator and the requisition's
 * recruiter.
 */
export function offerExpiryExtensionDecidedEvent(offer, ctx = {}, extra = {}) {
    return offerEvent(OFFER_EXPIRY_EXTENSION_DECIDED_EVENT, offer, ctx, {
        offerId: String(offer?.id),
        applicationId: idStr(offer?.applicationId),
        candidateId: idStr(offer?.candidateId),
        jobRequisitionId: idStr(offer?.jobRequisitionId),
        approvalRef: idStr(extra?.approvalRef),
        decision: extra?.decision ?? null,
        proposedExpiryDate: isoStr(extra?.proposedExpiryDate),
        expiryDate: isoStr(offer?.expiryDate),
        version: offer?.version ?? null,
        createdById: idStr(offer?.createdById),
        recruiterId: idStr(extra?.recruiterId),
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
// refuse rather than write around the freeze. With offerExtensionApproval on,
// a SENT offer's extension is routed to the Centre instead ("APPROVAL"); an
// expired offer is still never reopened.
async function assertNoStandingApproval(tx, tenantId, offerId, reopen) {
    const approval = await tx.hrApprovalRequest.findUnique({
        where: { tenantId_kind_sourceRef: { tenantId, kind: "OFFER", sourceRef: String(offerId) } },
        select: { id: true, stage: true },
    });
    const reApproval = isRecruitmentFlagEnabled("offerExtensionApproval");
    if (approval?.stage === "APPROVED") {
        if (!reopen && reApproval) return "APPROVAL";
        if (reopen && reApproval) {
            throw fail("An expired offer is not reopened; send a new offer through the HR Approval Centre", 409, "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED");
        }
        throw fail(
            "This offer's terms were approved in the HR Approval Centre; a new expiry date needs a new approval there",
            409,
            "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL",
        );
    }
    if (reopen) {
        throw fail("The offer's approval no longer stands; send a new offer through the HR Approval Centre", 409, "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED");
    }
    return "DIRECT";
}

// ── Re-approval through the HR Approval Centre (Phase 6) ────────────────────

const MAX_EXTENSION_REASON = 1000;
const EXTENSION_SELECT = Object.freeze({
    id: true, sourceRef: true, stage: true, version: true, round: true, execution: true, createdAt: true, updatedAt: true,
});

const extensionsOf = (db, tenantId, offerId, where = {}) =>
    db.hrApprovalRequest.findMany({
        where: { tenantId, kind: "OFFER", sourceRef: { startsWith: offerExtensionRefPrefix(offerId) }, ...where },
        select: EXTENSION_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

function extensionReason(reason, fallback) {
    const value = typeof reason === "string" ? reason.trim() : "";
    if (value.length > MAX_EXTENSION_REASON) {
        throw fail(`The reason must be at most ${MAX_EXTENSION_REASON} characters`, 400, "HR-RECRUITMENT-OFFER-EXTENSION-REASON-INVALID");
    }
    return value || fallback;
}

/** What a recruiter sees of one extension request (ids, stage and dates only). */
export function offerExtensionView(row, offer = null) {
    if (!row) return null;
    const ext = parseOfferExtensionRef(row.sourceRef);
    return {
        approvalRef: row.approvalRef ?? row.id ?? null,
        sourceRef: row.sourceRef,
        stage: row.stage,
        execution: row.execution ?? null,
        sequence: ext?.sequence ?? null,
        attempt: ext?.attempt ?? null,
        proposedExpiryDate: ext ? ext.proposedExpiryDate.toISOString() : null,
        currentExpiryDate: isoStr(offer?.expiryDate),
        workflowUrl: "/hr/approvals",
    };
}

// The Centre's receipts make a submit idempotent per request key. The key is
// derived from the request and the version it moves, so a retry of the same
// submit replays and a resubmission after a return gets a fresh key.
function extensionRequestKey(tenantId, sourceRef, version) {
    const h = createHash("sha256").update(`${tenantId}|offer-extension|${sourceRef}|${version}`).digest("hex");
    const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Inside the extension's transaction (offer row locked): what to submit, or
 * the open request that already asks for this date (a replay). One open
 * extension per offer; only the offer's creator (the Centre's initiator for
 * OFFER) can submit.
 */
async function planExtensionApproval(tx, { tenantId, offer, newExpiry, actorId }) {
    const sequence = (offer.expiryExtendedCount ?? 0) + 1;
    const requests = await extensionsOf(tx, tenantId, offer.id);
    const open = requests.filter((r) => OFFER_EXTENSION_OPEN_STAGES.includes(r.stage));
    const same = open.find((r) => {
        const ext = parseOfferExtensionRef(r.sourceRef);
        return ext?.sequence === sequence && ext.proposedExpiryDate.getTime() === newExpiry.getTime();
    });
    if (open.some((r) => r !== same)) {
        throw fail(
            "An extension of this offer is already waiting in the HR Approval Centre; withdraw it before asking for another date",
            409,
            "HR-RECRUITMENT-OFFER-EXTENSION-PENDING",
        );
    }
    if (same && same.stage !== "INITIATOR") return { replay: same };

    const actor = positiveInt(actorId);
    if (actor && offer.createdById && actor !== offer.createdById) {
        throw fail("Only the offer's creator can submit its extension to the HR Approval Centre", 403, "HR-RECRUITMENT-OFFER-EXTENSION-INITIATOR-ONLY");
    }
    const initiator = offer.createdById
        ? await tx.employee.findFirst({ where: { tenant_id: tenantId, id: offer.createdById }, select: { employee_code: true } })
        : null;
    if (!initiator?.employee_code) {
        throw fail("The offer has no employee initiator, so its extension cannot be routed for approval", 409, "HR-RECRUITMENT-OFFER-EXTENSION-NO-INITIATOR");
    }
    const attempt = requests.filter((r) => r.sourceRef.startsWith(offerExtensionSequencePrefix(offer.id, sequence))).length + 1;
    return {
        submit: {
            kind: "OFFER",
            sourceRef: same?.sourceRef ?? buildOfferExtensionRef({ offerId: offer.id, sequence, attempt, proposedExpiryDate: newExpiry }),
            employeeCode: initiator.employee_code,
            expectedVersion: same?.version ?? 0,
        },
    };
}

/** Submit the planned request through the Centre (its own transaction, receipts and audit). */
async function submitExtensionApproval({ tenantId, plan, offer, newExpiry, reason }) {
    if (plan.replay) return { view: offerExtensionView(plan.replay, offer), replayed: true };
    const { submitApproval } = await import("./approval/service.js");
    const result = await submitApproval({
        ...plan.submit,
        reason: extensionReason(reason, `Extend the offer's expiry to ${newExpiry.toISOString()}`),
        requestKey: extensionRequestKey(tenantId, plan.submit.sourceRef, plan.submit.expectedVersion),
    });
    return { view: offerExtensionView(result?.record ?? { sourceRef: plan.submit.sourceRef, stage: "LINE_MANAGER" }, offer), replayed: false };
}

const withoutRelations = (offer) => {
    if (!offer) return offer;
    const { application: _application, jobRequisition: _jobRequisition, ...rest } = offer;
    return rest;
};

/**
 * hr_offer_expiry_extend. ORG only; an optional expectedVersion is the
 * optimistic-concurrency guard (412 when stale). With offerExtensionApproval
 * on and the offer's approval standing, the answer is the unchanged offer with
 * pendingApproval: true and the extension request (extensionApproval).
 *
 * @param {{ tenantId: string, id: number|string, expiryDate: string|Date, expectedVersion?: number, reason?: string, scope?: object, actorId?: number|null, now?: Date }} args
 */
export async function extendOfferExpiry({ tenantId, id, expiryDate, expectedVersion, reason, scope = null, actorId = null, now = new Date() } = {}) {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    if (scope && scope.unrestricted !== true) {
        throw fail("Only recruiters can extend an offer", 403, "HR-RECRUITMENT-OFFER-EXTEND-FORBIDDEN");
    }
    const offerId = positiveInt(id);
    if (!offerId) throw fail("A valid offer id is required", 400, "HR-RECRUITMENT-OFFER-ID-REQUIRED");
    const at = new Date(now);
    const newExpiry = parseNewExpiry(expiryDate, at);
    const expected = normalizeExpectedVersion(expectedVersion);
    extensionReason(reason, null);

    const outcome = await tenantTransaction(
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
            const route = await assertNoStandingApproval(tx, tenantId, offerId, reopen);
            if (route === "APPROVAL") {
                return { offer: withoutRelations(offer), plan: await planExtensionApproval(tx, { tenantId, offer, newExpiry, actorId }) };
            }

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
            return { applied: { ...fresh, reopened: reopen, previousExpiryDate: offer.expiryDate ?? null } };
        },
        { tenantId },
    );
    if (outcome.applied) return outcome.applied;

    // The offer is unchanged until the Centre's final decision.
    const { view, replayed } = await submitExtensionApproval({ tenantId, plan: outcome.plan, offer: outcome.offer, newExpiry, reason });
    return { ...outcome.offer, reopened: false, previousExpiryDate: null, pendingApproval: true, replayed, extensionApproval: view };
}

/**
 * Called by the Approval Centre's applyDecision (src/services/approval/
 * adapters.js) for an OFFER request whose sourceRef is an extension
 * reference, inside the APPROVE / REJECT transaction, after loadSource locked
 * the offer row. Returns the Centre's execution value.
 *
 *   * REJECT: the offer is unchanged; decided REJECTED.
 *   * APPROVE: the offer must still be SENT at the revision the request named
 *     (expiryExtendedCount + 1 = sequence), the proposed date still in the
 *     future and later than the current one, and the candidate still
 *     contactable. Otherwise 409 HR-RECRUITMENT-OFFER-EXTENSION-STALE and the
 *     approver rejects it instead (an expired offer is never reopened). The
 *     write runs under the finalizing marker the source guard expects, and
 *     emits offer_expiry_extended and decided APPROVED.
 */
export async function applyOfferExtensionDecision(tx, env, request, source, approved) {
    const ext = parseOfferExtensionRef(request?.sourceRef);
    const offer = source?.row;
    const tenantId = env?.tenantId ?? offer?.tenantId;
    if (!ext || !offer || ext.offerId !== offer.id || !tenantId) {
        throw fail("Not an offer extension request", 422, "HR-RECRUITMENT-OFFER-EXTENSION-INVALID");
    }
    const at = env?.now ? new Date(env.now) : new Date();
    const ctx = eventContext({ actorId: env?.who?.id });
    const requisition = await tx.jobRequisition.findFirst({
        where: withTenant(tenantId, { id: offer.jobRequisitionId }),
        select: { recruiterId: true },
    });
    const decided = (row, decision) =>
        offerExpiryExtensionDecidedEvent({ ...row, tenantId: row?.tenantId ?? tenantId }, ctx, {
            approvalRef: request.id,
            decision,
            proposedExpiryDate: ext.proposedExpiryDate,
            recruiterId: requisition?.recruiterId ?? null,
        });

    if (!approved) {
        await enqueueHrDomainEvent(tx, decided(offer, "REJECTED"));
        return "APPLIED";
    }

    const stale = (why) => fail(`${why}; reject this extension request instead`, 409, "HR-RECRUITMENT-OFFER-EXTENSION-STALE");
    const count = offer.expiryExtendedCount ?? 0;
    if (offer.status !== "SENT") throw stale(`The offer is ${offer.status}, no longer SENT`);
    if (count + 1 !== ext.sequence) throw stale("The offer's expiry changed after this extension was requested");
    if (ext.proposedExpiryDate.getTime() <= at.getTime()) throw stale("The proposed expiry date has passed");
    if (offer.expiryDate && ext.proposedExpiryDate.getTime() <= new Date(offer.expiryDate).getTime()) {
        throw stale("The proposed expiry date is not later than the current one");
    }
    await assertCommunicationsAllowed({ tenantId, candidateId: offer.candidateId, purpose: "PROCESSING" }, { db: tx });

    // The guard lets frozen content change only under this marker.
    await tx.$executeRaw`SELECT set_config('app.hr_approval_finalizing',${"OFFER:" + offer.id},true)`;
    const moved = await tx.offer.updateMany({
        where: withTenant(tenantId, { id: offer.id, status: "SENT", expiryExtendedCount: count }),
        data: {
            expiryDate: ext.proposedExpiryDate,
            expiryExtendedCount: { increment: 1 },
            expiryReminderSentAt: null,
            version: { increment: 1 },
        },
    });
    if (moved.count !== 1) throw stale("The offer changed while the extension was being approved");
    const fresh = await tx.offer.findFirst({ where: withTenant(tenantId, { id: offer.id }) });
    const row = { ...offer, ...(fresh ?? {}), tenantId: fresh?.tenantId ?? tenantId };
    await enqueueHrDomainEvent(tx, offerExpiryExtendedEvent(row, ctx, { previousExpiryDate: offer.expiryDate, reopened: false }));
    await enqueueHrDomainEvent(tx, decided(row, "APPROVED"));
    return "APPLIED";
}

function assertExtensionTools(scope) {
    if (!isRecruitmentFlagEnabled("offerExtensionApproval")) {
        throw fail("Offer extension re-approval is disabled", 503, "HR-RECRUITMENT-OFFER-EXTENSION-APPROVAL-DISABLED");
    }
    if (scope && scope.unrestricted !== true) {
        throw fail("Only recruiters can manage an offer extension", 403, "HR-RECRUITMENT-OFFER-EXTEND-FORBIDDEN");
    }
}

/**
 * hr_offer_expiry_extension_get. The offer's latest extension request (or
 * null) and whether one is open. ORG only; flag offerExtensionApproval.
 */
export async function getOfferExtensionApproval({ tenantId, id, scope = null } = {}) {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    assertExtensionTools(scope);
    const offerId = positiveInt(id);
    if (!offerId) throw fail("A valid offer id is required", 400, "HR-RECRUITMENT-OFFER-ID-REQUIRED");
    return tenantTransaction(
        prisma,
        async (tx) => {
            const offer = await tx.offer.findFirst({
                where: withTenant(tenantId, { id: offerId }),
                select: { id: true, status: true, expiryDate: true, expiryExtendedCount: true, version: true },
            });
            if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
            const requests = await extensionsOf(tx, tenantId, offerId);
            const latest = requests.at(-1) ?? null;
            return {
                offerId,
                status: offer.status,
                expiryDate: isoStr(offer.expiryDate),
                expiryExtendedCount: offer.expiryExtendedCount ?? 0,
                version: offer.version ?? null,
                open: Boolean(latest && OFFER_EXTENSION_OPEN_STAGES.includes(latest.stage)),
                latest: offerExtensionView(latest, offer),
            };
        },
        { tenantId },
    );
}

/**
 * Withdraw the given open extension requests of one offer inside the caller's
 * transaction: each becomes WITHDRAWN with its audit row, the Centre's
 * transition announcement and the recruitment decision event. The offer row is
 * never touched. Returns the views of the requests it withdrew.
 */
async function withdrawExtensionRequestsInTx(tx, { tenantId, offer, open, actorCode, actorType = "user", note, ctx, recruiterId }) {
    const withdrawn = [];
    for (const { id: requestId } of open) {
        await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${tenantId}::uuid AND id=${requestId}::uuid FOR UPDATE`;
        const row = await tx.hrApprovalRequest.findFirst({ where: { tenantId, id: requestId } });
        if (!row || !OFFER_EXTENSION_OPEN_STAGES.includes(row.stage)) continue;
        const next = await tx.hrApprovalRequest.update({
            where: { id: row.id },
            data: { stage: "WITHDRAWN", execution: "APPLIED", version: { increment: 1 } },
        });
        await tx.hrApprovalAudit.create({
            data: {
                tenantId,
                approvalRef: next.id,
                version: next.version,
                round: next.round,
                actorCode,
                fromStage: row.stage,
                toStage: "WITHDRAWN",
                action: "WITHDRAW",
                reason: note,
                sourceHash: next.sourceHash,
            },
        });
        // The same announcement the Centre makes for its own transitions.
        await enqueueHrDomainEvent(tx, {
            tenantId,
            actorId: actorCode,
            actorType,
            eventName: "hr.approval.transitioned.v1",
            aggregateType: "HrApprovalRequest",
            aggregateId: next.id,
            correlationId: ctx.correlationId,
            payload: {
                approvalRef: next.id,
                kind: next.kind,
                sourceRef: next.sourceRef,
                employeeCode: next.employeeCode,
                actorCode,
                fromStage: row.stage,
                toStage: "WITHDRAWN",
                action: "WITHDRAW",
                version: next.version,
                round: next.round,
            },
        });
        await enqueueHrDomainEvent(
            tx,
            offerExpiryExtensionDecidedEvent({ ...offer, tenantId: offer.tenantId ?? tenantId }, ctx, {
                approvalRef: next.id,
                decision: "WITHDRAWN",
                proposedExpiryDate: parseOfferExtensionRef(next.sourceRef)?.proposedExpiryDate ?? null,
                recruiterId,
            }),
        );
        withdrawn.push(offerExtensionView(next, offer));
    }
    return withdrawn;
}

/**
 * hr_offer_expiry_extension_withdraw. A recruiter withdraws the offer's open
 * extension request: the request becomes WITHDRAWN (audited and announced as
 * the Centre's own transitions are), the offer is unchanged, decided
 * WITHDRAWN. The Centre offers no WITHDRAW action for OFFER requests (its
 * withdraw would also withdraw the offer), so this is the recruitment side's
 * own, and it never touches the offer row. A repeat answers withdrawn: [].
 */
export async function withdrawOfferExtension({ tenantId, id, reason, scope = null, actorId = null } = {}) {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    assertExtensionTools(scope);
    const offerId = positiveInt(id);
    if (!offerId) throw fail("A valid offer id is required", 400, "HR-RECRUITMENT-OFFER-ID-REQUIRED");
    const note = extensionReason(reason, "The recruiter withdrew the offer extension request");
    const actor = positiveInt(actorId);
    if (!actor) throw fail("A linked employee is required to withdraw an extension", 403, "HR-RECRUITMENT-OFFER-EXTENSION-ACTOR-REQUIRED");
    const ctx = eventContext({ actorId: actor });

    return tenantTransaction(
        prisma,
        async (tx) => {
            await tx.$queryRaw`SELECT id FROM "offers" WHERE id=${offerId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
            const offer = await tx.offer.findFirst({ where: withTenant(tenantId, { id: offerId }) });
            if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
            const requests = await extensionsOf(tx, tenantId, offerId);
            const open = requests.filter((r) => OFFER_EXTENSION_OPEN_STAGES.includes(r.stage));
            if (!open.length) {
                const latest = requests.at(-1);
                if (latest?.stage === "WITHDRAWN") return { offerId, withdrawn: [], latest: offerExtensionView(latest, offer) };
                throw fail("This offer has no open extension request", 404, "HR-RECRUITMENT-OFFER-EXTENSION-NOT-FOUND");
            }
            const who = await tx.employee.findFirst({ where: { tenant_id: tenantId, id: actor }, select: { employee_code: true } });
            if (!who?.employee_code) {
                throw fail("A linked employee code is required to withdraw an extension", 403, "HR-RECRUITMENT-OFFER-EXTENSION-ACTOR-REQUIRED");
            }
            const requisition = await tx.jobRequisition.findFirst({
                where: withTenant(tenantId, { id: offer.jobRequisitionId }),
                select: { recruiterId: true },
            });

            const withdrawn = await withdrawExtensionRequestsInTx(tx, {
                tenantId,
                offer,
                open,
                actorCode: who.employee_code,
                note,
                ctx,
                recruiterId: requisition?.recruiterId ?? null,
            });
            return { offerId, withdrawn, latest: withdrawn.at(-1) ?? null };
        },
        { tenantId },
    );
}

// Statuses after which an offer's expiry can no longer change.
const CLOSED_FOR_EXTENSION = Object.freeze(["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"]);
// The audit actor of a withdrawal the system makes (no person decided it).
export const EXTENSION_SWEEP_ACTOR = "SYSTEM";

/**
 * Phase 6 hardening. An extension request that is still open when its offer
 * is accepted, declined, withdrawn or expires can never apply (the decision
 * refuses a stale offer), so it would sit in the HR Approval Centre queue until
 * someone withdrew it by hand. This sweep withdraws those requests as the
 * system, with the same audit row and events as a recruiter's withdrawal; the
 * offer row is never touched. It runs with the offer expiry job.
 * Flag offerExtensionApproval (returns { skipped: "FLAG_OFF" } when off).
 */
export async function runOfferExtensionCloseJob({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("offerExtensionApproval")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 500);
    const open = await mcpCtx.run({ system: true }, async () =>
        await prisma.hrApprovalRequest.findMany({
            where: { kind: "OFFER", stage: { in: [...OFFER_EXTENSION_OPEN_STAGES] }, sourceRef: { contains: "@x" } },
            select: { id: true, tenantId: true, sourceRef: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take,
        }),
    );
    const summary = { scanned: open.length, closed: 0, stillOpen: 0, failed: 0 };
    for (const request of open) {
        const parsed = parseOfferExtensionRef(request.sourceRef);
        if (!parsed || !request.tenantId) {
            summary.stillOpen += 1;
            continue;
        }
        const { tenantId } = request;
        try {
            const closed = await mcpCtx.run({ user: { tenantId } }, async () =>
                await tenantTransaction(
                    prisma,
                    async (tx) => {
                        await tx.$queryRaw`SELECT id FROM "offers" WHERE id=${parsed.offerId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
                        const offer = await tx.offer.findFirst({ where: withTenant(tenantId, { id: parsed.offerId }) });
                        if (!offer) return 0;
                        const expired = offer.status === "SENT" && offer.expiryDate && new Date(offer.expiryDate) < at;
                        if (!CLOSED_FOR_EXTENSION.includes(offer.status) && !expired) return 0;
                        const requisition = await tx.jobRequisition.findFirst({
                            where: withTenant(tenantId, { id: offer.jobRequisitionId }),
                            select: { recruiterId: true },
                        });
                        const withdrawn = await withdrawExtensionRequestsInTx(tx, {
                            tenantId,
                            offer,
                            open: [{ id: request.id }],
                            actorCode: EXTENSION_SWEEP_ACTOR,
                            actorType: "automation",
                            note: `Withdrawn automatically: the offer is ${expired ? "EXPIRED" : offer.status}`,
                            ctx: eventContext({ actorId: null }),
                            recruiterId: requisition?.recruiterId ?? null,
                        });
                        return withdrawn.length;
                    },
                    { tenantId },
                ),
            );
            if (closed) summary.closed += closed;
            else summary.stillOpen += 1;
        } catch (err) {
            summary.failed += 1;
            log.error({ errMessage: err?.message, tenantId, approvalRef: request.id }, "offer extension close: request failed");
        }
    }
    log.info(summary, "offer extension close job: done");
    return summary;
}
