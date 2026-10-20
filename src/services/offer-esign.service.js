// src/services/offer-esign.service.js
//
// Recruitment Phase 3a — the offer letter's E-SIGNATURE round trip (flag esign),
// through the provider-neutral adapter in esign.client.js.
//
// Sending (hr_offer_esign_send, ORG only)
//   * The offer must already be SENT: the e-signature is the candidate's way of
//     answering an offer that went through its approval and the send gate, not
//     a way around them. Its newest letter version must be rendered (in DAM)
//     and not yet out for signature; a signature that ended (DECLINED, EXPIRED,
//     VOIDED) needs a fresh render, so one version holds one envelope.
//   * The privacy gate runs first (do-not-contact, withdrawn consent: 409,
//     never echoing the address).
//   * A signature accepts the offer, and acceptance provisions an employee
//     whose code needs an explicit category, so the category is fixed here
//     (stored on the offer; it is not approval-guarded content) rather than
//     discovered missing when the webhook arrives.
//   * ONE ENVELOPE PER VERSION. The version is claimed with a guarded update
//     (sentForSignatureAt) before the provider call, and the provider gets a
//     deterministic idempotency key, so a double click or a retry after a lost
//     response cannot create a second envelope.
//
// The webhook (POST /webhooks/esign/:provider, see esign-webhook.routes.js)
//   * Verified before anything is written (the route answers 401).
//   * DEDUPED by EsignWebhookEvent (provider, providerEventId) under SYSTEM
//     context: the tenant is unknown until the envelope is matched to its
//     OfferLetterVersion. An APPLIED or IGNORED event is acknowledged again
//     without being applied; a FAILED (or abandoned) one is claimed and tried
//     again, by the provider's redelivery or by runEsignWebhookRetryJob.
//   * Applied under the matched TENANT's context. VIEWED, DECLINED, EXPIRED and
//     VOIDED move signatureStatus forward only (a late VIEWED never reopens a
//     signed letter). SIGNED stores the signed PDF in DAM when the provider has
//     one, marks the version SIGNED and then ACCEPTS THE OFFER through
//     respondOffer in offer.service.js, the same path a recruiter's "accepted"
//     uses, so the stage move, the offer_accepted event and the hire handoff
//     (when offerHandoff is on) are not re-implemented here.
//   * A DECLINED signature does NOT decline the offer: the recruiter records a
//     decline and its reason; the status change event tells them to.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { mcpCtx } from "../mcp/context.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { RECRUITMENT_SCOPE } from "../lib/recruitmentAccess.js";
import { eventContext } from "../lib/event-context.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { respondOffer } from "./offer.service.js";
import { uploadOfferLetterPdf } from "./offer-letter-pdf.service.js";
import { findNewestLetterVersion, presentLetterVersion } from "./offer-letter.service.js";
import {
    downloadSignedDocument,
    getEsignProvider,
    isEsignConfigured,
    normalizeEventType,
    sendEnvelope,
    voidEnvelope,
} from "./esign.client.js";

const COMPONENT = "offer-esign";

export const OFFER_ESIGN_SENT_EVENT = "hr.recruitment.offer_esign_sent.v1";
export const OFFER_ESIGN_STATUS_CHANGED_EVENT = "hr.recruitment.offer_esign_status_changed.v1";
export const WEBHOOK_EVENT_STATUS = Object.freeze({ RECEIVED: "RECEIVED", APPLIED: "APPLIED", IGNORED: "IGNORED", FAILED: "FAILED" });

const OUT_FOR_SIGNATURE = Object.freeze(["SENT", "VIEWED"]);
const SENDABLE = Object.freeze(["NONE", "FAILED"]);
const EMPLOYEE_CATEGORIES = Object.freeze(["MANAGEMENT", "EMPLOYEE", "INTERNEE"]);
// An acceptance that cannot happen for a reason a retry will not change.
const PERMANENT_ACCEPT_CODES = new Set(["HR-RECRUITMENT-OFFER-FINALIZED", "HR-RECRUITMENT-OFFER-NOT-SENT"]);

