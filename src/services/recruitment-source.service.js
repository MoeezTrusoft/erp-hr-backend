// src/services/recruitment-source.service.js
//
// Phase 2 — source attribution reporting: where applications came from, and
// which sources turned into hires.
//
// Reads Application.sourceChannel, captured at intake (the portal apply path
// reads it from the `source` query value the feed and the career site put on
// the apply link). Applications from before Phase 2, and intake paths that do
// not know their source, have no channel; they are counted, under "UNKNOWN",
// rather than dropped, so the report's total always matches the funnel.
//
// Two groupBy queries (all, and stage hired) over the same predicate: the
// tenant explicitly, the caller's applicationScopeWhere, and the optional
// requisition and appliedAt range. Counting happens in the database; the
// service only merges the two result sets.
import prisma from "../lib/prisma.js";
import { withTenant } from "../lib/tenancy.js";
import { applicationScopeWhere } from "../lib/recruitment-access.util.js";

const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

export const UNKNOWN_SOURCE = "UNKNOWN";
const HIRED_STAGE = "hired";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A date-only upper bound means "through that day", not "until its midnight".
function parseDate(raw, field, { endOfDay = false } = {}) {
    if (raw === undefined || raw === null || raw === "") return null;
    const date = raw instanceof Date ? raw : new Date(raw);
    if (endOfDay && typeof raw === "string" && DATE_ONLY_RE.test(raw.trim()) && !Number.isNaN(date.getTime())) {
        date.setUTCHours(23, 59, 59, 999);
    }
    if (Number.isNaN(date.getTime())) {
        throw fail(`${field} must be a valid date`, "HR-RECRUITMENT-SOURCE-REPORT-INVALID");
    }
    return date;
}

function parseRequisitionId(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
        throw fail("requisitionId must be a positive whole number", "HR-RECRUITMENT-SOURCE-REPORT-INVALID");
    }
    return id;
}

/** The report's application predicate (tenant, scope, filters). Pure. */
export function buildSourceReportWhere({ tenantId, scope, requisitionId = null, from = null, to = null }) {
    const and = [applicationScopeWhere(scope)];
    if (requisitionId) and.push({ jobRequisitionId: requisitionId });
    if (from || to) {
        and.push({ appliedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
    }
    // AND keeps the scope's own OR from colliding with a filter's keys.
    return withTenant(tenantId, { AND: and });
}

const countOf = (row) => Number(row?._count?._all ?? row?._count ?? 0);

/** Merge the two groupBy results into report rows, largest source first. Pure. */
export function mergeSourceCounts(allRows = [], hiredRows = []) {
    const byChannel = new Map();
    const bucket = (channel) => {
        const key = channel ?? UNKNOWN_SOURCE;
        if (!byChannel.has(key)) byChannel.set(key, { channel: key, applications: 0, hired: 0 });
        return byChannel.get(key);
    };
    for (const row of allRows) bucket(row.sourceChannel).applications += countOf(row);
    for (const row of hiredRows) bucket(row.sourceChannel).hired += countOf(row);
    return [...byChannel.values()]
        .map((row) => ({
            ...row,
            hireRate: row.applications ? Math.round((row.hired / row.applications) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.applications - a.applications || a.channel.localeCompare(b.channel));
}

/**
 * Applications and hires per source channel.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {object} args.scope            resolveRecruitmentScope(user)
 * @param {number|string} [args.requisitionId]
 * @param {string|Date} [args.from]      appliedAt lower bound (inclusive)
 * @param {string|Date} [args.to]        appliedAt upper bound (inclusive)
 */
export async function getRecruitmentSourceReport({ tenantId, scope, requisitionId, from, to } = {}) {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    if (!scope) throw fail("Recruitment scope is required", "HR-RECRUITMENT-SCOPE-REQUIRED", 500);
    const filters = {
        requisitionId: parseRequisitionId(requisitionId),
        from: parseDate(from, "from"),
        to: parseDate(to, "to", { endOfDay: true }),
    };
    if (filters.from && filters.to && filters.from > filters.to) {
        throw fail("from must not be after to", "HR-RECRUITMENT-SOURCE-REPORT-INVALID");
    }

    const where = buildSourceReportWhere({ tenantId, scope, ...filters });
    const [allRows, hiredRows] = await Promise.all([
        prisma.application.groupBy({ by: ["sourceChannel"], where, _count: { _all: true } }),
        prisma.application.groupBy({
            by: ["sourceChannel"],
            where: { ...where, stage: HIRED_STAGE },
            _count: { _all: true },
        }),
    ]);

    const sources = mergeSourceCounts(allRows, hiredRows);
    return {
        sources,
        totals: {
            applications: sources.reduce((sum, row) => sum + row.applications, 0),
            hired: sources.reduce((sum, row) => sum + row.hired, 0),
        },
        filters: {
            requisitionId: filters.requisitionId,
            from: filters.from ? filters.from.toISOString() : null,
            to: filters.to ? filters.to.toISOString() : null,
        },
    };
}
