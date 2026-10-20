// src/services/esign.client.js
//
// Recruitment Phase 3a — the PROVIDER-NEUTRAL e-signature adapter. The plan
// leaves the provider "external (to be selected)", so everything the offer
// flow needs from one goes through this file and nothing else names a vendor:
//
//   sendEnvelope({ tenantId, offerId, letterVersionId, pdfBuffer | mediaId,
//                  signer: { name, email }, subject, message, callbackUrl,
//                  idempotencyKey })            -> { provider, envelopeId, status }
//   voidEnvelope({ provider, envelopeId, reason }) -> { provider, envelopeId, status: "VOIDED" }
//   verifyWebhook({ provider, headers, rawBody, now })
//       -> { ok: true, event: { eventId, envelopeId, type, occurredAt, signedDocumentAvailable } }
//        | { ok: false, reason }
//   downloadSignedDocument({ provider, envelopeId }) -> Buffer | null
//
// The provider is chosen by ESIGN_PROVIDER, read on every call:
//
//   "none" (default)  no provider is configured. Sending is refused with 503
//                     HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED even when the esign
//                     flag is on, and every webhook fails verification.
//   "generic"         a documented generic HTTPS provider:
//       ESIGN_API_BASE        https base URL (http only for localhost)
//       ESIGN_API_KEY         sent as "Authorization: Bearer <key>"
//       ESIGN_WEBHOOK_SECRET  HMAC-SHA256 key for the webhook
//       ESIGN_HTTP_TIMEOUT_MS request budget (default 15000)
//     POST {base}/envelopes            JSON { externalRef, subject, message,
//                                       signer, callbackUrl, document: { fileName,
//                                       contentType, base64 } } with an
//                                       Idempotency-Key header
//                                       -> { envelopeId | id, status }
//     POST {base}/envelopes/{id}/void  JSON { reason }
//     GET  {base}/envelopes/{id}/documents/signed -> application/pdf (404: none)
//     Webhook: JSON { eventId | id, type, envelopeId, occurredAt,
//              signedDocumentAvailable } with headers
//              X-Esign-Timestamp  unix seconds
//              X-Esign-Signature  "sha256=" + hex HMAC-SHA256(secret,
//                                 "<timestamp>.<raw body>")
//     The timestamp is inside the MAC so it cannot be moved; a delivery more
//     than 5 minutes from our clock is refused (replay), and a replay inside
//     the window is caught by the event-id dedupe in offer-esign.service.js.
//
// Never logged: the API key, the webhook secret, the signer's e-mail and name,
// and the document. Provider error bodies are not logged or returned either
// (they may echo the signer).
import crypto from "node:crypto";

import logger from "../lib/logger.js";

export const ESIGN_PROVIDERS = Object.freeze({ NONE: "none", GENERIC: "generic" });
export const ESIGN_EVENT_TYPES = Object.freeze(["SENT", "VIEWED", "SIGNED", "DECLINED", "EXPIRED", "VOIDED"]);
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
export const SIGNATURE_HEADER = "x-esign-signature";
export const TIMESTAMP_HEADER = "x-esign-timestamp";

const COMPONENT = "esign-client";
const DEFAULT_TIMEOUT_MS = 15000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/** The configured provider; an unknown value is treated as "none" (fail closed). */
export function getEsignProvider() {
    const raw = String(process.env.ESIGN_PROVIDER ?? "").trim().toLowerCase();
    if (raw === ESIGN_PROVIDERS.GENERIC) return ESIGN_PROVIDERS.GENERIC;
    if (raw && raw !== ESIGN_PROVIDERS.NONE) {
        logger.warn({ component: COMPONENT, provider: raw }, "unknown ESIGN_PROVIDER; e-signature is disabled");
    }
    return ESIGN_PROVIDERS.NONE;
}

function genericConfig() {
    const base = String(process.env.ESIGN_API_BASE ?? "").trim().replace(/\/+$/, "");
    const apiKey = String(process.env.ESIGN_API_KEY ?? "").trim();
    const timeout = Number.parseInt(process.env.ESIGN_HTTP_TIMEOUT_MS ?? "", 10);
    let url = null;
    try {
        url = base ? new URL(base) : null;
    } catch {
        url = null;
    }
    const secure = url && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    return {
        base: secure ? base : null,
        apiKey: apiKey || null,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    };
}

