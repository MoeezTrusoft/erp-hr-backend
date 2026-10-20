// src/services/recruitment-agency.service.js
//
// Recruitment Phase 5 (plan 6.2, flag agencyPortal) — the HR side of agencies:
// the agencies a tenant works with, the RBAC users that log in for them, and
// the requisitions each agency may submit candidates to.
//
//   * An agency carries ownershipDays (how long an accepted candidate stays
//     the agency's: another agency's submission inside the window is a
//     DUPLICATE) and feePercent. Updates are guarded by expectedVersion; a
//     stale version is a 409 so the recruiter re-reads first.
//   * An agency user is the verified RBAC user id (RecruitmentAgencyUser,
//     unique per tenant). Revoking it ends the login's reach immediately: the
//     scope lookup (src/lib/agency-access.util.js) only honours ACTIVE rows of
//     ACTIVE agencies.
//   * An assignment opens one requisition to one agency, optionally capped by
//     maxSubmissions. Only an open requisition (APPROVED / POSTED and inside
//     its closing date) can be assigned; unassigning ENDS the row (kept for the
//     audit trail; pending submissions stay reviewable).
//
// Every query carries the tenant; writes run in tenantTransaction (FORCE RLS).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { APPLICATION_ACCEPTING_STATUSES } from "../lib/requisitionEligibility.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { AGENCY_STATUS, AGENCY_USER_STATUS, ASSIGNMENT_STATUS } from "../lib/agency-access.util.js";

const fail = (message, code, status = 400, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

export const AGENCY_NAME_MAX = 200;
export const AGENCY_NOTES_MAX = 2000;
export const OWNERSHIP_DAYS_RANGE = Object.freeze([0, 730]);

/** 503 while the agency portal is switched off (writes and the agency side). */
export function assertAgencyPortalEnabled() {
    if (!isRecruitmentFlagEnabled("agencyPortal")) {
        throw fail("Recruitment agencies are switched off", "HR-RECRUITMENT-AGENCY-PORTAL-DISABLED", 503);
    }
}

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
};

const positiveId = (value, what) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail(`A valid ${what} id is required`, "HR-RECRUITMENT-AGENCY-INVALID");
    return n;
};

const pageArgs = ({ page, pageSize } = {}) => {
    const p = Number.isInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const size = Number.isInteger(Number(pageSize)) && Number(pageSize) > 0 ? Math.min(Number(pageSize), 100) : 20;
    return { page: p, pageSize: size, skip: (p - 1) * size };
};

/**
 * Is this requisition open for agency work right now: an accepting status and
 * a closing date not yet passed (the closing instant itself still counts, as in
 * requisitionEligibility). No posting is needed: an agency is its own channel.
 */
export function isRequisitionOpenForAgencies(requisition, now = new Date()) {
    if (!requisition) return false;
    const status = String(requisition.status ?? "").trim().toUpperCase();
    if (!APPLICATION_ACCEPTING_STATUSES.includes(status)) return false;
    const closesAt = requisition.closesAt ? new Date(requisition.closesAt) : null;
    return !closesAt || closesAt.getTime() >= now.getTime();
}

// ── Input normalization (pure) ─────────────────────────────────────────────

function normalizeText(value, key, max, { required = false } = {}) {
    if (value === undefined) {
        if (required) throw fail(`${key} is required`, "HR-RECRUITMENT-AGENCY-INVALID");
        return undefined;
    }
    const text = value === null ? "" : String(value).trim();
    if (!text) {
        if (required) throw fail(`${key} is required`, "HR-RECRUITMENT-AGENCY-INVALID");
        return null;
    }
    if (text.length > max) throw fail(`${key} must be at most ${max} characters`, "HR-RECRUITMENT-AGENCY-INVALID");
    return text;
}

function normalizeEmail(value) {
    const text = normalizeText(value, "contactEmail", 254);
    if (!text) return text;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw fail("contactEmail must be an email address", "HR-RECRUITMENT-AGENCY-INVALID");
    return text.toLowerCase();
}

