// src/services/talent-nurture.service.js — Recruitment Phase 5 / plan 6.2.
//
// TALENT POOL NURTURE: when a requisition is posted, the people kept on file
// whose skills (and, for a placed role, location) match it are proposed to the
// requisition's recruiter; the recruiter approves the segment (dropping anyone
// first) and only then are invitations sent, each valid for 30 days. The
// existing nightly invitation expiry job lapses unanswered ones. An accepted
// invitation becomes an application through the gated intake path.
//
// Why each piece is shaped the way it is:
//
//   * PROPOSE, THEN SEND. Inviting a pool is unsolicited contact, so the job
//     only builds the segment (one TalentPoolNurtureRun per requisition, even
//     when nobody matches, so the job never rebuilds it). The recruiter's send
//     is the decision, recorded with who and when.
//   * The segment excludes anyone the system must not, or need not, contact:
//     anonymised candidates, an active do-not-contact entry, withdrawn consent
//     (overall, or for TALENT_POOL), anyone who already applied to this
//     requisition or holds an open invitation for it. inviteToApply re-checks
//     DNC and consent at send time, so a register entry made after the proposal
//     still wins (the member is reported as skipped).
//   * SEND IS ONE TRANSACTION: the PROPOSED -> SENT claim, every invitation and
//     its talent_pool_invitation_sent event commit together, so a failure
//     leaves the run PROPOSED with nothing sent and a retry is safe; a second
//     send of a SENT run returns what the first one did.
//   * ACCEPTANCE goes through createApplication (the eligibility gate, the DNC
//     intake check, the stage-history row and the application_created event)
//     with sourceChannel TALENT_POOL and sourceDetail "nurture:<runId>", then
//     records an ADVANCE screening: the recruiter approved this person against
//     the requisition's segment, which is the pre-screen. The screening model
//     has no "pre-screened" flag; an ADVANCE row (reviewer = the approving
//     recruiter) is the existing way to say "screened, go on", and it does not
//     move the stage by itself.
//
// Every query carries the tenant; the cross-tenant scans of the job run under
// the system context and every requisition is worked under its own tenant with
// per-row error isolation.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
import { requisitionScopeWhere } from "../lib/recruitmentAccess.js";
import { isInvitationExpired, matchesSegment, segmentRejectionReasons } from "../lib/talentPoolPolicy.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    DEFAULT_NURTURE_VALIDITY_DAYS,
    MAX_NURTURE_MEMBERS,
    NURTURE_RUN_STATUS,
    approvedMembers,
    buildNurtureCriteria,
    checkNurtureRunTransition,
    isNurturable,
    normalizeDismissReason,
    nurtureExclusionReason,
    nurtureRunShouldExpire,
    nurtureSourceDetail,
    parseCandidateIds,
    resolveValidityDays,
    segmentFiltersFor,
} from "../lib/talent-nurture.util.js";
import { requisitionSkillRequirements } from "./candidateMatch.service.js";
import { inviteToApply } from "./talentPoolInvitation.service.js";
import { describePoolCandidates } from "./talentPoolMgmt.service.js";
import { createApplication } from "./applicationService.js";
import { recordScreening } from "./applicationScreening.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { talentPoolInvitationSentEvent } from "./hrEvents.js";

const log = logger.child({ component: "talent-nurture" });

export const TALENT_NURTURE_PROPOSED_EVENT = "hr.recruitment.talent_nurture_proposed.v1";

export const DEFAULT_NURTURE_JOB_LIMIT = 50;
const MAX_NURTURE_JOB_LIMIT = 500;
// How many active postings / proposed runs one pass reads across tenants.
const SCAN_CAP = 2000;
// How many pool memberships one segment reads (newest first).
const MAX_POOL_SCAN = 5000;
// Send writes up to MAX_NURTURE_MEMBERS invitations in one transaction.
const SEND_TX_OPTIONS = Object.freeze({ timeout: 60_000, maxWait: 10_000 });

const fail = (message, code, status) => Object.assign(new Error(message), { status, code });

const requireTenant = (tenantId) => {
    if (tenantId === undefined || tenantId === null || tenantId === "") {
        throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    }
};

const positiveId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const clampLimit = (limit, fallback, max) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : fallback;
    return n <= 0 ? fallback : Math.min(n, max);
};

