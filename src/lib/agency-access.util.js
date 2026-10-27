// src/lib/agency-access.util.js
//
// Recruitment Phase 5 (plan 6.2, flag agencyPortal) — WHO an agency caller is.
//
// recruitment-access.util.js turns role claims into a row scope and must stay pure
// and synchronous (dozens of call sites resolve it inline). An AGENCY caller,
// though, is only meaningful together with a database fact: the verified RBAC
// user id is mapped to one RecruitmentAgency through RecruitmentAgencyUser.
// This module looks that fact up once per request and hands it to the scope
// resolver on the user object under the AGENCY_MEMBERSHIP symbol:
//
//   { agencyId, tenantId, userId, requisitionIds }   (frozen)
//
// requisitionIds are the agency's ACTIVE assignments. The membership is null —
// and the AGENCY scope therefore reaches no rows — when the flag is off, the
// caller has no mapping, the mapping is REVOKED or the agency is SUSPENDED.
//
// Two entry points:
//   * withAgencyMembership(user) — for the MCP router (one lookup per request,
//     so every tool that resolves a scope sees the same agency), and for the
//     agency portal tools, which call it themselves so they never depend on the
//     router having done it;
//   * assertNoAgencyExport(user) — the one-line refusal every recruitment
//     export carries: an agency never exports, whatever rows it can read.
//
// src/lib may not import src/services; this reads prisma directly, always with
// the tenant in the predicate and inside a tenant request context (both agency
// tables are FORCE RLS).
import prisma from "./prisma.js";
import logger from "./logger.js";
import { mcpCtx } from "./requestContext.js";
import { isRecruitmentFlagEnabled } from "./recruitment-flags.util.js";
import { AGENCY_MEMBERSHIP, RECRUITMENT_SCOPE, resolveRecruitmentScope } from "./recruitment-access.util.js";

export const AGENCY_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SUSPENDED: "SUSPENDED" });
export const AGENCY_USER_STATUS = Object.freeze({ ACTIVE: "ACTIVE", REVOKED: "REVOKED" });
export const ASSIGNMENT_STATUS = Object.freeze({ ACTIVE: "ACTIVE", ENDED: "ENDED" });

const fail = (message, code, status) => Object.assign(new Error(message), { status, code });

/** True when the caller's role claims resolve to the AGENCY recruitment scope. */
export const isAgencyCaller = (user) => resolveRecruitmentScope(user ?? {}).level === RECRUITMENT_SCOPE.AGENCY;

// Run the lookup inside a request context that carries this tenant, so the RLS
// extension sets app.tenant_id even when the caller (the MCP router) has not
// entered mcpCtx yet.
function inTenantContext(user, fn) {
    const store = mcpCtx.getStore();
    if (store?.user?.tenantId === user.tenantId && !store?.system) return fn();
    return mcpCtx.run({ ...(store ?? {}), system: false, user }, fn);
}

/**
 * Look up the agency the verified user acts for.
 * @param {{ tenantId: string, userId: string|number }} args
 * @returns {Promise<null | Readonly<{agencyId:number, tenantId:string, userId:string, requisitionIds:number[]}>>}
 */
export async function loadAgencyMembership({ tenantId, userId } = {}) {
    if (!isRecruitmentFlagEnabled("agencyPortal")) return null;
    if (typeof tenantId !== "string" || !tenantId || userId == null || String(userId).trim() === "") return null;
    const uid = String(userId).trim();
    const mapping = await prisma.recruitmentAgencyUser.findFirst({
        where: { tenantId, userId: uid, status: AGENCY_USER_STATUS.ACTIVE },
        select: { agencyId: true },
    });
    if (!mapping) return null;
    const agency = await prisma.recruitmentAgency.findFirst({
        where: { tenantId, id: mapping.agencyId, status: AGENCY_STATUS.ACTIVE },
        select: { id: true },
    });
    if (!agency) return null;
    const assignments = await prisma.requisitionAgencyAssignment.findMany({
        where: { tenantId, agencyId: agency.id, status: ASSIGNMENT_STATUS.ACTIVE },
        select: { requisitionId: true },
    });
    return Object.freeze({
        agencyId: agency.id,
        tenantId,
        userId: uid,
        requisitionIds: Object.freeze([...new Set(assignments.map((a) => a.requisitionId))]),
    });
}

/**
 * The user with its agency membership attached (a copy; the input is never
 * mutated). Non-agency callers come back untouched, and a user that already
 * carries a resolved membership (even a null one) is not looked up again.
 * A lookup failure fails CLOSED: the membership is null, so no rows.
 */
export async function withAgencyMembership(user) {
    if (!user || !isAgencyCaller(user)) return user;
    if (Object.prototype.hasOwnProperty.call(user, AGENCY_MEMBERSHIP)) return user;
    const membership = await inTenantContext(user, async () =>
        await loadAgencyMembership({ tenantId: user.tenantId, userId: user.userId }))
        .catch((err) => {
            logger.warn({ err: err?.message, tenantId: user.tenantId }, "agency membership lookup failed; agency scope sees no rows");
            return null;
        });
    return { ...user, [AGENCY_MEMBERSHIP]: membership };
}

/**
 * The MCP request context with the caller's agency membership attached; a
 * context without a user is returned as is.
 */
export async function withAgencyContext(ctx) {
    if (!ctx?.user) return ctx;
    const user = await withAgencyMembership(ctx.user);
    return user === ctx.user ? ctx : { ...ctx, user };
}

/**
 * Agencies never export. Throw before any export reads a row, whatever the
 * caller's grant: the agency portal is a submission channel, not a data feed.
 */
export function assertNoAgencyExport(user) {
    if (isAgencyCaller(user)) {
        throw fail("Exports are not available to recruitment agencies", "HR-RECRUITMENT-AGENCY-EXPORT-FORBIDDEN", 403);
    }
}

/**
 * Tenant-wide recruitment reads (the pipeline board, the talent pool, the
 * analytics) carry no row scope, so an agency must never reach them, even
 * through a misconfigured hr:recruitment grant. Throw before any row is read.
 */
export function assertNotAgencyCaller(user) {
    if (isAgencyCaller(user)) {
        throw fail("This view is not available to recruitment agencies", "HR-RECRUITMENT-AGENCY-SCOPE-FORBIDDEN", 403);
    }
}
