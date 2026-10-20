// src/services/internal-referral.service.js
//
// Recruitment Phase 5 (plan 6.2) — employee referrals, the HR side:
//
//   * the referral list HR works from (filters status, bonusStatus, referrer,
//     requisition; row scope from resolveRecruitmentScope, the bonus amount
//     only for a compensation scope);
//   * the bonus decisions (APPROVED with amount and currency, PAID, FORFEITED
//     with a coded reason), each guarded by the version the caller read;
//   * the status sync: a referral follows its application. The application
//     workflow calls syncReferralFromApplicationInTx inside the stage-move
//     transaction, so a referral can never say IN_PROCESS for an application
//     that was rejected, or miss the hire its bonus depends on;
//   * the bonus clock (runReferralBonusJob, daily): a HIRED referral whose
//     wait (referralBonusWaitDays after the hire's start date) has passed
//     becomes ELIGIBLE while the hire still works here, or FORFEITED
//     (HIRE_SEPARATED) when they have left.
//
// The employee side (the board, applying, submitting a referral) lives in
// internal-board.service.js. This module imports nothing from the application
// services, so the workflow can import the sync without an import cycle.
//
// Events (ids only): hr.recruitment.referral_submitted.v1 (to the recruiter)
// and hr.recruitment.referral_bonus_eligible.v1 (to HR). Their builders are
// here so both services share one payload shape.
//
// Phase 6:
//   * a FORFEITED bonus keeps its coded reason and note on the row
//     (bonusForfeitReason, bonusNote), written by the HR decision and by the
//     clock (HIRE_SEPARATED), and returned on the HR list;
//   * the referrer's own view (selfReferralView) never shows a suppressed
//     referral (do-not-contact, archived or consent-withdrawn contact) as
//     closed at once: it reads SUBMITTED like any fresh referral and REJECTED
//     only SUPPRESSED_REFERRAL_CLOSE_DAYS after it was made. HR sees the
//     true status;
//   * the agency rule at referral intake (recordAgencyOwnedReferralInTx): a
//     referral of a candidate an agency owns inside its window is recorded as
//     DUPLICATE with no application and no bonus, the same answer a second
//     agency's submission gets (agency-submission.service.js).
// The same singleton as lib/prisma.js, through the re-export the application
// workflow uses: the workflow imports this module, and its suites replace
// config/prisma.js (a direct lib/prisma import would load the real client).
import prisma from "../config/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { requisitionScopeWhere } from "../lib/recruitmentAccess.js";
import {
    BONUS_STATUS,
    BONUS_STATUSES,
    OPEN_REFERRAL_STATUSES,
    REFERRAL_STATUS,
    REFERRAL_STATUSES,
    addDays,
    assertBonusTransition,
    isStillEmployed,
    normalizeBonusAmount,
    normalizeCurrency,
    normalizeForfeitReason,
    referralStatusForStage,
    toHrReferral,
    toSelfReferral,
} from "../lib/internal-mobility.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { logAction } from "../utils/logs.js";

// No logger.child at load time: workflow suites mock the logger with a plain
// { info, warn, error } double.
const COMPONENT = "internal-referral";
const log = {
    info: (fields, msg) => logger.info({ component: COMPONENT, ...fields }, msg),
    error: (fields, msg) => logger.error({ component: COMPONENT, ...fields }, msg),
};

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const idStr = (value) => (value != null ? String(value) : null);
const isoStr = (value) => (value ? new Date(value).toISOString() : null);

export const INTERNAL_BOARD_DISABLED_CODE = "HR-RECRUITMENT-INTERNAL-BOARD-DISABLED";

/** 503 while the internalBoard flag is off (clients see HR-5031). */
export function assertInternalBoardEnabled() {
    if (!isRecruitmentFlagEnabled("internalBoard")) {
        throw fail("The internal job board is not enabled", 503, INTERNAL_BOARD_DISABLED_CODE);
    }
}

// ── Event builders ──────────────────────────────────────────────────────────