/** Validate an agency create/update payload into column data. Pure. */
export function normalizeAgencyInput(input = {}, { creating = false } = {}) {
    const data = {};
    const name = normalizeText(input.name, "name", AGENCY_NAME_MAX, { required: creating || input.name !== undefined });
    if (name !== undefined) data.name = name;
    const email = normalizeEmail(input.contactEmail);
    if (email !== undefined) data.contactEmail = email;
    const notes = normalizeText(input.notes, "notes", AGENCY_NOTES_MAX);
    if (notes !== undefined) data.notes = notes;
    if (input.status !== undefined) {
        const status = String(input.status ?? "").trim().toUpperCase();
        if (!Object.values(AGENCY_STATUS).includes(status)) {
            throw fail("status must be ACTIVE or SUSPENDED", "HR-RECRUITMENT-AGENCY-INVALID");
        }
        data.status = status;
    }
    if (input.ownershipDays !== undefined) {
        const n = Number(input.ownershipDays);
        const [min, max] = OWNERSHIP_DAYS_RANGE;
        if (!Number.isInteger(n) || n < min || n > max) {
            throw fail(`ownershipDays must be a whole number between ${min} and ${max}`, "HR-RECRUITMENT-AGENCY-INVALID");
        }
        data.ownershipDays = n;
    }
    if (input.feePercent !== undefined) {
        if (input.feePercent === null) {
            data.feePercent = null;
        } else {
            const n = Number(input.feePercent);
            if (!Number.isFinite(n) || n < 0 || n > 100 || Math.abs(Math.round(n * 100) - n * 100) > 1e-9) {
                throw fail("feePercent must be between 0 and 100 with at most two decimals", "HR-RECRUITMENT-AGENCY-INVALID");
            }
            data.feePercent = n;
        }
    }
    return data;
}

const presentAgency = (row) =>
    row ? { ...row, feePercent: row.feePercent == null ? null : Number(row.feePercent) } : row;

// ── Agencies ───────────────────────────────────────────────────────────────

export async function listAgencies({ tenantId, status, q, page, pageSize } = {}) {
    requireTenant(tenantId);
    const paging = pageArgs({ page, pageSize });
    const where = withTenant(tenantId, {
        ...(status ? { status: String(status).toUpperCase() } : {}),
        ...(q ? { name: { contains: String(q).trim(), mode: "insensitive" } } : {}),
    });
    const [items, total] = await Promise.all([
        prisma.recruitmentAgency.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: paging.skip, take: paging.pageSize }),
        prisma.recruitmentAgency.count({ where }),
    ]);
    return { items: items.map(presentAgency), total, page: paging.page, pageSize: paging.pageSize };
}

export async function getAgency({ tenantId, id } = {}) {
    requireTenant(tenantId);
    const agencyId = positiveId(id, "agency");
    const agency = await prisma.recruitmentAgency.findFirst({ where: withTenant(tenantId, { id: agencyId }) });
    if (!agency) throw fail("Agency not found", "HR-RECRUITMENT-AGENCY-NOT-FOUND", 404);
    const [assignments, activeUsers] = await Promise.all([
        prisma.requisitionAgencyAssignment.findMany({
            where: withTenant(tenantId, { agencyId, status: ASSIGNMENT_STATUS.ACTIVE }),
            orderBy: { assignedAt: "desc" },
            select: { id: true, requisitionId: true, maxSubmissions: true, assignedAt: true, assignedById: true },
        }),
        prisma.recruitmentAgencyUser.count({ where: withTenant(tenantId, { agencyId, status: AGENCY_USER_STATUS.ACTIVE }) }),
    ]);
    return { ...presentAgency(agency), activeUserCount: activeUsers, assignments };
}

const isUniqueViolation = (err) => err?.code === "P2002";

export async function createAgency({ tenantId, actorId = null, input = {} } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const data = normalizeAgencyInput(input, { creating: true });
    try {
        const row = await tenantTransaction(prisma, async (tx) =>
            await tx.recruitmentAgency.create({ data: { ...data, tenantId, createdById: actorId ?? null, version: 0 } }));
        logger.info({ tenantId, agencyId: row.id }, "recruitment agency created");
        return presentAgency(row);
    } catch (err) {
        if (isUniqueViolation(err)) throw fail("An agency with this name already exists", "HR-RECRUITMENT-AGENCY-NAME-TAKEN", 409);
        throw err;
    }
}

/**
 * Update an agency at the version the caller read. Suspending it takes effect
 * at once: its users' scope resolves to no rows from the next request on.
 */
