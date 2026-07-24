// src/services/documentExpiryReport.service.js
//
// HR Reports → Document Expiry Alerts screen backend.
//
// The document source is EmployeeMedia (uploaded employee documents whose
// `expiry_date` is a STRING — may be null / blank / non-date; always parsed
// defensively with new Date(x) + isNaN guard). Both EmployeeMedia and
// DocumentExpiryAlert are FORCE-RLS: reads fold the verified tenant via
// scopedWhere(tenantId, where); the reminder WRITE (create DocumentExpiryAlert
// + enqueue the outbox event) runs in ONE tenantTransaction so the alert row
// and its fabric event commit or roll back together.
//
// EMAIL is DISABLED at the source (EMAIL_ENABLED = false): the reminder event's
// channels.email is always false. HR only EMITS hr.document.expiry_reminder.v1;
// the actual in-app notification is produced DOWNSTREAM by notification-hub IF
// it has a mapper for that event name — this module does not (and must not
// claim to) visibly fire the notification.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";
import { documentExpiryReminderEvent } from "./hrEvents.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getDamAssetById } from "./dam.media.service.js";

// email channel intentionally disabled — flip EMAIL_ENABLED / notification-hub
// mapper when ready.
const EMAIL_ENABLED = false;

const DAY_MS = 86_400_000;

// Employee select reused by the list rows — snake_case per the Employee model
// (there is NO firstName/lastName; full name is employee_name || first+last).
const EMPLOYEE_SELECT = {
    id: true,
    employee_name: true,
    first_name: true,
    last_name: true,
    photo_url: true,
    city: true,
    country: true,
    businessUnitId: true,
    regionId: true,
    businessUnit: { select: { name: true } },
    region: { select: { name: true } },
};