function referralEvent(eventName, referral, ctx, payload) {
    if (!referral?.tenantId) return null;
    return {
        eventName,
        tenantId: referral.tenantId,
        aggregateType: "InternalReferral",
        aggregateId: referral.id,
        actorId: ctx?.actorId ?? undefined,
        correlationId: ctx?.correlationId,
        payload,
    };
}

/**
 * A referral was submitted (SUBMITTED with a new application, or DUPLICATE of
 * an applicant already in process). Routed to the requisition's recruiter,
 * falling back to its hiring manager.
 */
export function referralSubmittedEvent(referral, ctx = {}, { recruiterId = null, requestedById = null, duplicateReason = null } = {}) {
    return referralEvent("hr.recruitment.referral_submitted.v1", referral, ctx, {
        referralId: idStr(referral?.id),
        requisitionId: idStr(referral?.requisitionId),
        referrerEmployeeId: idStr(referral?.referrerEmployeeId),
        candidateId: idStr(referral?.candidateId),
        applicationId: idStr(referral?.applicationId),
        status: referral?.status ?? null,
        recruiterId: idStr(recruiterId),
        requestedById: idStr(requestedById),
        // A coded reason, only on a DUPLICATE the agency rule made.
        ...(duplicateReason ? { duplicateReason } : {}),
    });
}

// ── The referrer's own view ─────────────────────────────────────────────────

// How long a suppressed referral reads as SUBMITTED to its referrer before it
// reads REJECTED. A fixed delay, measured from the referral, so the closing
// time says nothing about why: a normal referral can also be turned down at
// screening within a few weeks, and one that is still open after this long is
// just as plausible.
export const SUPPRESSED_REFERRAL_CLOSE_DAYS = 21;

/**
 * A suppressed referral (pure): intake recorded it REJECTED with no candidate
 * link and no application. Every other referral has a candidate (a DUPLICATE
 * links the existing one; a SUBMITTED one its new application), so this shape
 * is only ever the suppression path; no column is needed.
 */
export function isSuppressedReferral(row) {
    return row?.status === REFERRAL_STATUS.REJECTED && row?.candidateId == null && row?.applicationId == null;
}

/**
 * The referrer's own view (toSelfReferral) with the suppression masked: a
 * suppressed referral is indistinguishable from a fresh SUBMITTED one (bonus
 * NOT_ELIGIBLE, like every fresh referral) until SUPPRESSED_REFERRAL_CLOSE_DAYS
 * after it was made, then reads REJECTED like any unsuccessful referral.
 * The row needs status, candidateId, applicationId and createdAt.
 */
export function selfReferralView(row, { jobTitle = null, now = new Date() } = {}) {
    const view = toSelfReferral(row, { jobTitle });
    if (!isSuppressedReferral(row)) return view;
    const made = row.createdAt ? new Date(row.createdAt) : null;
    const closed = made && !Number.isNaN(made.getTime()) && new Date(now).getTime() >= addDays(made, SUPPRESSED_REFERRAL_CLOSE_DAYS).getTime();
    return { ...view, status: closed ? REFERRAL_STATUS.REJECTED : REFERRAL_STATUS.SUBMITTED, bonusStatus: BONUS_STATUS.NOT_ELIGIBLE };
}

// ── The agency rule at referral intake ──────────────────────────────────────

export const REFERRAL_DUPLICATE_AGENCY_OWNED = "AGENCY_OWNERSHIP";

/**
 * The agency's live claim on a candidate, or null (pure): an ownerAgencyId
 * whose ownershipExpiresAt is still ahead. The same window the agency
 * duplicate rule reads (agency-submission.service.js duplicateReasonFor).
 */
export function liveAgencyOwnership(candidate, now = new Date()) {
    const agencyId = positiveInt(candidate?.ownerAgencyId);
    const expires = candidate?.ownershipExpiresAt ? new Date(candidate.ownershipExpiresAt) : null;
    if (!agencyId || !expires || Number.isNaN(expires.getTime())) return null;
    return expires.getTime() > new Date(now).getTime() ? { agencyId, expiresAt: expires } : null;
}

