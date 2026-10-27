// src/lib/notificationClient.js
//
// Phase 5 / §3.2 — HR's client for the Notification Hub's REST egress ingress
// (POST /api/v1/notify). The decision record splits delivery ownership: the hub
// owns email (transports, suppression, templates), HR owns recruitment data.
// Candidate emails are CANDIDATE addresses, not platform users, so these calls
// use address-only recipients ({ email }) which the hub's routing treats as
// first-class (address-level suppression applies; no inbox row is created —
// the notification is keyed to the first recipient's userId, which is null
// here, so the parent row records the delivery audit only).
//
// Contract posture:
//   * AUTH mirrors rbac.client.js: X-Internal-Secret + a signed service JWT
//     (signServiceJwtEdDSA) + the ambient tenant header. The hub derives the
//     caller tenant from the VERIFIED credential, never the body.
//   * FAIL-SOFT by design: a portal application must not fail because the mail
//     plane is down. Every send returns a typed outcome { sent, reason } and
//     swallows transport errors into `send-failed`; callers record it and move
//     on. Ops metric: hr_recruitment_notifications_total{event, outcome}.
//   * NO PII in payloads beyond what the template needs: a first name and the
//     job title the candidate just applied to — never a resume, never a phone.
import axios from "axios";
import { signServiceJwtEdDSA, ambientTenantHeader } from "./serviceJwt.js";
import { recordRecruitmentNotification } from "./recruitment-ops-metrics.util.js";

const HUB_BASE_URL = process.env.NOTIFICATION_HUB_URL || "http://localhost:4500";
const HUB_TIMEOUT = parseInt(process.env.NOTIFICATION_HUB_TIMEOUT || "5000", 10);

const hubApi = axios.create({ baseURL: HUB_BASE_URL, timeout: HUB_TIMEOUT });

const withInternalAuth = (headers = {}) => ({
    ...headers,
    ...ambientTenantHeader(),
    "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    Authorization: `Bearer ${signServiceJwtEdDSA()}`,
});

/**
 * Send ONE template email to ONE candidate address through the hub.
 *
 * @param {object} opts
 * @param {string} opts.tenantId      verified tenant (also rides the credential)
 * @param {string} opts.email         candidate mailbox (the ONLY recipient form)
 * @param {string} opts.templateId    hub template id (e.g. hr.recruitment.portal_email_verification)
 * @param {object} opts.data          template variables (ids + non-PII facts)
 * @param {string} [opts.dedupeKey]   hub idempotency key (a retry replays, not duplicates)
 * @param {string} [opts.category]    hub category label
 * @returns {Promise<{sent: boolean, reason?: string, notificationId?: string}>}
 */
export const sendCandidateEmail = async ({ tenantId, email, templateId, data, dedupeKey, category }) => {
    try {
        const res = await hubApi.post(
            "/api/v1/notify",
            {
                tenantId,
                recipients: [{ email }],
                templateId,
                data,
                channels: ["email"],
                priority: "normal",
                ...(category ? { category } : {}),
                ...(dedupeKey ? { dedupeKey } : {}),
            },
            withInternalAuth({ "X-Tenant-Id": tenantId }),
        );
        recordRecruitmentNotification(templateEventLabel(templateId), res.status < 300 ? "enqueued" : "dropped-error");
        return { sent: true, notificationId: res.data?.notificationId };
    } catch (err) {
        // Fail-soft: the hub being down must never fail a portal submission or
        // a token issuance. Classified once, logged once, recorded once.
        const reason = err?.response ? "send-failed" : "hub-unreachable";
        try {
            loggerSafe("warn", { err: err?.message, templateId, reason }, "candidate email send failed");
        } catch { /* logging never derails */ }
        recordRecruitmentNotification(templateEventLabel(templateId), "dropped-error");
        return { sent: false, reason };
    }
};

// The hub template id and the metric event label are the same string family;
// keep the metric's allowlist honest without leaking hub ids into callers.
// D-14 — the previous mapping compared the last dot segment
// ("portal_email_verification") with "verification", so every portal email
// was counted as "other". The transport is the one place each send is counted.
const TEMPLATE_EVENT_LABELS = Object.freeze({
    "hr.recruitment.portal_email_verification": "email_verification",
    "hr.recruitment.portal_status_link": "status_link",
    "hr.recruitment.portal_application_confirmed": "application_confirmation",
    "hr.recruitment.portal_application_confirmed_existing": "application_confirmation",
    "hr.recruitment.portal_mailbox_notice": "mailbox_notice",
    "hr.recruitment.portal_draft_link": "draft_link",
});
export function templateEventLabel(templateId) {
    return TEMPLATE_EVENT_LABELS[String(templateId || "")] ?? "other";
}

function loggerSafe(level, obj, msg) {
    try {
        // Lazy import so unit tests can mock axios without dragging pino config.
        import("./logger.js").then((m) => m.default?.[level]?.(obj, msg)).catch(() => {});
    } catch { /* ignore */ }
}
