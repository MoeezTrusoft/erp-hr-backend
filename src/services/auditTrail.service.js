// src/services/auditTrail.service.js
//
// HR Reports → Audit Trail screen backend. Proxies the central erp-audit
// service (audit.client.queryAuditEvents) and maps its raw AuditEvent stream to
// the flat rows the FE audit-trail table renders.
//
// Tenant scoping: queryAuditEvents authenticates on the EdDSA service-JWT plane
// and erp-audit already scopes results to the caller's tenant (the `tid` claim),
// so we do NOT re-filter by tenant here. `tenantId` is still threaded through so
// the Employee name/role resolution stays fail-closed scoped to this tenant.
//
// Event name grammar: "domain.entity.action.vN" (e.g. hr.employee.lifecycle.v1
// → entity "employee", action "lifecycle"; hr.document.expiry_reminder.v1 →
// entity "document", action "expiry reminder").
//
// user/role resolution: for a `user` actor whose actorId is all-digits we treat
// it as an Employee id and resolve the display name in ONE batched findMany
// across the distinct numeric actorIds on the page (never N+1). role is a
// best-effort HR-local label derived from the employee's job_title — see the
// ROLE note below; authoritative RBAC role can be wired later via the RBAC /mcp
// client. Non-numeric / service actors keep their raw actorId string as `user`.
import prisma from "../lib/prisma.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";
import { queryAuditEvents } from "./audit.client.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const AUDIT_FETCH_LIMIT = 200; // erp-audit hard cap; we filter/sort/paginate in-memory below.

const SORT_KEYS = new Set(["timestamp", "user", "entity", "action"]);