const SEND_CLAIM_MS = 2 * 60 * 1000;
const WEBHOOK_LEASE_MS = 5 * 60 * 1000;
const RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 1000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const errorText = (err) => String(err?.code ? `${err.code}: ${err.message}` : err?.message ?? err).slice(0, MAX_ERROR_LENGTH);

// ── Events ───────────────────────────────────────────────────────────────────

/** hr.recruitment.offer_esign_sent.v1 — ids and the provider name only. */
export function offerEsignSentEvent(version, offer, ctx = {}) {
    if (!version?.tenantId) return null;
    return {
        eventName: OFFER_ESIGN_SENT_EVENT,
        tenantId: version.tenantId,
        aggregateType: "OfferLetterVersion",
        aggregateId: version.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            offerLetterVersionId: String(version.id),
            offerId: String(version.offerId),
            candidateId: offer?.candidateId != null ? String(offer.candidateId) : null,
            createdById: offer?.createdById != null ? String(offer.createdById) : null,
            provider: version.esignProvider ?? null,
        },
    };
}

/** hr.recruitment.offer_esign_status_changed.v1 — VIEWED | SIGNED | DECLINED | EXPIRED | VOIDED. */
export function offerEsignStatusChangedEvent(version, signatureStatus, ctx = {}) {
    if (!version?.tenantId) return null;
    return {
        eventName: OFFER_ESIGN_STATUS_CHANGED_EVENT,
        tenantId: version.tenantId,
        aggregateType: "OfferLetterVersion",
        aggregateId: version.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            offerLetterVersionId: String(version.id),
            offerId: String(version.offerId),
            signatureStatus,
        },
    };
}

// ── Guards ───────────────────────────────────────────────────────────────────

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
};

const requireEsignEnabled = () => {
    if (!isRecruitmentFlagEnabled("esign")) throw fail("Offer e-signature is disabled", 503, "HR-RECRUITMENT-ESIGN-DISABLED");
    // The flag says "may"; the provider says "can". No provider: still a 503.
    if (!isEsignConfigured()) throw fail("No e-signature provider is configured", 503, "HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED");
};

const requireOrgScope = (scope) => {
    if (scope?.level !== RECRUITMENT_SCOPE.ORG) {
        throw fail("Only recruiters can send offer letters for signature", 403, "HR-RECRUITMENT-ESIGN-FORBIDDEN");
    }
};

const positiveId = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail(`A valid ${label} is required`, 400, "HR-RECRUITMENT-ESIGN-INVALID");
    return n;
};

const candidateName = (candidate) =>
    [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() || null;

function callbackUrlFor(provider) {
    const base = String(process.env.ESIGN_CALLBACK_BASE_URL ?? "").trim().replace(/\/+$/, "");
    return base ? `${base}/webhooks/esign/${provider}` : null;
}

async function loadOffer(tenantId, offerId) {
    const offer = await prisma.offer.findFirst({
        where: withTenant(tenantId, { id: offerId }),
        include: { candidate: true },
    });
    if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
    return offer;
}

// ── Send ─────────────────────────────────────────────────────────────────────

function resolveCategory(offer, requested) {
    const category = requested ?? offer.employeeCategory ?? null;
    if (!EMPLOYEE_CATEGORIES.includes(category)) {
        throw fail(
            "Explicit employee category (MANAGEMENT, EMPLOYEE or INTERNEE) is required: a signed letter accepts the offer and provisions the employee",
            422,
            "HR-RECRUITMENT-OFFER-CATEGORY-REQUIRED",
        );
    }
    return category;
}

async function claimForSending({ tenantId, version, offerId, category, now }) {
    return await tenantTransaction(prisma, async (tx) => {
        const { count } = await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, {
                id: version.id,
                signatureStatus: { in: [...SENDABLE] },
                OR: [{ sentForSignatureAt: null }, { sentForSignatureAt: { lt: new Date(now.getTime() - SEND_CLAIM_MS) } }],
            }),
            data: { sentForSignatureAt: now, signatureError: null },
        });
        if (count === 0) return false;
        await tx.offer.updateMany({
            where: withTenant(tenantId, { id: offerId, status: "SENT", OR: [{ employeeCategory: null }, { employeeCategory: { not: category } }] }),
            data: { employeeCategory: category },
        });
        return true;
    }, { tenantId });
}