// Defensive parse of the STRING expiry_date. Returns a valid Date or null.
function parseExpiry(raw) {
    if (raw == null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function fullName(emp) {
    if (!emp) return null;
    const denorm = emp.employee_name && emp.employee_name.trim();
    if (denorm) return denorm;
    const joined = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim();
    return joined || null;
}

function locationOf(emp) {
    if (!emp) return null;
    const cityCountry = [emp.city, emp.country].filter(Boolean).join(", ");
    return cityCountry || emp.region?.name || null;
}

/**
 * KPI counts for the Document Expiry Alerts screen.
 *
 * Only EmployeeMedia rows with a PARSEABLE expiry_date are counted (null / blank
 * / non-date rows are skipped). `total` is the count of those.
 *
 * Banding is EXCLUSIVE so the buckets sum to `total`. `now` is computed once.
 * The FE labels 30 / 60 / 90 as three separate KPI cards:
 *   expired     : expiry <  now
 *   expiring30  : now       <= expiry <= now+30d
 *   expiring60  : now+30d   <  expiry <= now+60d
 *   expiring90  : now+60d   <  expiry <= now+90d
 *   healthy     : expiry >  now+90d
 *
 * @param {{tenantId: string|null}} args
 * @returns {Promise<{expired:number,expiring30:number,expiring60:number,expiring90:number,healthy:number,total:number}>}
 */
export async function getDocumentExpiryKpis({ tenantId }) {
    const rows = await prisma.employeeMedia.findMany({
        where: scopedWhere(tenantId, {}),
        select: { id: true, expiry_date: true },
    });

    const now = Date.now();
    const d30 = now + 30 * DAY_MS;
    const d60 = now + 60 * DAY_MS;
    const d90 = now + 90 * DAY_MS;

    const kpis = { expired: 0, expiring30: 0, expiring60: 0, expiring90: 0, healthy: 0, total: 0 };

    for (const row of rows) {
        const parsed = parseExpiry(row.expiry_date);
        if (!parsed) continue; // skip null / blank / invalid expiry
        const t = parsed.getTime();
        kpis.total += 1;
        if (t < now) kpis.expired += 1;
        else if (t <= d30) kpis.expiring30 += 1;
        else if (t <= d60) kpis.expiring60 += 1;
        else if (t <= d90) kpis.expiring90 += 1;
        else kpis.healthy += 1;
    }

    return kpis;
}

/**
 * Paginated, filtered, sorted list of expiring documents.
 *
 * Only rows with a parseable expiry_date are included. The set is
 * employee-scoped-small, so column-wise `q` search + status/department/location
 * filters + sort are applied in JS after the rows are built (expiry is already
 * parsed there). `total` is the FILTERED count (before pagination).
 *
 * @param {object} args
 * @param {string|null} args.tenantId
 * @param {string} [args.q]         free text across employee name / document / department / location
 * @param {'expired'|'active'} [args.status]
 * @param {string} [args.department] contains-ish filter
 * @param {string} [args.location]   contains-ish filter
 * @param {'expiry'|'employee'|'document'|'department'|'status'} [args.sortBy='expiry']
 * @param {'asc'|'desc'} [args.sortDir='asc']
 * @param {number} [args.page=1]
 * @param {number} [args.pageSize=20]
 * @returns {Promise<{items:object[],total:number,page:number,pageSize:number}>}
 */
export async function listExpiringDocuments({
    tenantId,
    q,
    status,
    department,
    location,
    sortBy = "expiry",
    sortDir = "asc",
    page = 1,
    pageSize = 20,
}) {
    const media = await prisma.employeeMedia.findMany({
        where: scopedWhere(tenantId, {}),
        include: { employee: { select: EMPLOYEE_SELECT } },
    });

    const now = Date.now();

    // Build rows only for parseable-expiry documents.
    let rows = [];
    for (const em of media) {
        const parsed = parseExpiry(em.expiry_date);
        if (!parsed) continue;
        const t = parsed.getTime();
        const emp = em.employee;
        rows.push({
            documentId: em.id,
            documentName: em.file_name || em.title || "Document",
            expiryDate: parsed.toISOString(),
            daysUntilExpiry: Math.ceil((t - now) / DAY_MS),
            status: t < now ? "expired" : "active",
            employee: emp
                ? { id: emp.id, name: fullName(emp), avatar: emp.photo_url ?? null }
                : { id: null, name: null, avatar: null },
            department: emp?.businessUnit?.name ?? null,
            location: locationOf(emp),
            // internal sort key (not serialized to the FE contract but harmless)
            _sortTime: t,
        });
    }

    // ── Column-wise filters ────────────────────────────────────────────────
    if (status === "expired" || status === "active") {
        rows = rows.filter((r) => r.status === status);
    }
    if (department && department.trim()) {
        const needle = department.trim().toLowerCase();
        rows = rows.filter((r) => (r.department ?? "").toLowerCase().includes(needle));
    }
    if (location && location.trim()) {
        const needle = location.trim().toLowerCase();
        rows = rows.filter((r) => (r.location ?? "").toLowerCase().includes(needle));
    }
    if (q && q.trim()) {
        const needle = q.trim().toLowerCase();
        rows = rows.filter((r) =>
            [r.employee?.name, r.documentName, r.department, r.location]
                .some((v) => (v ?? "").toLowerCase().includes(needle))
        );
    }

    const total = rows.length;

    // ── Sort ────────────────────────────────────────────────────────────────
    const dir = sortDir === "desc" ? -1 : 1; // default asc = soonest-expiring first
    const cmp = (a, b) => {
        let av;
        let bv;
        switch (sortBy) {
            case "employee":
                av = (a.employee?.name ?? "").toLowerCase();
                bv = (b.employee?.name ?? "").toLowerCase();
                break;
            case "document":
                av = (a.documentName ?? "").toLowerCase();
                bv = (b.documentName ?? "").toLowerCase();
                break;
            case "department":
                av = (a.department ?? "").toLowerCase();
                bv = (b.department ?? "").toLowerCase();
                break;
            case "status":
                av = a.status;
                bv = b.status;
                break;
            case "expiry":
            default:
                av = a._sortTime;
                bv = b._sortTime;
                break;
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
    };
    rows.sort(cmp);

    // ── Paginate ──────────────────────────────────────────────────────────
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : 20;
    const start = (safePage - 1) * safeSize;
    const items = rows.slice(start, start + safeSize).map(({ _sortTime, ...rest }) => rest);

    return { items, total, page: safePage, pageSize: safeSize };
}

/**
 * Send a manual document-expiry reminder for one EmployeeMedia row.
 *
 * Runs in ONE tenantTransaction: load the (scoped) media, EMIT the outbox event
 * hr.document.expiry_reminder.v1, and RECORD a DocumentExpiryAlert row — all
 * commit or roll back together. Email is disabled at the source; the in-app
 * notification is produced downstream by notification-hub only if it maps this
 * event name.
 *
 * @param {object} args
 * @param {string|null} args.tenantId
 * @param {number} args.employeeMediaId
 * @param {string} [args.message]
 * @param {{userId?:string,email?:string,correlationId?:string,employeeId?:string}} [args.actor]
 * @returns {Promise<{notified:true,employeeMediaId:number,event:string,emailEnabled:boolean}>}
 */
export async function sendDocumentExpiryReminder({ tenantId, employeeMediaId, message, actor = {} }) {
    return tenantTransaction(prisma, async (tx) => {
        const media = await tx.employeeMedia.findFirst({
            where: scopedWhere(tenantId, { id: employeeMediaId }),
            include: { employee: { select: { id: true } } },
        });
        if (!media) {
            throw Object.assign(new Error("Document not found"), { status: 404, statusCode: 404 });
        }

        // ctx for the pure event builder — actorId + correlationId chain the
        // HTTP edge → event. tenantId is pulled off the media row by baseArgs
        // (fail-closed); we thread it explicitly too for the enqueue guard.
        const ctx = {
            actorId: actor?.employeeId ?? actor?.userId ?? actor?.email,
            correlationId: actor?.correlationId,
        };
        const event = documentExpiryReminderEvent(media, ctx, { message, emailEnabled: EMAIL_ENABLED });
        // Fail-closed: enqueueHrDomainEvent needs args.tenantId (set from the
        // row's tenant by baseArgs); a null builder result (no tenant) is a
        // safe no-op the write can pass straight through.
        if (event) {
            if (!event.tenantId) {
                logger.warn({ employeeMediaId }, "document expiry reminder: event carries no tenantId — skipping enqueue");
            } else {
                await enqueueHrDomainEvent(tx, event);
            }
        }

        // Days-before-expiry for the alert record (>= 0; 0 when already expired
        // or unparseable).
        let daysBeforeExpiry = 0;
        const parsed = parseExpiry(media.expiry_date);
        if (parsed) {
            const diff = Math.ceil((parsed.getTime() - Date.now()) / DAY_MS);
            daysBeforeExpiry = diff > 0 ? diff : 0;
        }

        const now = new Date();
        await tx.documentExpiryAlert.create({
            data: {
                employeeMediaId: media.id,
                employeeId: media.employee_id,
                alertDate: now,
                daysBeforeExpiry,
                notified: true,
                notifiedAt: now,
                // tenantId auto-stamped by the RLS create-net default.
            },
        });

        return {
            notified: true,
            employeeMediaId: media.id,
            event: "hr.document.expiry_reminder.v1",
            emailEnabled: EMAIL_ENABLED,
        };
    });
}

/**
 * View-document payload: the (scoped) EmployeeMedia meta plus fail-soft DAM
 * asset metadata. For generic documents the caller uses the asset's url /
 * download_url (the /assets/video-stream/<media_id> path is for video only).
 *
 * @param {object} args
 * @param {string|null} args.tenantId
 * @param {number} args.employeeMediaId
 * @returns {Promise<{documentId:number,name:string,uploadedAt:Date,mediaId:number|null,downloadUrl:string|null,asset:object|null}>}
 */
export async function getDocumentForView({ tenantId, employeeMediaId }) {
    const media = await prisma.employeeMedia.findFirst({
        where: scopedWhere(tenantId, { id: employeeMediaId }),
    });
    if (!media) {
        throw Object.assign(new Error("Document not found"), { status: 404, statusCode: 404 });
    }

    // Fail-soft: getDamAssetById returns the asset meta or null on any failure.
    let asset = null;
    if (media.media_id != null) {
        asset = await getDamAssetById(media.media_id);
    }

    return {
        documentId: media.id,
        name: media.file_name || media.title || "Document",
        uploadedAt: media.uploaded_at,
        mediaId: media.media_id ?? null,
        downloadUrl: media.download_url ?? null,
        asset,
    };
}