// snake→space, collapse repeats, trim. "expiry_reminder" → "expiry reminder".
function prettify(segment) {
    if (!segment) return "";
    return String(segment).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

function capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Parse "domain.entity.action.vN" defensively. Missing segments → null.
function parseEventName(name) {
    const parts = typeof name === "string" ? name.split(".") : [];
    const entity = parts.length >= 2 ? parts[1] : null;
    const action = parts.length >= 3 ? prettify(parts[2]) : null;
    return { entity, action };
}

function isNumericId(v) {
    return typeof v === "string" && /^\d+$/.test(v);
}

function employeeFullName(emp) {
    if (!emp) return null;
    const denorm = emp.employee_name && emp.employee_name.trim();
    if (denorm) return denorm;
    const joined = `${emp.first_name || ""} ${emp.last_name || ""}`.trim();
    return joined || null;
}

/**
 * Build the FE audit-trail page from the central audit stream.
 *
 * @param {object} args
 * @param {string} args.tenantId  verified RBAC Company.uuid (Employee scope)
 * @param {string} [args.q]       free-text search (user/entity/action/eventName)
 * @param {string} [args.entity]  exact entity filter (case-insensitive)
 * @param {string} [args.action]  exact action filter (case-insensitive)
 * @param {string} [args.actorId] upstream actor filter (passed to erp-audit)
 * @param {string} [args.since]   ISO lower bound on occurredAt
 * @param {string} [args.until]   ISO upper bound on occurredAt
 * @param {"timestamp"|"user"|"entity"|"action"} [args.sortBy]
 * @param {"asc"|"desc"} [args.sortDir]
 * @param {number} [args.page]     1-based (default 1)
 * @param {number} [args.pageSize] default 20, max 100
 * @returns {Promise<{ items: object[], total: number, page: number, pageSize: number }>}
 */
export async function getAuditTrail({
    tenantId,
    q,
    entity,
    action,
    actorId,
    since,
    until,
    sortBy,
    sortDir,
    page,
    pageSize,
} = {}) {
    // The audit API is already tenant-scoped by the JWT; we only pass actor/time.
    const { items: events } = await queryAuditEvents({
        actorId,
        since,
        until,
        limit: AUDIT_FETCH_LIMIT,
    });

    // BATCH-resolve the distinct numeric `user`-actor ids on this page in ONE
    // findMany (fail-closed tenant-scoped). Service/non-numeric actors are skipped.
    const numericActorIds = [
        ...new Set(
            events
                // Any all-digits actorId is an Employee.id in HR's context —
                // envelopes stamp actorType "service" even for employee actors,
                // so resolve on numeric-id shape, not on actorType.
                .filter((e) => isNumericId(String(e?.actorId ?? "")))
                .map((e) => Number.parseInt(String(e.actorId), 10))
                .filter((n) => Number.isFinite(n))
        ),
    ];

    const employeeById = new Map();
    if (numericActorIds.length > 0) {
        try {
            const employees = await prisma.employee.findMany({
                where: scopedEmployeeWhere(tenantId, { id: { in: numericActorIds } }),
                select: {
                    id: true,
                    employee_name: true,
                    first_name: true,
                    last_name: true,
                    job_title: true,
                },
            });
            for (const emp of employees) employeeById.set(String(emp.id), emp);
        } catch (err) {
            // Fail-soft: without the name map we still render raw actor ids.
            logger.warn({ err, count: numericActorIds.length }, "Audit trail employee resolution failed");
        }
    }

    // Map each AuditEvent → a flat FE row.
    const rows = events.map((ev) => {
        const { entity: rawEntity, action: parsedAction } = parseEventName(ev?.name);
        const actorIdStr = ev?.actorId != null ? String(ev.actorId) : null;
        const emp =
            actorIdStr && employeeById.has(actorIdStr)
                ? employeeById.get(actorIdStr)
                : null;

        // user: resolved employee name for numeric user actors, else the raw
        // actorId string (e.g. a service actor like "erp-hr").
        const user = emp ? employeeFullName(emp) : actorIdStr;

        // ROLE (v1): best-effort HR-local label from the resolved employee's
        // job_title. The authoritative RBAC role is NOT available here; it can
        // be wired later via the RBAC /mcp client. job_title is the pragmatic v1.
        const role = emp?.job_title ?? null;

        const payload = ev?.payload ?? {};

        return {
            id: ev?.id ?? null,
            timestamp: ev?.occurredAt ?? null,
            eventName: ev?.name ?? null,
            entity: rawEntity,
            entityLabel: rawEntity ? capitalize(rawEntity) : null,
            action: parsedAction,
            actorType: ev?.actorType ?? null,
            user,
            userId: actorIdStr,
            role,
            correlationId: ev?.correlationId ?? null,
            // Most domain events carry no explicit diff → before/after stay null;
            // the raw payload rides along as `data` so the FE can render details.
            before: payload?.before ?? null,
            after: payload?.after ?? null,
            data: payload,
        };
    });

    // IN-MEMORY filtering. q searches user/entity/action/eventName (ci).
    let filtered = rows;
    if (q != null && String(q).trim() !== "") {
        const needle = String(q).toLowerCase();
        filtered = filtered.filter((r) => {
            const hay = [r.user, r.entity, r.action, r.eventName]
                .filter((v) => v != null)
                .join(" ")
                .toLowerCase();
            return hay.includes(needle);
        });
    }
    if (entity != null && String(entity).trim() !== "") {
        const want = String(entity).toLowerCase();
        filtered = filtered.filter((r) => (r.entity || "").toLowerCase() === want);
    }
    if (action != null && String(action).trim() !== "") {
        const want = String(action).toLowerCase();
        filtered = filtered.filter((r) => (r.action || "").toLowerCase() === want);
    }

    // SORT.
    const key = SORT_KEYS.has(sortBy) ? sortBy : "timestamp";
    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
        let av;
        let bv;
        if (key === "timestamp") {
            av = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            bv = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        } else {
            av = (a[key] || "").toString().toLowerCase();
            bv = (b[key] || "").toString().toLowerCase();
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
    });

    // PAGINATE (1-based).
    const total = filtered.length;
    const safePageSize = Math.min(
        Math.max(Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
    );
    const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
    const start = (safePage - 1) * safePageSize;
    const items = filtered.slice(start, start + safePageSize);

    return { items, total, page: safePage, pageSize: safePageSize };
}