async function markSendFailed(tenantId, versionId, err) {
    await tenantTransaction(prisma, async (tx) => {
        await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, { id: versionId, signatureStatus: { in: [...SENDABLE] } }),
            data: { signatureStatus: "FAILED", signatureError: errorText(err), sentForSignatureAt: null },
        });
    }, { tenantId });
}

async function releaseClaim(tenantId, versionId) {
    await tenantTransaction(prisma, async (tx) => {
        await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, { id: versionId, signatureStatus: { in: [...SENDABLE] } }),
            data: { sentForSignatureAt: null },
        });
    }, { tenantId });
}

/**
 * Send the offer's newest letter for signature. Returns { version, replayed }.
 */
export async function sendOfferForSignature({
    tenantId,
    scope,
    offerId,
    employeeCategory = null,
    message = null,
    actorId = null,
    now = new Date(),
} = {}) {
    requireTenant(tenantId);
    requireEsignEnabled();
    requireOrgScope(scope);
    const id = positiveId(offerId, "offer id");
    const note = message == null ? null : String(message).trim().slice(0, MAX_MESSAGE_LENGTH) || null;

    const offer = await loadOffer(tenantId, id);
    if (offer.status !== "SENT") {
        throw fail(
            `Only a SENT offer's letter can be sent for signature (current status: ${offer.status})`,
            409,
            "HR-RECRUITMENT-OFFER-NOT-SENT",
        );
    }
    const category = resolveCategory(offer, employeeCategory);
    const version = await findNewestLetterVersion(prisma, tenantId, id);
    if (!version?.mediaId) {
        throw fail("Render the offer letter before sending it for signature", 409, "HR-RECRUITMENT-OFFER-LETTER-REQUIRED");
    }
    if (OUT_FOR_SIGNATURE.includes(version.signatureStatus)) {
        return { version: presentLetterVersion(version, scope, { isCurrent: true }), replayed: true };
    }
    if (!SENDABLE.includes(version.signatureStatus)) {
        throw fail(
            `Letter version ${version.version} is ${version.signatureStatus}; render a new letter version to send again`,
            409,
            "HR-RECRUITMENT-OFFER-LETTER-SIGNATURE-CLOSED",
        );
    }
    if (!offer.candidate?.email) {
        throw fail("The candidate has no e-mail address to sign with", 422, "HR-RECRUITMENT-ESIGN-SIGNER-REQUIRED");
    }
    // Throws 409 HR-RECRUITMENT-DNC-BLOCKED / -CONSENT-WITHDRAWN; the message
    // names the register, never the address.
    await assertCommunicationsAllowed({ tenantId, candidateId: offer.candidateId, purpose: "PROCESSING" });

    if (!(await claimForSending({ tenantId, version, offerId: id, category, now }))) {
        throw fail("This letter is already being sent for signature", 409, "HR-RECRUITMENT-OFFER-LETTER-SEND-IN-PROGRESS");
    }

    const document = await downloadDamAssetBuffer(version.mediaId);
    if (!document?.buffer?.length) {
        await releaseClaim(tenantId, version.id);
        throw fail("The rendered letter could not be read from DAM; try again", 502, "HR-RECRUITMENT-OFFER-LETTER-DOCUMENT-UNAVAILABLE");
    }

    const provider = getEsignProvider();
    const settings = await getRecruitmentSettings({ tenantId });
    let envelope;
    try {
        envelope = await sendEnvelope({
            tenantId,
            offerId: id,
            letterVersionId: version.id,
            pdfBuffer: document.buffer,
            signer: { name: candidateName(offer.candidate), email: offer.candidate.email },
            subject: settings.companyName ? `Your offer letter from ${settings.companyName}` : "Your offer letter",
            message: note,
            callbackUrl: callbackUrlFor(provider),
            idempotencyKey: `offer-letter-${tenantId}-${version.id}`,
        });
    } catch (err) {
        await markSendFailed(tenantId, version.id, err);
        throw err;
    }

    const row = await tenantTransaction(prisma, async (tx) => {
        await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, { id: version.id }),
            data: {
                signatureStatus: "SENT",
                esignProvider: envelope.provider,
                esignEnvelopeId: envelope.envelopeId,
                sentForSignatureAt: now,
                signatureError: null,
            },
        });
        const sent = await tx.offerLetterVersion.findFirst({ where: withTenant(tenantId, { id: version.id }) });
        await enqueueHrDomainEvent(tx, offerEsignSentEvent(sent, offer, eventContext({ actorId })));
        return sent;
    }, { tenantId });
    logger.info({ component: COMPONENT, offerId: id, letterVersionId: version.id, provider: envelope.provider }, "offer letter sent for signature");
    return { version: presentLetterVersion(row, scope, { isCurrent: true }), replayed: false };
}