/** 503 when the talentNurture flag is off (every tool calls this first). */
export function assertTalentNurtureEnabled() {
    if (!isRecruitmentFlagEnabled("talentNurture")) {
        throw fail("Talent pool nurture is disabled", "HR-RECRUITMENT-TALENT-NURTURE-DISABLED", 503);
    }
}

// Deciding a run is a recruiter's call: ORG scope only. A hiring manager can
// read their requisitions' proposals but not send them.
const requireOrg = (scope, verb) => {
    if (scope && scope.unrestricted !== true) {
        throw fail(`Only recruiters can ${verb} a talent pool nurture proposal`, "HR-RECRUITMENT-NURTURE-FORBIDDEN", 403);
    }
};

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * hr.recruitment.talent_nurture_proposed.v1 — a proposal is waiting for the
 * requisition's recruiter. Ids and a count only; recruiterId is the routing id.
 */
export function talentNurtureProposedEvent(run, ctx = {}, extra = {}) {
    if (!run?.tenantId) return null;
    return {
        eventName: TALENT_NURTURE_PROPOSED_EVENT,
        tenantId: run.tenantId,
        aggregateType: "TalentPoolNurtureRun",
        aggregateId: run.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            runId: String(run.id),
            requisitionId: String(run.requisitionId),
            proposedCount: Number(run.proposedCount ?? 0),
            recruiterId: extra?.recruiterId != null ? String(extra.recruiterId) : null,
        },
    };
}

// ── Reads shared by the job and the tools ───────────────────────────────────

const REQUISITION_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    title: true,
    status: true,
    closesAt: true,
    location: true,
    jobContent: true,
    requirements: true,
    recruiterId: true,
});

/** The requisition with its live postings and the application gate's answer. */
async function readRequisition(db, tenantId, requisitionId, now) {
    const requisition = await db.jobRequisition.findFirst({
        where: withTenant(tenantId, { id: requisitionId }),
        select: REQUISITION_SELECT,
    });
    if (!requisition) return { requisition: null, evaluation: { eligible: false, reasons: ["REQUISITION_NOT_FOUND"] } };
    const postings = await db.jobPosting.findMany({
        where: withTenant(tenantId, { requisitionId, isActive: true }),
        select: { id: true, isActive: true, closedAt: true, channel: true },
    });
    return { requisition, evaluation: evaluateRequisitionEligibility(requisition, { postings, now: new Date(now) }) };
}

const latestByCandidate = (rows) => {
    const out = new Map();
    for (const row of rows) {
        const prev = out.get(row.candidateId);
        if (!prev || new Date(row.occurredAt) > new Date(prev.occurredAt)) out.set(row.candidateId, row);
    }
    return out;
};

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

/**
 * Segment the tenant's pool for one requisition.
 *
 * The skills/location test is the pool predicate (lib/talentPoolPolicy
 * matchesSegment) over the same projection segmentTalentPool builds:
 * candidate.location and the candidate's skill names. Reads are flat (no
 * relation includes) and batched per table.
 *
 * @returns {{ candidateIds: number[], matchedTotal: number, poolCandidates: number, excludedByReason: object }}
 */