/**
 * On the referral's transaction, for an EXISTING candidate: when an agency
 * owns them inside its window, record the referral as DUPLICATE (candidate
 * linked, no application, so no bonus clock), tell the recruiter with the
 * coded reason, and note the agency in the audit trail. Returns that referral,
 * or null when no agency holds a live claim (the caller goes on as before).
 *
 * The referrer sees DUPLICATE, the same status as "already in process"; the
 * agency is never named to them.
 *
 * @param {object} tx the referral's tenant transaction
 * @param {{ tenantId: string, candidateId: number, base: object, ctx?: object, routing?: object, now?: Date }} args
 *   base: the referral columns the caller built (tenantId, requisitionId,
 *   referrerEmployeeId, relationship, note)
 */
export async function recordAgencyOwnedReferralInTx(tx, { tenantId, candidateId, base, ctx = {}, routing = {}, now = new Date() } = {}) {
    const id = positiveInt(candidateId);
    if (!tenantId || !id) return null;
    const owner = await tx.candidate.findFirst({
        where: withTenant(tenantId, { id }),
        select: { id: true, ownerAgencyId: true, ownershipExpiresAt: true },
    });
    const claim = liveAgencyOwnership(owner, now);
    if (!claim) return null;

    const referral = await tx.internalReferral.create({
        data: { ...base, tenantId, candidateId: id, status: REFERRAL_STATUS.DUPLICATE },
    });
    await enqueueHrDomainEvent(
        tx,
        referralSubmittedEvent(referral, ctx, { ...routing, duplicateReason: REFERRAL_DUPLICATE_AGENCY_OWNED }),
    );
    await logAction({
        employeeId: positiveInt(base?.referrerEmployeeId),
        type: "CREATE",
        module: "InternalReferral",
        result: "SUCCESS",
        notes: `Referral "${referral.id}" recorded DUPLICATE: candidate #${id} is owned by agency ${claim.agencyId} until ${claim.expiresAt.toISOString()}`,
        tenantId,
    });
    log.info({ tenantId, referralId: referral.id, agencyId: claim.agencyId }, "referral of an agency-owned candidate recorded as duplicate");
    return referral;
}

/** A referral bonus's wait is over and the hire is still here: HR decides. */
export function referralBonusEligibleEvent(referral, ctx = {}, { hiredEmployeeId = null, referrerEmployed = null } = {}) {
    return referralEvent("hr.recruitment.referral_bonus_eligible.v1", referral, ctx, {
        referralId: idStr(referral?.id),
        requisitionId: idStr(referral?.requisitionId),
        applicationId: idStr(referral?.applicationId),
        referrerEmployeeId: idStr(referral?.referrerEmployeeId),
        hiredEmployeeId: idStr(hiredEmployeeId),
        bonusEligibleAt: isoStr(referral?.bonusEligibleAt),
        // HR decides what a separated referrer means for the payout; the clock
        // only reports it.
        referrerEmployed: typeof referrerEmployed === "boolean" ? referrerEmployed : null,
        notifyRole: "HR",
    });
}

// ── Status sync (called by the application workflow) ────────────────────────

// The column default (tenant_recruitment_settings.referralBonusWaitDays) and
// RECRUITMENT_SETTINGS_DEFAULTS. Not imported from the settings service: the
// application workflow imports this module, and many workflow suites replace
// that service with a partial double.
export const DEFAULT_REFERRAL_BONUS_WAIT_DAYS = 90;

async function bonusWaitDays(tx, tenantId) {
    const row = await tx.tenantRecruitmentSettings?.findUnique?.({
        where: { tenantId },
        select: { referralBonusWaitDays: true },
    });
    const days = Number(row?.referralBonusWaitDays);
    return Number.isInteger(days) && days >= 0 ? days : DEFAULT_REFERRAL_BONUS_WAIT_DAYS;
}