/** True when sending can work: a provider is selected and fully configured. */
export function isEsignConfigured() {
    if (getEsignProvider() !== ESIGN_PROVIDERS.GENERIC) return false;
    const config = genericConfig();
    return Boolean(config.base && config.apiKey);
}

function requireSendableProvider(provider = getEsignProvider()) {
    if (provider !== ESIGN_PROVIDERS.GENERIC || provider !== getEsignProvider()) {
        throw fail("No e-signature provider is configured", 503, "HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED");
    }
    const config = genericConfig();
    if (!config.base || !config.apiKey) {
        throw fail("The e-signature provider is not fully configured", 503, "HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED");
    }
    return config;
}

async function providerRequest(config, path, { method = "GET", body, idempotencyKey, accept = "application/json" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: accept };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
        return await fetch(`${config.base}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        // Only the failure class is logged: the request carried the signer.
        logger.warn({ component: COMPONENT, path: path.split("/").slice(0, 2).join("/"), err: err?.name }, "e-signature provider unreachable");
        throw fail("The e-signature provider could not be reached; try again", 502, "HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE");
    } finally {
        clearTimeout(timer);
    }
}

const encodeId = (id) => encodeURIComponent(String(id));

/** Send one letter for signature. */
export async function sendEnvelope({
    tenantId,
    offerId,
    letterVersionId,
    pdfBuffer = null,
    mediaId = null,
    signer = {},
    subject = null,
    message = null,
    callbackUrl = null,
    idempotencyKey,
} = {}) {
    const config = requireSendableProvider();
    if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
        // The generic shape carries the document inline; it cannot read DAM.
        throw fail(
            mediaId ? "The generic provider needs the letter's bytes, not a media id" : "The letter document is required",
            500,
            "HR-RECRUITMENT-ESIGN-DOCUMENT-REQUIRED",
        );
    }
    if (!signer?.email) throw fail("The candidate has no e-mail address to sign with", 422, "HR-RECRUITMENT-ESIGN-SIGNER-REQUIRED");
    const res = await providerRequest(config, "/envelopes", {
        method: "POST",
        idempotencyKey,
        body: {
            externalRef: `hr:${tenantId}:offer:${offerId}:letter:${letterVersionId}`,
            subject: subject || "Offer letter",
            message: message || null,
            signer: { name: signer.name || null, email: signer.email },
            callbackUrl: callbackUrl || null,
            document: {
                fileName: `offer-letter-${letterVersionId}.pdf`,
                contentType: "application/pdf",
                base64: pdfBuffer.toString("base64"),
            },
        },
    });
    if (!res.ok) {
        logger.warn({ component: COMPONENT, status: res.status, offerId, letterVersionId }, "e-signature provider refused the envelope");
        throw fail(`The e-signature provider refused the envelope (status ${res.status})`, 502, "HR-RECRUITMENT-ESIGN-SEND-FAILED");
    }
    const json = await res.json().catch(() => ({}));
    const envelopeId = json?.envelopeId ?? json?.id ?? null;
    if (!envelopeId) throw fail("The e-signature provider returned no envelope id", 502, "HR-RECRUITMENT-ESIGN-SEND-FAILED");
    return { provider: ESIGN_PROVIDERS.GENERIC, envelopeId: String(envelopeId), status: normalizeEventType(json?.status) ?? "SENT" };
}

/** Void an envelope that is out for signature. */
export async function voidEnvelope({ provider, envelopeId, reason = null } = {}) {
    const config = requireSendableProvider(provider);
    const res = await providerRequest(config, `/envelopes/${encodeId(envelopeId)}/void`, {
        method: "POST",
        body: { reason: reason || null },
    });
    // 404/409: the provider no longer holds a live envelope, which is the goal.
    if (!res.ok && res.status !== 404 && res.status !== 409) {
        logger.warn({ component: COMPONENT, status: res.status }, "e-signature provider refused the void");
        throw fail(`The e-signature provider refused the void (status ${res.status})`, 502, "HR-RECRUITMENT-ESIGN-VOID-FAILED");
    }
    return { provider, envelopeId: String(envelopeId), status: "VOIDED" };
}

/** The signed PDF for an envelope, or null when the provider has none. */
export async function downloadSignedDocument({ provider, envelopeId } = {}) {
    const config = requireSendableProvider(provider);
    const res = await providerRequest(config, `/envelopes/${encodeId(envelopeId)}/documents/signed`, { accept: "application/pdf" });
    if (res.status === 404) return null;
    if (!res.ok) throw fail(`The signed document could not be downloaded (status ${res.status})`, 502, "HR-RECRUITMENT-ESIGN-DOCUMENT-FAILED");
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? buffer : null;
}

// ── Webhook verification ─────────────────────────────────────────────────────

const TYPE_ALIASES = Object.freeze({ COMPLETED: "SIGNED", DELIVERED: "VIEWED", OPENED: "VIEWED", VOID: "VOIDED", REJECTED: "DECLINED" });

/** Map a provider's event type to SENT|VIEWED|SIGNED|DECLINED|EXPIRED|VOIDED, or null. */
export function normalizeEventType(raw) {
    if (raw === null || raw === undefined) return null;
    const type = String(raw).trim().toUpperCase().replace(/^ENVELOPE[._]/, "");
    const mapped = TYPE_ALIASES[type] ?? type;
    return ESIGN_EVENT_TYPES.includes(mapped) ? mapped : null;
}

const headerOf = (headers, name) => {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
};

/** HMAC-SHA256 hex over "<timestamp>.<raw body>". Exported for tests and the provider docs. */
export function signWebhookPayload(secret, timestamp, rawBody) {
    return crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8"))
        .digest("hex");
}

function verifyGeneric({ headers, rawBody, now }) {
    const secret = String(process.env.ESIGN_WEBHOOK_SECRET ?? "");
    if (!secret) return { ok: false, reason: "NOT_CONFIGURED" };
    const signature = String(headerOf(headers, SIGNATURE_HEADER) ?? "").trim().replace(/^sha256=/i, "");
    const timestamp = String(headerOf(headers, TIMESTAMP_HEADER) ?? "").trim();
    if (!/^[0-9a-f]{64}$/i.test(signature) || !/^\d{1,13}$/.test(timestamp)) return { ok: false, reason: "MISSING_SIGNATURE" };
    if (rawBody === null || rawBody === undefined || (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string")) {
        return { ok: false, reason: "NO_RAW_BODY" };
    }

    const expected = Buffer.from(signWebhookPayload(secret, timestamp, rawBody), "hex");
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "BAD_SIGNATURE" };

    // Seconds, or milliseconds from a provider that sends those.
    const stampMs = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
    if (Math.abs(now.getTime() - stampMs) > WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "STALE_TIMESTAMP" };

    let body;
    try {
        body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
    } catch {
        return { ok: false, reason: "MALFORMED" };
    }
    const eventId = body?.eventId ?? body?.id;
    const envelopeId = body?.envelopeId ?? body?.envelope?.id;
    if (!eventId || !envelopeId || String(eventId).length > 200 || String(envelopeId).length > 200) {
        return { ok: false, reason: "MALFORMED" };
    }
    const occurred = body?.occurredAt ? new Date(body.occurredAt) : null;
    return {
        ok: true,
        event: {
            eventId: String(eventId),
            envelopeId: String(envelopeId),
            type: normalizeEventType(body?.type ?? body?.event),
            rawType: body?.type ?? body?.event ?? null,
            occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
            signedDocumentAvailable: body?.signedDocumentAvailable === true || Boolean(body?.signedDocumentUrl),
        },
    };
}

/**
 * Verify a webhook delivery. Nothing is trusted before this returns ok: the
 * provider in the URL must be the configured one, and its signature must hold.
 */
export function verifyWebhook({ provider, headers = {}, rawBody, now = new Date() } = {}) {
    const configured = getEsignProvider();
    if (String(provider ?? "").toLowerCase() !== configured || configured === ESIGN_PROVIDERS.NONE) {
        return { ok: false, reason: "PROVIDER_DISABLED" };
    }
    return verifyGeneric({ headers, rawBody, now });
}