export async function updateAgency({ tenantId, id, expectedVersion, input = {} } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const agencyId = positiveId(id, "agency");
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected) || expected < 0) {
        throw fail("expectedVersion is required", "HR-RECRUITMENT-AGENCY-INVALID");
    }
    const data = normalizeAgencyInput(input);
    if (!Object.keys(data).length) throw fail("Nothing to update", "HR-RECRUITMENT-AGENCY-INVALID");
    try {
        const row = await tenantTransaction(prisma, async (tx) => {
            const claimed = await tx.recruitmentAgency.updateMany({
                where: withTenant(tenantId, { id: agencyId, version: expected }),
                data: { ...data, version: { increment: 1 } },
            });
            const latest = await tx.recruitmentAgency.findFirst({ where: withTenant(tenantId, { id: agencyId }) });
            if (!latest) throw fail("Agency not found", "HR-RECRUITMENT-AGENCY-NOT-FOUND", 404);
            if (claimed.count === 0) {
                throw fail("The agency changed; refresh before saving", "HR-RECRUITMENT-AGENCY-VERSION-CONFLICT", 409, {
                    currentVersion: latest.version,
                });
            }
            return latest;
        });
        logger.info({ tenantId, agencyId, version: row.version, fields: Object.keys(data) }, "recruitment agency updated");
        return presentAgency(row);
    } catch (err) {
        if (isUniqueViolation(err)) throw fail("An agency with this name already exists", "HR-RECRUITMENT-AGENCY-NAME-TAKEN", 409);
        throw err;
    }
}

// ── Agency users ───────────────────────────────────────────────────────────

const USER_SELECT = Object.freeze({ id: true, agencyId: true, userId: true, email: true, status: true, createdAt: true, updatedAt: true });

export async function listAgencyUsers({ tenantId, agencyId, status } = {}) {
    requireTenant(tenantId);
    const where = withTenant(tenantId, {
        ...(agencyId != null ? { agencyId: positiveId(agencyId, "agency") } : {}),
        ...(status ? { status: String(status).toUpperCase() } : {}),
    });
    const items = await prisma.recruitmentAgencyUser.findMany({ where, orderBy: [{ agencyId: "asc" }, { id: "asc" }], select: USER_SELECT });
    return { items, total: items.length };
}

/**
 * Register an RBAC user as a login for an agency. A user id belongs to at most
 * one agency per tenant: re-adding a revoked login (to the same or another
 * agency) reactivates it; an ACTIVE login of another agency is a conflict.
 */
export async function addAgencyUser({ tenantId, agencyId, userId, email } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const agency = positiveId(agencyId, "agency");
    const uid = normalizeText(userId == null ? undefined : String(userId), "userId", 100, { required: true });
    const mail = email === undefined ? null : normalizeText(email, "email", 254);
    return tenantTransaction(prisma, async (tx) => {
        const owner = await tx.recruitmentAgency.findFirst({ where: withTenant(tenantId, { id: agency }), select: { id: true } });
        if (!owner) throw fail("Agency not found", "HR-RECRUITMENT-AGENCY-NOT-FOUND", 404);
        const existing = await tx.recruitmentAgencyUser.findFirst({ where: withTenant(tenantId, { userId: uid }), select: USER_SELECT });
        if (existing) {
            if (existing.status === AGENCY_USER_STATUS.ACTIVE && existing.agencyId !== agency) {
                throw fail("This user already logs in for another agency", "HR-RECRUITMENT-AGENCY-USER-CONFLICT", 409);
            }
            await tx.recruitmentAgencyUser.updateMany({
                where: withTenant(tenantId, { id: existing.id }),
                data: { agencyId: agency, status: AGENCY_USER_STATUS.ACTIVE, ...(mail !== null ? { email: mail } : {}) },
            });
            return { ...(await tx.recruitmentAgencyUser.findFirst({ where: withTenant(tenantId, { id: existing.id }), select: USER_SELECT })), reused: true };
        }
        const row = await tx.recruitmentAgencyUser.create({
            data: { tenantId, agencyId: agency, userId: uid, email: mail, status: AGENCY_USER_STATUS.ACTIVE },
            select: USER_SELECT,
        });
        return { ...row, reused: false };
    });
}

export async function revokeAgencyUser({ tenantId, id } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const rowId = positiveId(id, "agency user");
    return tenantTransaction(prisma, async (tx) => {
        const existing = await tx.recruitmentAgencyUser.findFirst({ where: withTenant(tenantId, { id: rowId }), select: USER_SELECT });
        if (!existing) throw fail("Agency user not found", "HR-RECRUITMENT-AGENCY-USER-NOT-FOUND", 404);
        if (existing.status === AGENCY_USER_STATUS.REVOKED) return { ...existing, changed: false };
        await tx.recruitmentAgencyUser.updateMany({
            where: withTenant(tenantId, { id: rowId }),
            data: { status: AGENCY_USER_STATUS.REVOKED },
        });
        logger.info({ tenantId, agencyId: existing.agencyId, agencyUserId: rowId }, "recruitment agency user revoked");
        return { ...existing, status: AGENCY_USER_STATUS.REVOKED, changed: true };
    });
}

// ── Requisition assignments ────────────────────────────────────────────────

