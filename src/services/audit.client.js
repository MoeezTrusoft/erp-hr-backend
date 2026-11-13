// src/services/audit.client.js
//
// HR → erp-audit cross-service client for the Reports → Audit Trail surface.
// Mirrors dam.media.service.js: an axios client bound with a conservative,
// env-tunable timeout, authenticated on the EdDSA service-JWT plane
// (X-Service-Authorization) with the ambient X-Tenant-Id header for
// defense-in-depth, and FAIL-SOFT on any upstream error (log + return an empty
// result envelope so the caller degrades gracefully instead of throwing).
//
// The erp-audit /internal/audit endpoint is ALREADY tenant-scoped: it reads the
// `tid` claim carried on the signed service JWT (signServiceJwtEdDSA folds the
// verified ambient tenant into that claim) and only returns events for that
// tenant — so this client never sends a tenant filter of its own.
import axios from "axios";

import logger from "../lib/logger.js";
import { ambientTenantHeader, signServiceJwtEdDSA } from "../lib/serviceJwt.js";

const AUDIT_BASE_URL =
    process.env.AUDIT_SERVICE_URL ||
    "http://erp-audit-backend.erp-svc.svc.cluster.local:3000";

// Conservative, env-tunable budget for the cross-boundary audit GET so a stalled
// audit upstream can never hang an HR request indefinitely (default 10s).
const AUDIT_TIMEOUT = parseInt(process.env.AUDIT_HTTP_TIMEOUT_MS || "10000", 10);

// erp-audit hard-caps limit at 200; clamp locally so we never over-ask.
const MAX_LIMIT = 200;

const auditApi = axios.create({
    baseURL: AUDIT_BASE_URL,
    timeout: AUDIT_TIMEOUT,
});

/**
 * Query the central audit stream. Only the provided filters are sent as query
 * params; `limit` is clamped to [1, 200] and defaults to 200. The result is the
 * upstream `{ items, count }` envelope. Fail-soft: any error logs and returns
 * `{ items: [], count: 0 }`.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.name]           exact event name (domain.entity.action.vN)
 * @param {string}  [opts.actorId]        filter to a single actor id
 * @param {string}  [opts.correlationId]  filter to one correlation id
 * @param {string}  [opts.since]          ISO lower bound (inclusive) on occurredAt
 * @param {string}  [opts.until]          ISO upper bound on occurredAt
 * @param {number}  [opts.limit]          max rows (≤200, default 200)
 * @returns {Promise<{ items: object[], count: number }>}
 */
export async function queryAuditEvents({
    name,
    actorId,
    correlationId,
    since,
    until,
    limit,
} = {}) {
    const params = {};
    if (name != null && String(name).trim() !== "") params.name = name;
    if (actorId != null && String(actorId).trim() !== "") params.actorId = actorId;
    if (correlationId != null && String(correlationId).trim() !== "")
        params.correlationId = correlationId;
    if (since != null && String(since).trim() !== "") params.since = since;
    if (until != null && String(until).trim() !== "") params.until = until;

    const parsedLimit = Number.parseInt(limit, 10);
    params.limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, MAX_LIMIT)
            : MAX_LIMIT;

    try {
        const headers = { ...ambientTenantHeader() };
        const token = signServiceJwtEdDSA(); // audit scopes results by this token's `tid` claim
        if (token) headers["X-Service-Authorization"] = `Bearer ${token}`;

        const response = await auditApi.get("/internal/audit", { params, headers });
        const data = response?.data || {};
        return {
            items: Array.isArray(data.items) ? data.items : [],
            count: typeof data.count === "number" ? data.count : (data.items?.length || 0),
        };
    } catch (error) {
        logger.error(
            { err: error, params, responseData: error.response?.data },
            "Audit upstream query failed"
        );
        return { items: [], count: 0 };
    }
}