/**
 * Keep the referrals on one application in step with its new stage, on the
 * caller's transaction (the stage move's), so the two commit together.
 *
 * screening / interview / offer / on_hold -> IN_PROCESS; rejected -> REJECTED;
 * withdrawn -> WITHDRAWN; hired -> HIRED with hiredAt = the offer's start date
 * (now when the offer has none) and the bonus PENDING until hiredAt plus the
 * tenant's referralBonusWaitDays (stamped now, so a later settings change does
 * not move a clock that is already running). Only SUBMITTED and IN_PROCESS
 * referrals move; DUPLICATE ones have no application of their own.
 *
 * Deliberately not behind the internalBoard flag: it only ever touches
 * referral rows that exist, and a flag switched off for a while must not leave
 * those rows behind their applications. Fail-soft on a client with no
 * internalReferral model (unit-test doubles of the workflow).
 *
 * @param {object} tx the caller's tenant transaction client
 * @param {{ tenantId: string, applicationId: number, stage: string, now?: Date }} args
 * @returns {Promise<{ updated: number, status?: string }>}
 */
export async function syncReferralFromApplicationInTx(tx, { tenantId, applicationId, stage, now = new Date() } = {}) {
    const target = referralStatusForStage(stage);
    const appId = positiveInt(applicationId);
    if (!target || !tenantId || !appId || typeof tx?.internalReferral?.findMany !== "function") return { updated: 0 };

    const referrals = await tx.internalReferral.findMany({
        where: withTenant(tenantId, { applicationId: appId, status: { in: [...OPEN_REFERRAL_STATUSES] } }),
        select: { id: true, status: true, bonusStatus: true },
    });
    if (!Array.isArray(referrals) || !referrals.length) return { updated: 0 };

    let hire = null;
    if (target === REFERRAL_STATUS.HIRED) {
        const offer = await tx.offer.findFirst({
            where: withTenant(tenantId, { applicationId: appId }),
            select: { startDate: true },
        });
        const hiredAt = offer?.startDate ? new Date(offer.startDate) : new Date(now);
        hire = { hiredAt, bonusEligibleAt: addDays(hiredAt, await bonusWaitDays(tx, tenantId)) };
    }

    let updated = 0;
    for (const referral of referrals) {
        if (referral.status === target) continue;
        const data = { status: target, version: { increment: 1 } };
        if (hire) {
            data.hiredAt = hire.hiredAt;
            // A bonus someone already decided on is never reset by a re-sync.
            if (referral.bonusStatus === BONUS_STATUS.NOT_ELIGIBLE) {
                data.bonusStatus = BONUS_STATUS.PENDING;
                data.bonusEligibleAt = hire.bonusEligibleAt;
            }
        }
        // Conditional on the status read, so a concurrent move is not overwritten.
        const result = await tx.internalReferral.updateMany({
            where: withTenant(tenantId, { id: referral.id, status: referral.status }),
            data,
        });
        updated += Number(result?.count ?? 0);
    }
    return { updated, status: target };
}

// ── HR: list ─────────────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 100;
// A manager's own requisitions; more than this is not a manager's list.
const MAX_SCOPED_REQUISITIONS = 1000;

const upperOrNull = (value) => {
    const text = String(value ?? "").trim().toUpperCase();
    return text || null;
};

/**
 * The referrals HR (or a hiring manager, for their own requisitions) can see.
 * ORG sees all, MANAGED sees the referrals on the requisitions they own, every
 * other scope an empty page. The bonus amount and currency only reach a scope
 * that may see compensation.
 */