export async function segmentNurturePool({ db = prisma, tenantId, requisitionId, filters, now = new Date() }) {
    requireTenant(tenantId);
    const memberships = await db.talentPool.findMany({
        where: withTenant(tenantId, {}),
        select: { candidateId: true },
        orderBy: [{ addedAt: "desc" }, { id: "desc" }],
        take: MAX_POOL_SCAN,
    });
    const poolIds = [...new Set(memberships.map((m) => m.candidateId))];
    const empty = { candidateIds: [], matchedTotal: 0, poolCandidates: poolIds.length, excludedByReason: {} };
    if (!poolIds.length || !filters) return empty;

    const candidates = await db.candidate.findMany({
        where: withTenant(tenantId, { id: { in: poolIds } }),
        select: { id: true, email: true, location: true, anonymizedAt: true, consentStatus: true },
    });
    const ids = candidates.map((c) => c.id);
    const skills = await db.candidateSkill.findMany({
        where: withTenant(tenantId, { candidateId: { in: ids } }),
        select: { candidateId: true, name: true },
    });
    const consents = await db.candidateConsent.findMany({
        where: withTenant(tenantId, { candidateId: { in: ids }, purpose: "TALENT_POOL" }),
        select: { candidateId: true, status: true, occurredAt: true },
    });
    const emails = [...new Set(candidates.map((c) => normalizeEmail(c.email)).filter(Boolean))];
    const dncRows = emails.length
        ? await db.candidateDncEntry.findMany({
            where: {
                ...withTenant(tenantId, { email: { in: emails }, status: "ACTIVE" }),
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
            },
            select: { email: true },
        })
        : [];
    const applications = await db.application.findMany({
        where: withTenant(tenantId, { jobRequisitionId: requisitionId, candidateId: { in: ids } }),
        select: { candidateId: true },
    });
    const invitations = await db.talentPoolInvitation.findMany({
        where: withTenant(tenantId, { jobRequisitionId: requisitionId, candidateId: { in: ids }, status: "INVITED" }),
        select: { candidateId: true, status: true, expiresAt: true },
    });

    const skillsByCandidate = new Map();
    for (const row of skills) {
        if (!skillsByCandidate.has(row.candidateId)) skillsByCandidate.set(row.candidateId, []);
        if (row.name) skillsByCandidate.get(row.candidateId).push(row.name);
    }
    const talentPoolConsent = latestByCandidate(consents);
    const dncEmails = new Set(dncRows.map((row) => normalizeEmail(row.email)));
    const appliedIds = new Set(applications.map((row) => row.candidateId));
    const invitedIds = new Set(invitations.filter((row) => !isInvitationExpired(row, now)).map((row) => row.candidateId));
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const matched = [];
    const excludedByReason = {};
    const exclude = (reason) => {
        excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
    };
    // Pool order (newest membership first) is the proposal order.
    for (const candidateId of poolIds) {
        const candidate = byId.get(candidateId);
        if (!candidate) continue;
        const reason = nurtureExclusionReason({
            anonymized: Boolean(candidate.anonymizedAt),
            dnc: dncEmails.has(normalizeEmail(candidate.email)),
            consentWithdrawn:
                candidate.consentStatus === "WITHDRAWN" || talentPoolConsent.get(candidateId)?.status === "WITHDRAWN",
            applied: appliedIds.has(candidateId),
            invited: invitedIds.has(candidateId),
        });
        if (reason) {
            exclude(reason);
            continue;
        }
        const row = { location: candidate.location ?? null, skillNames: skillsByCandidate.get(candidateId) ?? [] };
        if (matchesSegment(row, filters)) matched.push(candidateId);
        else exclude(segmentRejectionReasons(row, filters)[0] || "filter");
    }

    return {
        candidateIds: matched.slice(0, MAX_NURTURE_MEMBERS),
        matchedTotal: matched.length,
        poolCandidates: poolIds.length,
        excludedByReason,
    };
}

// ── The proposal job ────────────────────────────────────────────────────────

/** Propose one requisition under its tenant: "proposed" | "empty" | "skipped" | "raceLost". */
async function proposeForRequisition(tenantId, requisitionId, now) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const existing = await tx.talentPoolNurtureRun.findFirst({
                where: withTenant(tenantId, { requisitionId }),
                select: { id: true },
            });
            if (existing) return "raceLost";
            const { requisition, evaluation } = await readRequisition(tx, tenantId, requisitionId, now);
            if (!requisition || !isNurturable(evaluation)) return "skipped";

            const criteria = buildNurtureCriteria(requisition, requisitionSkillRequirements(requisition));
            const filters = segmentFiltersFor(criteria);
            const segment = await segmentNurturePool({ db: tx, tenantId, requisitionId, filters, now });

            const run = await tx.talentPoolNurtureRun.create({
                data: {
                    tenantId,
                    requisitionId,
                    status: NURTURE_RUN_STATUS.PROPOSED,
                    criteria: {
                        ...criteria,
                        // Why a run can be empty: no skills on the requisition is
                        // a different fix from a pool that does not match.
                        ...(filters ? {} : { noSegment: "NO_SKILLS" }),
                        poolCandidates: segment.poolCandidates,
                        matchedTotal: segment.matchedTotal,
                        truncated: segment.matchedTotal > segment.candidateIds.length,
                        excludedByReason: segment.excludedByReason,
                    },
                    candidateIds: segment.candidateIds,
                    proposedCount: segment.candidateIds.length,
                    validityDays: DEFAULT_NURTURE_VALIDITY_DAYS,
                },
            });
            // Nothing to decide, nobody to tell: an empty run exists so the job
            // does not rebuild it, not to page the recruiter.
            if (run.proposedCount > 0) {
                await enqueueHrDomainEvent(
                    tx,
                    talentNurtureProposedEvent(run, { actorId: null }, { recruiterId: requisition.recruiterId }),
                );
            }
            return run.proposedCount > 0 ? "proposed" : "empty";
        },
        { tenantId },
    );
}