// ── Void ─────────────────────────────────────────────────────────────────────

/** Void the envelope of the offer's letter that is out for signature. */
export async function voidOfferSignature({ tenantId, scope, offerId, reason, actorId = null } = {}) {
    requireTenant(tenantId);
    requireEsignEnabled();
    requireOrgScope(scope);
    const id = positiveId(offerId, "offer id");
    const why = String(reason ?? "").trim();
    if (!why) throw fail("A reason is required to void a signature request", 400, "HR-RECRUITMENT-ESIGN-REASON-REQUIRED");

    await loadOffer(tenantId, id);
    const version = await findNewestLetterVersion(prisma, tenantId, id);
    if (!version || !OUT_FOR_SIGNATURE.includes(version.signatureStatus) || !version.esignEnvelopeId) {
        throw fail("No letter of this offer is out for signature", 409, "HR-RECRUITMENT-OFFER-LETTER-NOT-OUT-FOR-SIGNATURE");
    }
    await voidEnvelope({ provider: version.esignProvider, envelopeId: version.esignEnvelopeId, reason: why.slice(0, 500) });

    const row = await tenantTransaction(prisma, async (tx) => {
        const { count } = await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, { id: version.id, signatureStatus: { in: [...OUT_FOR_SIGNATURE] } }),
            data: { signatureStatus: "VOIDED" },
        });
        const current = await tx.offerLetterVersion.findFirst({ where: withTenant(tenantId, { id: version.id }) });
        if (count > 0) await enqueueHrDomainEvent(tx, offerEsignStatusChangedEvent(current, "VOIDED", eventContext({ actorId })));
        return current;
    }, { tenantId });
    return { version: presentLetterVersion(row, scope, { isCurrent: true }) };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

const asSystem = (fn) => mcpCtx.run({ system: true }, async () => await fn());
const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId, employeeId: null }, esignWebhook: true }, async () => await fn());

/** Move a version from one of `from` to `to`, emitting the status event. */
async function transitionVersion(tenantId, version, from, to, extra = {}) {
    return await tenantTransaction(prisma, async (tx) => {
        const { count } = await tx.offerLetterVersion.updateMany({
            where: withTenant(tenantId, { id: version.id, signatureStatus: { in: from } }),
            data: { signatureStatus: to, ...extra },
        });
        if (count > 0) await enqueueHrDomainEvent(tx, offerEsignStatusChangedEvent(version, to, {}));
        return count > 0;
    }, { tenantId });
}

async function storeSignedDocument(version) {
    const buffer = await downloadSignedDocument({ provider: version.esignProvider, envelopeId: version.esignEnvelopeId });
    if (!buffer) return null;
    return await uploadOfferLetterPdf(buffer, `offer-${version.offerId}-letter-v${version.version}-signed.pdf`);
}

async function acceptSignedOffer(tenantId, version) {
    const offer = await prisma.offer.findFirst({
        where: withTenant(tenantId, { id: version.offerId }),
        select: { id: true, status: true, employeeCategory: true },
    });
    if (!offer) return { status: WEBHOOK_EVENT_STATUS.IGNORED, error: "The letter's offer no longer exists" };
    if (offer.status === "ACCEPTED") return { status: WEBHOOK_EVENT_STATUS.APPLIED };
    try {
        await respondOffer(offer.id, true, tenantId, { actorId: null, employeeCategory: offer.employeeCategory });
        return { status: WEBHOOK_EVENT_STATUS.APPLIED };
    } catch (err) {
        if (PERMANENT_ACCEPT_CODES.has(err?.code)) return { status: WEBHOOK_EVENT_STATUS.IGNORED, error: errorText(err) };
        throw err;
    }
}