export async function listReferrals({
    tenantId,
    scope,
    status,
    bonusStatus,
    referrerEmployeeId,
    requisitionId,
    page = 1,
    pageSize = 50,
} = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), MAX_PAGE_SIZE);
    const pageNo = Math.max(Number(page) || 1, 1);
    const empty = { items: [], total: 0, page: pageNo, pageSize: size };

    const statusFilter = upperOrNull(status);
    const bonusFilter = upperOrNull(bonusStatus);
    if (statusFilter && !REFERRAL_STATUSES.includes(statusFilter)) {
        throw fail(`status must be one of: ${REFERRAL_STATUSES.join(", ")}`, 400, "HR-RECRUITMENT-REFERRAL-FILTER-INVALID");
    }
    if (bonusFilter && !BONUS_STATUSES.includes(bonusFilter)) {
        throw fail(`bonusStatus must be one of: ${BONUS_STATUSES.join(", ")}`, 400, "HR-RECRUITMENT-REFERRAL-FILTER-INVALID");
    }

    const where = withTenant(tenantId, {
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(bonusFilter ? { bonusStatus: bonusFilter } : {}),
        ...(positiveInt(referrerEmployeeId) ? { referrerEmployeeId: positiveInt(referrerEmployeeId) } : {}),
    });
    const wanted = positiveInt(requisitionId);

    if (scope?.unrestricted === true) {
        if (wanted) where.requisitionId = wanted;
    } else {
        if (!scope?.canSeeRequisitions) return empty;
        const owned = await prisma.jobRequisition.findMany({
            where: withTenant(tenantId, requisitionScopeWhere(scope)),
            select: { id: true },
            take: MAX_SCOPED_REQUISITIONS,
        });
        const ids = owned.map((r) => r.id).filter((id) => !wanted || id === wanted);
        if (!ids.length) return empty;
        where.requisitionId = { in: ids };
    }

    const [total, rows] = await Promise.all([
        prisma.internalReferral.count({ where }),
        prisma.internalReferral.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (pageNo - 1) * size,
            take: size,
        }),
    ]);
    const titles = await requisitionTitles(tenantId, rows.map((r) => r.requisitionId));
    const canSeeCompensation = scope?.canSeeCompensation === true;
    return {
        items: rows.map((row) => hrReferralView(row, { jobTitle: titles.get(row.requisitionId) ?? null, canSeeCompensation })),
        total,
        page: pageNo,
        pageSize: size,
    };
}

/**
 * HR's view of a referral (toHrReferral) plus the Phase 6 forfeit columns: the
 * coded reason for anyone who sees the row, the free-text note only for a
 * compensation scope (it explains a pay decision).
 */
export function hrReferralView(row, { jobTitle = null, canSeeCompensation = false } = {}) {
    return {
        ...toHrReferral(row, { jobTitle, canSeeCompensation }),
        bonusForfeitReason: row.bonusForfeitReason ?? null,
        bonusNote: canSeeCompensation ? row.bonusNote ?? null : null,
    };
}

/** Requisition id -> title, tenant-scoped (one query). */
export async function requisitionTitles(tenantId, ids, db = prisma) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await db.jobRequisition.findMany({
        where: withTenant(tenantId, { id: { in: unique } }),
        select: { id: true, title: true },
    });
    return new Map(rows.map((r) => [r.id, r.title]));
}

// ── HR: bonus decisions ─────────────────────────────────────────────────────

/**
 * Decide a referral bonus: APPROVED (from ELIGIBLE, with amount and
 * currency), PAID (from APPROVED), FORFEITED (from ELIGIBLE or APPROVED, with a
 * coded reason). The caller passes the version it read; a stale one is a 409.
 *
 * A FORFEITED decision writes its coded reason and note on the row
 * (bonusForfeitReason, bonusNote) and to the audit trail. FORFEITED is final
 * (no decision leaves it), but every other decision clears both columns, so a
 * row can never carry a reason for a status it is not in.
 */