/** A PROPOSED run whose requisition closed becomes EXPIRED (conditional claim). */
async function expireRun(tenantId, runId) {
    const claim = await prisma.talentPoolNurtureRun.updateMany({
        where: withTenant(tenantId, { id: runId, status: NURTURE_RUN_STATUS.PROPOSED }),
        data: { status: NURTURE_RUN_STATUS.EXPIRED },
    });
    return Number(claim?.count ?? 0) === 1 ? "expired" : "raceLost";
}

const isUniqueViolation = (err) => err?.code === "P2002";

/**
 * One nightly pass: expire PROPOSED runs whose requisition closed, then propose
 * every requisition with an active posting that has no run yet.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<object>} the summary, or { skipped: "FLAG_OFF" }
 */
export async function runTalentNurtureProposalJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("talentNurture")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = clampLimit(limit, DEFAULT_NURTURE_JOB_LIMIT, MAX_NURTURE_JOB_LIMIT);
    const summary = { scanned: 0, proposed: 0, empty: 0, skipped: 0, raceLost: 0, expired: 0, errors: 0 };

    // 1. Expiry first, so a requisition that closed is not left looking live.
    const open = await mcpCtx.run({ system: true }, async () =>
        await prisma.talentPoolNurtureRun.findMany({
            where: { status: NURTURE_RUN_STATUS.PROPOSED },
            select: { id: true, tenantId: true, requisitionId: true },
            orderBy: { id: "asc" },
            take: SCAN_CAP,
        }),
    );
    if (open.length) {
        const requisitions = await mcpCtx.run({ system: true }, async () =>
            await prisma.jobRequisition.findMany({
                where: { id: { in: [...new Set(open.map((r) => r.requisitionId))] } },
                select: { id: true, tenantId: true, status: true, closesAt: true },
            }),
        );
        const byId = new Map(requisitions.map((r) => [r.id, r]));
        for (const run of open) {
            if (!run.tenantId) continue;
            const requisition = byId.get(run.requisitionId);
            if (requisition && requisition.tenantId !== run.tenantId) continue;
            if (!nurtureRunShouldExpire(requisition, at)) continue;
            try {
                const outcome = await mcpCtx.run({ user: { tenantId: run.tenantId } }, async () => await expireRun(run.tenantId, run.id));
                if (outcome === "expired") summary.expired += 1;
            } catch (err) {
                summary.errors += 1;
                log.error({ tenantId: run.tenantId, runId: run.id, code: err?.code, errMessage: err?.message }, "talent nurture: expiry failed");
            }
        }
    }

    // 2. Requisitions with a live posting and no run yet.
    const postings = await mcpCtx.run({ system: true }, async () =>
        await prisma.jobPosting.findMany({
            where: { isActive: true, closedAt: null },
            select: { requisitionId: true, tenantId: true },
            orderBy: [{ postedAt: "asc" }, { id: "asc" }],
            take: SCAN_CAP,
        }),
    );
    const tenantByRequisition = new Map();
    for (const posting of postings) {
        if (posting.tenantId && !tenantByRequisition.has(posting.requisitionId)) {
            tenantByRequisition.set(posting.requisitionId, posting.tenantId);
        }
    }
    const requisitionIds = [...tenantByRequisition.keys()];
    const withRun = requisitionIds.length
        ? await mcpCtx.run({ system: true }, async () =>
            await prisma.talentPoolNurtureRun.findMany({
                where: { requisitionId: { in: requisitionIds } },
                select: { requisitionId: true },
            }),
        )
        : [];
    const done = new Set(withRun.map((row) => row.requisitionId));
    const pending = requisitionIds.filter((id) => !done.has(id)).slice(0, take);
    summary.scanned = pending.length;

    for (const requisitionId of pending) {
        const tenantId = tenantByRequisition.get(requisitionId);
        try {
            const outcome = await mcpCtx.run({ user: { tenantId } }, async () => await proposeForRequisition(tenantId, requisitionId, at));
            summary[outcome] += 1;
        } catch (err) {
            if (isUniqueViolation(err)) {
                summary.raceLost += 1;
                continue;
            }
            summary.errors += 1;
            log.error({ tenantId, requisitionId, code: err?.code, errMessage: err?.message }, "talent nurture: proposal failed");
        }
    }
    if (summary.scanned || summary.expired || summary.errors) log.info(summary, "talent nurture: proposal pass done");
    return summary;
}