async function applySigned(tenantId, version, event, now) {
    if (OUT_FOR_SIGNATURE.includes(version.signatureStatus)) {
        const signedMediaId = await storeSignedDocument(version);
        await transitionVersion(tenantId, version, [...OUT_FOR_SIGNATURE], "SIGNED", {
            signedAt: event.occurredAt ?? now,
            signedMediaId,
        });
    } else if (version.signatureStatus !== "SIGNED") {
        return { status: WEBHOOK_EVENT_STATUS.IGNORED, error: `The letter is ${version.signatureStatus}; a signature is not applied` };
    }
    // Signed now, or signed by an earlier delivery whose acceptance failed.
    return await acceptSignedOffer(tenantId, version);
}

async function applyEvent(tenantId, version, event, now) {
    switch (event.type) {
        case "SIGNED":
            return await applySigned(tenantId, version, event, now);
        case "VIEWED":
            return (await transitionVersion(tenantId, version, ["SENT"], "VIEWED"))
                ? { status: WEBHOOK_EVENT_STATUS.APPLIED }
                : { status: WEBHOOK_EVENT_STATUS.IGNORED };
        case "DECLINED":
        case "EXPIRED":
        case "VOIDED":
            // A declined signature leaves the offer SENT: the recruiter records
            // the decline and its reason.
            return (await transitionVersion(tenantId, version, [...OUT_FOR_SIGNATURE], event.type))
                ? { status: WEBHOOK_EVENT_STATUS.APPLIED }
                : { status: WEBHOOK_EVENT_STATUS.IGNORED };
        default:
            // SENT is recorded by the send itself; anything else is not ours.
            return { status: WEBHOOK_EVENT_STATUS.IGNORED };
    }
}

/** Match the envelope and apply the event. Returns { status, error?, tenantId? }. */
async function processEvent({ provider, event, now }) {
    const version = await asSystem(() =>
        prisma.offerLetterVersion.findFirst({ where: { esignProvider: provider, esignEnvelopeId: event.envelopeId } }),
    );
    if (!version) return { status: WEBHOOK_EVENT_STATUS.IGNORED, error: "Unknown envelope" };
    if (!event.type) return { status: WEBHOOK_EVENT_STATUS.IGNORED, error: "Unsupported event type", tenantId: version.tenantId };
    try {
        const outcome = await asTenant(version.tenantId, () => applyEvent(version.tenantId, version, event, now));
        return { ...outcome, tenantId: version.tenantId };
    } catch (err) {
        // The failed event still names its tenant, for the operator's view.
        throw Object.assign(err, { matchedTenantId: version.tenantId });
    }
}

async function finalizeEventRow(rowId, outcome, now) {
    await asSystem(() =>
        prisma.esignWebhookEvent.updateMany({
            where: { id: rowId },
            data: {
                status: outcome.status,
                error: outcome.error ? String(outcome.error).slice(0, MAX_ERROR_LENGTH) : null,
                ...(outcome.tenantId ? { tenantId: outcome.tenantId } : {}),
                processedAt: now,
            },
        }),
    );
}

async function runClaimedEvent(row, { provider, event, now }) {
    let outcome;
    try {
        outcome = await processEvent({ provider, event, now });
    } catch (err) {
        logger.warn({ component: COMPONENT, provider, eventId: event.eventId, err: err?.code ?? err?.message }, "e-signature event failed");
        outcome = { status: WEBHOOK_EVENT_STATUS.FAILED, error: errorText(err), tenantId: err?.matchedTenantId ?? null };
    }
    await finalizeEventRow(row.id, outcome, now);
    return outcome;
}