export async function updateReferralBonus({
    tenantId,
    referralId,
    expectedVersion,
    bonusStatus,
    amount,
    currency,
    reason,
    note,
    actorId = null,
    now = new Date(),
} = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const id = positiveInt(referralId);
    if (!id) throw fail("Referral not found", 404, "HR-RECRUITMENT-REFERRAL-NOT-FOUND");
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected) || expected < 0) {
        throw fail("expectedVersion is required", 400, "HR-RECRUITMENT-REFERRAL-VERSION-REQUIRED");
    }
    const target = upperOrNull(bonusStatus);

    // Validate the decision's own inputs before any read.
    const decision = { bonusStatus: target };
    if (target === BONUS_STATUS.APPROVED) {
        decision.bonusAmount = normalizeBonusAmount(amount);
        decision.bonusCurrency = normalizeCurrency(currency);
    }
    const forfeit = target === BONUS_STATUS.FORFEITED ? normalizeForfeitReason(reason, note) : null;
    const actor = positiveInt(actorId);

    const row = await tenantTransaction(
        prisma,
        async (tx) => {
            const existing = await tx.internalReferral.findFirst({ where: withTenant(tenantId, { id }) });
            if (!existing) throw fail("Referral not found", 404, "HR-RECRUITMENT-REFERRAL-NOT-FOUND");
            const stale = () =>
                fail(
                    "The referral was changed by someone else; reload it and try again",
                    409,
                    "HR-RECRUITMENT-REFERRAL-VERSION-CONFLICT",
                    { currentVersion: existing.version },
                );
            if (existing.version !== expected) throw stale();
            assertBonusTransition(existing.bonusStatus, target);

            const claim = await tx.internalReferral.updateMany({
                where: withTenant(tenantId, { id, version: expected, bonusStatus: existing.bonusStatus }),
                data: {
                    ...decision,
                    bonusForfeitReason: forfeit ? forfeit.reason : null,
                    bonusNote: forfeit ? forfeit.note : null,
                    bonusDecidedById: actor,
                    bonusDecidedAt: new Date(now),
                    version: { increment: 1 },
                },
            });
            if (Number(claim?.count ?? 0) !== 1) throw stale();

            await logAction({
                employeeId: actor,
                type: "UPDATE",
                module: "InternalReferral",
                result: "SUCCESS",
                notes: `Referral "${id}" bonus ${existing.bonusStatus} -> ${target}${
                    forfeit ? ` (reason ${forfeit.reason}${forfeit.note ? `: ${forfeit.note}` : ""})` : ""
                }`,
                tenantId,
            });
            return tx.internalReferral.findFirst({ where: withTenant(tenantId, { id }) });
        },
        { tenantId },
    );

    const titles = await requisitionTitles(tenantId, [row.requisitionId]);
    return hrReferralView(row, { jobTitle: titles.get(row.requisitionId) ?? null, canSeeCompensation: true });
}

// ── The bonus clock ─────────────────────────────────────────────────────────

export const DEFAULT_BONUS_JOB_LIMIT = 200;
const MAX_BONUS_JOB_LIMIT = 1000;

const clampLimit = (limit) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : DEFAULT_BONUS_JOB_LIMIT;
    return n <= 0 ? DEFAULT_BONUS_JOB_LIMIT : Math.min(n, MAX_BONUS_JOB_LIMIT);
};

// The clock's own forfeit: the referred hire has left (BONUS_FORFEIT_REASONS).
export const AUTOMATIC_FORFEIT_REASON = "HIRE_SEPARATED";

const EMPLOYMENT_SELECT = Object.freeze({ id: true, separatedAt: true, status: true, employement_status: true });

/** The employee the hire handoff created for this referral's application. */
async function hiredEmployeeFor(tx, tenantId, applicationId) {
    if (!applicationId) return null;
    const offer = await tx.offer.findFirst({
        where: withTenant(tenantId, { applicationId }),
        select: { id: true },
    });
    if (!offer) return null;
    const handoff = await tx.offerHandoff.findFirst({
        where: withTenant(tenantId, { offerId: offer.id }),
        select: { employeeId: true },
    });
    if (!positiveInt(handoff?.employeeId)) return null;
    return tx.employee.findFirst({
        where: { id: handoff.employeeId, tenant_id: tenantId },
        select: EMPLOYMENT_SELECT,
    });
}