// ── The recruiter's surface ────────────────────────────────────────────────

const runView = (run, requisition = null) => ({
    id: run.id,
    requisitionId: run.requisitionId,
    requisition: requisition ? { id: requisition.id, title: requisition.title ?? null, status: requisition.status ?? null } : null,
    status: run.status,
    criteria: run.criteria ?? null,
    memberCount: parseCandidateIds(run.candidateIds).length,
    proposedCount: run.proposedCount,
    invitedCount: run.invitedCount,
    validityDays: run.validityDays,
    decidedById: run.decidedById ?? null,
    decidedAt: run.decidedAt ?? null,
    dismissedReason: run.dismissedReason ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
});

/** The requisitions a non-ORG caller may see, or null for "no restriction". */
async function visibleRequisitionIds(tenantId, scope, requisitionId) {
    if (!scope || scope.unrestricted) return null;
    if (!scope.canSeeRequisitions) return [];
    const rows = await prisma.jobRequisition.findMany({
        where: { ...withTenant(tenantId, requisitionId ? { id: requisitionId } : {}), ...requisitionScopeWhere(scope) },
        select: { id: true },
        take: SCAN_CAP,
    });
    return rows.map((r) => r.id);
}

/** Runs newest first, narrowed by status and requisition, cut to the caller's requisitions. */
export async function listNurtureRuns({ tenantId, scope = null, status = null, requisitionId = null, page = 1, limit = 20 } = {}) {
    assertTalentNurtureEnabled();
    requireTenant(tenantId);
    const resolvedPage = Number(page) > 0 ? Math.floor(Number(page)) : 1;
    const resolvedLimit = clampLimit(limit, 20, 100);
    const reqId = requisitionId == null || requisitionId === "" ? null : positiveId(requisitionId);
    if (requisitionId != null && requisitionId !== "" && !reqId) {
        throw fail("requisitionId must be a positive integer", "HR-RECRUITMENT-NURTURE-REQUISITION-INVALID", 400);
    }

    const where = withTenant(tenantId, {});
    if (status) where.status = String(status).trim().toUpperCase();
    const visible = await visibleRequisitionIds(tenantId, scope, reqId);
    if (visible) where.requisitionId = { in: visible };
    else if (reqId) where.requisitionId = reqId;

    const runs = await prisma.talentPoolNurtureRun.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (resolvedPage - 1) * resolvedLimit,
        take: resolvedLimit,
    });
    const total = await prisma.talentPoolNurtureRun.count({ where });
    const requisitions = runs.length
        ? await prisma.jobRequisition.findMany({
            where: withTenant(tenantId, { id: { in: [...new Set(runs.map((r) => r.requisitionId))] } }),
            select: { id: true, title: true, status: true },
        })
        : [];
    const byId = new Map(requisitions.map((r) => [r.id, r]));
    return {
        items: runs.map((run) => runView(run, byId.get(run.requisitionId))),
        total,
        page: resolvedPage,
        limit: resolvedLimit,
    };
}

/** A run the caller may see (through its requisition), or a 404. */
async function readVisibleRun(tenantId, scope, runId) {
    const id = positiveId(runId);
    if (!id) throw fail("runId must be a positive integer", "HR-RECRUITMENT-NURTURE-RUN-INVALID", 400);
    const run = await prisma.talentPoolNurtureRun.findFirst({ where: withTenant(tenantId, { id }) });
    if (!run) throw fail("Nurture run not found", "HR-RECRUITMENT-NURTURE-RUN-NOT-FOUND", 404);
    const requisition = await prisma.jobRequisition.findFirst({
        where: { ...withTenant(tenantId, { id: run.requisitionId }), ...(scope ? requisitionScopeWhere(scope) : {}) },
        select: { id: true, title: true, status: true, location: true, recruiterId: true },
    });
    // Out of scope reads as not found, never forbidden (recruitmentAccess).
    if (!requisition) throw fail("Nurture run not found", "HR-RECRUITMENT-NURTURE-RUN-NOT-FOUND", 404);
    return { run, requisition };
}