/** Claim a FAILED, or an abandoned RECEIVED, delivery for another attempt. */
async function claimExisting(row, now) {
    const { count } = await asSystem(() =>
        prisma.esignWebhookEvent.updateMany({
            where: {
                id: row.id,
                OR: [
                    { status: WEBHOOK_EVENT_STATUS.FAILED },
                    { status: WEBHOOK_EVENT_STATUS.RECEIVED, processedAt: { lt: new Date(now.getTime() - WEBHOOK_LEASE_MS) } },
                ],
            },
            data: { status: WEBHOOK_EVENT_STATUS.RECEIVED, processedAt: now, error: null },
        }),
    );
    return count > 0;
}

/**
 * Record and apply one VERIFIED webhook event. Returns
 * { outcome: APPLIED|IGNORED|FAILED|DUPLICATE|IN_PROGRESS, eventRowId }.
 * Throws only when the delivery could not even be recorded (the route answers
 * 500 so the provider redelivers).
 */
export async function handleEsignWebhookEvent({ provider, event, now = new Date() } = {}) {
    const findExisting = () =>
        asSystem(() => prisma.esignWebhookEvent.findFirst({ where: { provider, providerEventId: event.eventId } }));
    // A redelivery is the common duplicate: read first, so only a true race
    // reaches the unique key.
    let existing = await findExisting();
    let row = null;
    if (!existing) {
        try {
            row = await asSystem(() =>
                prisma.esignWebhookEvent.create({
                    data: {
                        provider,
                        providerEventId: event.eventId,
                        envelopeId: event.envelopeId,
                        eventType: event.type ?? (event.rawType != null ? String(event.rawType).slice(0, 50) : null),
                        status: WEBHOOK_EVENT_STATUS.RECEIVED,
                        processedAt: now,
                    },
                }),
            );
        } catch (err) {
            if (err?.code !== "P2002") throw err;
            existing = await findExisting();
            if (!existing) throw err;
        }
    }
    if (!row) {
        if (existing.status === WEBHOOK_EVENT_STATUS.APPLIED || existing.status === WEBHOOK_EVENT_STATUS.IGNORED) {
            return { outcome: "DUPLICATE", eventRowId: existing.id, status: existing.status };
        }
        if (!(await claimExisting(existing, now))) return { outcome: "IN_PROGRESS", eventRowId: existing.id };
        row = existing;
    }
    const outcome = await runClaimedEvent(row, { provider, event, now });
    return { outcome: outcome.status, eventRowId: row.id };
}

/**
 * Retry FAILED (and abandoned RECEIVED) deliveries from the last 72 hours.
 * Suggested cadence: every 15 minutes. Flag esign; SYSTEM context; per-row
 * isolation (one event's failure is stored on it, the run goes on).
 */
export async function runEsignWebhookRetryJob({ now = new Date(), limit = 50 } = {}) {
    if (!isRecruitmentFlagEnabled("esign")) return { skipped: true, reason: "flag-off" };
    const provider = getEsignProvider();
    if (!isEsignConfigured()) return { skipped: true, reason: "no-provider" };
    const rows = await asSystem(() =>
        prisma.esignWebhookEvent.findMany({
            where: {
                provider,
                receivedAt: { gte: new Date(now.getTime() - RETRY_WINDOW_MS) },
                OR: [
                    { status: WEBHOOK_EVENT_STATUS.FAILED },
                    { status: WEBHOOK_EVENT_STATUS.RECEIVED, processedAt: { lt: new Date(now.getTime() - WEBHOOK_LEASE_MS) } },
                ],
            },
            orderBy: { id: "asc" },
            take: Math.min(Math.max(Number(limit) || 50, 1), 200),
        }),
    );
    const summary = { scanned: rows.length, applied: 0, ignored: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
        try {
            if (!(await claimExisting(row, now))) {
                summary.skipped += 1;
                continue;
            }
            const event = { eventId: row.providerEventId, envelopeId: row.envelopeId, type: normalizeEventType(row.eventType), occurredAt: null };
            const outcome = await runClaimedEvent(row, { provider, event, now });
            summary[outcome.status === "APPLIED" ? "applied" : outcome.status === "IGNORED" ? "ignored" : "failed"] += 1;
        } catch (err) {
            summary.failed += 1;
            logger.error({ component: COMPONENT, eventRowId: row.id, err: err?.message }, "e-signature retry failed");
        }
    }
    return summary;
}