function normalizeMaxSubmissions(value) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 1000) {
        throw fail("maxSubmissions must be a whole number between 1 and 1000", "HR-RECRUITMENT-AGENCY-INVALID");
    }
    return n;
}

/**
 * Open a requisition to an agency. Re-assigning an ENDED pair reactivates it;
 * re-assigning an ACTIVE one updates its cap and notes.
 */
export async function assignRequisitionToAgency({ tenantId, actorId = null, requisitionId, agencyId, maxSubmissions, notes, now = new Date() } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const reqId = positiveId(requisitionId, "requisition");
    const agency = positiveId(agencyId, "agency");
    const cap = normalizeMaxSubmissions(maxSubmissions);
    const note = normalizeText(notes, "notes", AGENCY_NOTES_MAX) ?? null;
    return tenantTransaction(prisma, async (tx) => {
        const requisition = await tx.jobRequisition.findFirst({
            where: withTenant(tenantId, { id: reqId }),
            select: { id: true, status: true, closesAt: true },
        });
        if (!requisition) throw fail("Requisition not found", "HR-RECRUITMENT-REQUISITION-NOT-FOUND", 404);
        if (!isRequisitionOpenForAgencies(requisition, now)) {
            throw fail("Only an open requisition can be assigned to an agency", "HR-RECRUITMENT-AGENCY-REQUISITION-NOT-OPEN", 409);
        }
        const owner = await tx.recruitmentAgency.findFirst({ where: withTenant(tenantId, { id: agency }), select: { id: true, status: true } });
        if (!owner) throw fail("Agency not found", "HR-RECRUITMENT-AGENCY-NOT-FOUND", 404);
        if (owner.status !== AGENCY_STATUS.ACTIVE) {
            throw fail("A suspended agency cannot be assigned requisitions", "HR-RECRUITMENT-AGENCY-SUSPENDED", 409);
        }
        const existing = await tx.requisitionAgencyAssignment.findFirst({
            where: withTenant(tenantId, { requisitionId: reqId, agencyId: agency }),
            select: { id: true, status: true },
        });
        if (existing) {
            await tx.requisitionAgencyAssignment.updateMany({
                where: withTenant(tenantId, { id: existing.id }),
                data: {
                    status: ASSIGNMENT_STATUS.ACTIVE,
                    maxSubmissions: cap,
                    notes: note,
                    ...(existing.status === ASSIGNMENT_STATUS.ENDED ? { endedAt: null, assignedAt: now, assignedById: actorId ?? null } : {}),
                },
            });
            const row = await tx.requisitionAgencyAssignment.findFirst({ where: withTenant(tenantId, { id: existing.id }) });
            return { ...row, reactivated: existing.status === ASSIGNMENT_STATUS.ENDED };
        }
        const row = await tx.requisitionAgencyAssignment.create({
            data: {
                tenantId,
                requisitionId: reqId,
                agencyId: agency,
                status: ASSIGNMENT_STATUS.ACTIVE,
                maxSubmissions: cap,
                notes: note,
                assignedById: actorId ?? null,
                assignedAt: now,
            },
        });
        logger.info({ tenantId, requisitionId: reqId, agencyId: agency }, "requisition assigned to agency");
        return { ...row, reactivated: false };
    });
}

export async function unassignRequisitionFromAgency({ tenantId, requisitionId, agencyId, now = new Date() } = {}) {
    requireTenant(tenantId);
    assertAgencyPortalEnabled();
    const reqId = positiveId(requisitionId, "requisition");
    const agency = positiveId(agencyId, "agency");
    return tenantTransaction(prisma, async (tx) => {
        const existing = await tx.requisitionAgencyAssignment.findFirst({
            where: withTenant(tenantId, { requisitionId: reqId, agencyId: agency }),
            select: { id: true, status: true },
        });
        if (!existing) throw fail("This requisition is not assigned to the agency", "HR-RECRUITMENT-AGENCY-ASSIGNMENT-NOT-FOUND", 404);
        if (existing.status === ASSIGNMENT_STATUS.ENDED) return { id: existing.id, requisitionId: reqId, agencyId: agency, status: ASSIGNMENT_STATUS.ENDED, changed: false };
        await tx.requisitionAgencyAssignment.updateMany({
            where: withTenant(tenantId, { id: existing.id, status: ASSIGNMENT_STATUS.ACTIVE }),
            data: { status: ASSIGNMENT_STATUS.ENDED, endedAt: now },
        });
        logger.info({ tenantId, requisitionId: reqId, agencyId: agency }, "requisition unassigned from agency");
        return { id: existing.id, requisitionId: reqId, agencyId: agency, status: ASSIGNMENT_STATUS.ENDED, changed: true };
    });
}