/**
 * One run with its members: the pool display data a recruiter already sees on
 * the talent pool screen (name, location, experience, skills, pools), plus each
 * member's invitation and resulting application once the run was sent.
 */
export async function getNurtureRun({ tenantId, scope = null, runId } = {}) {
    assertTalentNurtureEnabled();
    requireTenant(tenantId);
    const { run, requisition } = await readVisibleRun(tenantId, scope, runId);
    const candidateIds = parseCandidateIds(run.candidateIds);
    const members = await describePoolCandidates({ tenantId, candidateIds });

    const invitations = await prisma.talentPoolInvitation.findMany({
        where: withTenant(tenantId, { nurtureRunId: run.id }),
        select: { id: true, candidateId: true, status: true, invitedAt: true, expiresAt: true, respondedAt: true },
    });
    const applications = candidateIds.length
        ? await prisma.application.findMany({
            where: withTenant(tenantId, {
                jobRequisitionId: run.requisitionId,
                candidateId: { in: candidateIds },
                sourceDetail: nurtureSourceDetail(run.id),
            }),
            select: { id: true, candidateId: true, stage: true },
        })
        : [];
    const invitationBy = new Map(invitations.map((row) => [row.candidateId, row]));
    const applicationBy = new Map(applications.map((row) => [row.candidateId, row]));
    const asOf = new Date();

    return {
        ...runView(run, requisition),
        members: members.map((member) => {
            const invitation = invitationBy.get(member.candidateId) ?? null;
            const application = applicationBy.get(member.candidateId) ?? null;
            return {
                ...member,
                invitation: invitation ? { ...invitation, expired: isInvitationExpired(invitation, asOf) } : null,
                applicationId: application?.id ?? null,
            };
        }),
    };
}

/** What a SENT run did, for the idempotent second call. */
async function sentResult(tx, tenantId, run) {
    const invitations = await tx.talentPoolInvitation.findMany({
        where: withTenant(tenantId, { nurtureRunId: run.id }),
        select: { id: true },
        orderBy: { id: "asc" },
    });
    return {
        run: runView(run),
        alreadySent: true,
        invitedCount: run.invitedCount,
        invitationIds: invitations.map((row) => row.id),
    };
}

/**
 * Approve and send a proposal: invite each remaining member (the recruiter may
 * drop some first) with the run's validity, stamp nurtureRunId on each
 * invitation, and mark the run SENT. ORG only. Idempotent: a SENT run returns
 * what was sent.
 */