/** Settle one due referral under its tenant: eligible | forfeited | awaitingHandoff | raceLost. */
async function settleBonus(tenantId, referralId, now) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const referral = await tx.internalReferral.findFirst({
                where: withTenant(tenantId, {
                    id: referralId,
                    status: REFERRAL_STATUS.HIRED,
                    bonusStatus: BONUS_STATUS.PENDING,
                }),
            });
            if (!referral) return "raceLost";

            const hire = await hiredEmployeeFor(tx, tenantId, referral.applicationId);
            // No employee yet (the handoff has not completed): keep waiting.
            if (!hire) return "awaitingHandoff";

            const employed = isStillEmployed(hire, now);
            const claim = await tx.internalReferral.updateMany({
                where: withTenant(tenantId, {
                    id: referral.id,
                    status: REFERRAL_STATUS.HIRED,
                    bonusStatus: BONUS_STATUS.PENDING,
                }),
                data: employed
                    ? { bonusStatus: BONUS_STATUS.ELIGIBLE, version: { increment: 1 } }
                    : {
                          bonusStatus: BONUS_STATUS.FORFEITED,
                          bonusForfeitReason: AUTOMATIC_FORFEIT_REASON,
                          bonusNote: null,
                          bonusDecidedAt: new Date(now),
                          bonusDecidedById: null,
                          version: { increment: 1 },
                      },
            });
            if (Number(claim?.count ?? 0) !== 1) return "raceLost";

            if (!employed) {
                await logAction({
                    employeeId: null,
                    type: "UPDATE",
                    module: "InternalReferral",
                    result: "SUCCESS",
                    notes: `Referral "${referral.id}" bonus PENDING -> FORFEITED (reason ${AUTOMATIC_FORFEIT_REASON}, automatic)`,
                    tenantId,
                });
                return "forfeited";
            }

            const referrer = await tx.employee.findFirst({
                where: { id: referral.referrerEmployeeId, tenant_id: tenantId },
                select: EMPLOYMENT_SELECT,
            });
            await enqueueHrDomainEvent(
                tx,
                referralBonusEligibleEvent(
                    { ...referral, tenantId, bonusStatus: BONUS_STATUS.ELIGIBLE },
                    { actorId: null },
                    { hiredEmployeeId: hire.id, referrerEmployed: isStillEmployed(referrer, now) },
                ),
            );
            return "eligible";
        },
        { tenantId },
    );
}

/**
 * Daily: every HIRED referral whose bonus clock has run out (bonusEligibleAt
 * stamped at the hire, = start date + referralBonusWaitDays) becomes ELIGIBLE
 * when the hire still works here, FORFEITED when they have left. Cross-tenant
 * scan under the system context, each row settled under its own tenant with
 * a conditional claim (idempotent; a second run finds nothing), one failing
 * row never stops the rest.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<object>} { scanned, eligible, forfeited, awaitingHandoff, raceLost, errors } or { skipped: "FLAG_OFF" }
 */
export async function runReferralBonusJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("internalBoard")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const summary = { scanned: 0, eligible: 0, forfeited: 0, awaitingHandoff: 0, raceLost: 0, errors: 0 };

    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.internalReferral.findMany({
            where: {
                status: REFERRAL_STATUS.HIRED,
                bonusStatus: BONUS_STATUS.PENDING,
                bonusEligibleAt: { lte: at },
            },
            select: { id: true, tenantId: true },
            orderBy: [{ bonusEligibleAt: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = due.length;

    for (const row of due) {
        if (!row.tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
                await settleBonus(row.tenantId, row.id, at),
            );
            summary[outcome] += 1;
        } catch (err) {
            summary.errors += 1;
            log.error(
                { tenantId: row.tenantId, referralId: row.id, code: err?.code, errMessage: err?.message },
                "referral bonus job: row failed",
            );
        }
    }
    if (summary.scanned) log.info(summary, "referral bonus job: pass done");
    return summary;
}