export async function sendNurtureRun({ tenantId, scope = null, runId, dropCandidateIds = [], validityDays, actorId = null } = {}) {
    assertTalentNurtureEnabled();
    requireTenant(tenantId);
    requireOrg(scope, "send");
    const id = positiveId(runId);
    if (!id) throw fail("runId must be a positive integer", "HR-RECRUITMENT-NURTURE-RUN-INVALID", 400);
    const actor = positiveId(actorId);
    const evtCtx = eventContext({ actorId: actor });

    return tenantTransaction(
        prisma,
        async (tx) => {
            const run = await tx.talentPoolNurtureRun.findFirst({ where: withTenant(tenantId, { id }) });
            if (!run) throw fail("Nurture run not found", "HR-RECRUITMENT-NURTURE-RUN-NOT-FOUND", 404);
            if (run.status === NURTURE_RUN_STATUS.SENT) return sentResult(tx, tenantId, run);
            const move = checkNurtureRunTransition(run.status, NURTURE_RUN_STATUS.SENT);
            if (!move.ok) throw fail(move.error, move.code, 409);

            const now = new Date();
            const { evaluation } = await readRequisition(tx, tenantId, run.requisitionId, now);
            if (!isNurturable(evaluation)) {
                throw Object.assign(
                    fail("The requisition is no longer accepting applications", "HR-RECRUITMENT-NURTURE-REQUISITION-CLOSED", 409),
                    { details: { reasons: evaluation.reasons } },
                );
            }
            const { approved, dropped, ignoredDropIds } = approvedMembers(run.candidateIds, dropCandidateIds);
            if (!approved.length) {
                throw fail("No members remain to invite; dismiss the proposal instead", "HR-RECRUITMENT-NURTURE-EMPTY", 422);
            }
            const days = resolveValidityDays(validityDays, run.validityDays ?? DEFAULT_NURTURE_VALIDITY_DAYS);

            // The claim: only one send wins; a concurrent one waits on the row
            // and then sees SENT.
            const claim = await tx.talentPoolNurtureRun.updateMany({
                where: withTenant(tenantId, { id, status: NURTURE_RUN_STATUS.PROPOSED }),
                data: {
                    status: NURTURE_RUN_STATUS.SENT,
                    decidedById: actor,
                    decidedAt: now,
                    validityDays: days,
                    // A SENT run's members are the ones the recruiter approved;
                    // proposedCount keeps what was proposed.
                    candidateIds: approved,
                },
            });
            if (Number(claim?.count ?? 0) !== 1) {
                const current = await tx.talentPoolNurtureRun.findFirst({ where: withTenant(tenantId, { id }) });
                if (current?.status === NURTURE_RUN_STATUS.SENT) return sentResult(tx, tenantId, current);
                throw fail("The nurture proposal was decided meanwhile", "HR-RECRUITMENT-NURTURE-TRANSITION-INVALID", 409);
            }

            // Someone whose pool membership ended since the proposal (the
            // pool retention sweep, or a recruiter removing them) is no longer
            // kept on file for future roles, so they are not contacted.
            const stillPooled = await tx.talentPool.findMany({
                where: withTenant(tenantId, { candidateId: { in: approved } }),
                select: { candidateId: true },
            });
            const pooled = new Set(stillPooled.map((row) => row.candidateId));

            const invitationIds = [];
            const skipped = [];
            const alreadyInvited = [];
            for (const candidateId of approved) {
                if (!pooled.has(candidateId)) {
                    skipped.push({ candidateId, code: "HR-RECRUITMENT-NURTURE-NOT-IN-POOL" });
                    continue;
                }
                let result;
                try {
                    result = await inviteToApply({
                        tenantId,
                        candidateId,
                        jobRequisitionId: run.requisitionId,
                        validityDays: days,
                        actorId: actor,
                        nurtureRunId: run.id,
                        db: tx,
                    });
                } catch (err) {
                    // A domain refusal (DNC or consent recorded since the
                    // proposal, an erased candidate) skips the member; anything
                    // else rolls the whole send back.
                    if (Number(err?.status) >= 400 && Number(err?.status) < 500) {
                        skipped.push({ candidateId, code: err.code ?? null });
                        continue;
                    }
                    throw err;
                }
                if (result.reused) {
                    alreadyInvited.push(candidateId);
                    continue;
                }
                invitationIds.push(result.invitation.id);
                await enqueueHrDomainEvent(
                    tx,
                    talentPoolInvitationSentEvent({ ...result.invitation, tenantId }, evtCtx, { reused: false }),
                );
            }

            const updated = await tx.talentPoolNurtureRun.update({
                where: { id },
                data: { invitedCount: invitationIds.length },
            });
            log.info(
                { tenantId, runId: id, invited: invitationIds.length, skipped: skipped.length, dropped: dropped.length },
                "talent nurture: proposal sent",
            );
            return {
                run: runView(updated),
                alreadySent: false,
                invitedCount: invitationIds.length,
                invitationIds,
                dropped,
                skipped,
                alreadyInvited,
                ignoredDropIds,
            };
        },
        { tenantId, txOptions: SEND_TX_OPTIONS },
    );
}

/** Dismiss a proposal with a reason. ORG only; a second dismissal returns the run. */
export async function dismissNurtureRun({ tenantId, scope = null, runId, reason, actorId = null } = {}) {
    assertTalentNurtureEnabled();
    requireTenant(tenantId);
    requireOrg(scope, "dismiss");
    const id = positiveId(runId);
    if (!id) throw fail("runId must be a positive integer", "HR-RECRUITMENT-NURTURE-RUN-INVALID", 400);
    const text = normalizeDismissReason(reason);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const run = await tx.talentPoolNurtureRun.findFirst({ where: withTenant(tenantId, { id }) });
            if (!run) throw fail("Nurture run not found", "HR-RECRUITMENT-NURTURE-RUN-NOT-FOUND", 404);
            if (run.status === NURTURE_RUN_STATUS.DISMISSED) return { run: runView(run), alreadyDismissed: true };
            const move = checkNurtureRunTransition(run.status, NURTURE_RUN_STATUS.DISMISSED);
            if (!move.ok) throw fail(move.error, move.code, 409);
            const claim = await tx.talentPoolNurtureRun.updateMany({
                where: withTenant(tenantId, { id, status: NURTURE_RUN_STATUS.PROPOSED }),
                data: {
                    status: NURTURE_RUN_STATUS.DISMISSED,
                    dismissedReason: text,
                    decidedById: positiveId(actorId),
                    decidedAt: new Date(),
                },
            });
            if (Number(claim?.count ?? 0) !== 1) {
                throw fail("The nurture proposal was decided meanwhile", "HR-RECRUITMENT-NURTURE-TRANSITION-INVALID", 409);
            }
            const updated = await tx.talentPoolNurtureRun.findFirst({ where: withTenant(tenantId, { id }) });
            return { run: runView(updated), alreadyDismissed: false };
        },
        { tenantId },
    );
}

// ── Acceptance: the invitation becomes a pre-screened application ───────────

const SCREENING_NOTE = (runId) =>
    `Pre-screened by talent pool nurture run ${runId}: the recruiter approved this pool member against the requisition's skills and location segment.`;

/**
 * Called by respondToInvitation (ACCEPTED, flag on) BEFORE the invitation is
 * marked accepted, so a gate refusal (applications closed, do-not-contact)
 * refuses the acceptance and the invitation stays open, and a failure after
 * the application exists heals on retry (the existing application is reused).
 *
 * @returns {Promise<null|{applicationId:number, created:boolean, preScreened:boolean}>}
 *          null when the invitation is not a nurture invitation for a requisition.
 */
export async function intakeAcceptedNurtureInvitation({ tenantId, invitation } = {}) {
    requireTenant(tenantId);
    const runId = positiveId(invitation?.nurtureRunId);
    const requisitionId = positiveId(invitation?.jobRequisitionId);
    const candidateId = positiveId(invitation?.candidateId);
    if (!runId || !requisitionId || !candidateId) return null;

    const findExisting = async () =>
        await prisma.application.findFirst({
            where: withTenant(tenantId, { candidateId, jobRequisitionId: requisitionId }),
            select: { id: true },
        });
    const existing = await findExisting();
    if (existing) return { applicationId: existing.id, created: false, preScreened: false };

    const run = await prisma.talentPoolNurtureRun.findFirst({
        where: withTenant(tenantId, { id: runId }),
        select: { id: true, decidedById: true },
    });
    const recruiterId = positiveId(run?.decidedById);

    let application;
    try {
        application = await createApplication({
            candidateId,
            jobRequisitionId: requisitionId,
            tenantId,
            // undefined, not null: the intake records a missing creator as null
            // only for a non-numeric value.
            createdById: recruiterId ?? undefined,
            source: "talent-pool",
            sourceChannel: "TALENT_POOL",
            sourceDetail: nurtureSourceDetail(runId),
        });
    } catch (err) {
        // A concurrent acceptance created it first: the same outcome.
        if (isUniqueViolation(err)) {
            const raced = await findExisting();
            if (raced) return { applicationId: raced.id, created: false, preScreened: false };
        }
        throw err;
    }

    let preScreened = false;
    try {
        await recordScreening({
            applicationId: application.id,
            tenantId,
            outcome: "ADVANCE",
            notes: SCREENING_NOTE(runId),
            actorId: recruiterId,
        });
        preScreened = true;
    } catch (err) {
        // The application stands (sourceDetail still names the run); only the
        // screening row is missing, which a recruiter can record by hand.
        log.warn(
            { tenantId, applicationId: application.id, runId, code: err?.code, errMessage: err?.message },
            "talent nurture: pre-screen record failed",
        );
    }
    return { applicationId: application.id, created: true, preScreened };
}
