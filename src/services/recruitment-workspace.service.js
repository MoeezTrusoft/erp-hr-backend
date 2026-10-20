// src/services/recruitment-workspace.service.js
//
// Recruitment Phase 3a — the INTERVIEWER and HIRING MANAGER workspaces.
//
// The plan: "Interviewer workspace: my interviews, packet view, scorecard
// entry, decision prompt." "Hiring manager workspace: my requisitions,
// shortlist review with masked notes, decisions."
//
// Both are read-only, tenant-scoped (withTenant) and cut by the same scope
// predicates the list endpoints use (src/lib/recruitmentAccess.js); a scope
// with no reach gets empty sections, never a 403.
//
// Interviewer workspace rules:
//   * "My interviews" means the caller sits on the panel: the assignment is
//     the authority (as in the packet view), composed with interviewScopeWhere
//     so the scopes that read no interviews (finance, agency) still read none.
//   * The packet is summarised as counts and packet item ids an assigned
//     interviewer may open (the documentAccess matrix); no document contents.
//   * Independent scoring: another panelist's scorecard is visible to me only
//     once mine is SUBMITTED, so an earlier score cannot anchor mine (the rule
//     ownScorecardsOnly in interview.service.js states for panelists). Until
//     then the workspace reports only that the panel exists.
//   * Decision prompts addressed to me: interviews on requisitions I requested
//     (the hiring manager) that were prompted and still have no decision.
//
// Hiring manager workspace rules:
//   * MANAGED reads the requisitions it requested or approved
//     (requisitionScopeWhere). ORG reads the tenant, or one manager's with
//     managerEmployeeId. Every other scope reads nothing.
//   * Requisitions are paginated; the other sections are capped lists with
//     their totals. Shortlist notes follow the internal-notes mask; offers
//     carry no compensation at all.
import prisma from "../lib/prisma.js";
import { withTenant } from "../lib/tenancy.js";
import {
    RECRUITMENT_SCOPE,
    applicationScopeWhere,
    interviewScopeWhere,
    offerScopeWhere,
    requisitionScopeWhere,
} from "../lib/recruitmentAccess.js";
import { AUDIENCES, resolvePacketView } from "../lib/documentAccess.js";
import { activePanel, interviewEnd, missingScorecards } from "./interview-reminder.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_WINDOW_DAYS = 14;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const AWAITING_SCAN_CAP = 500;

export const SCORECARD_STATE = Object.freeze({ NOT_STARTED: "NOT_STARTED", DRAFT: "DRAFT", SUBMITTED: "SUBMITTED" });
export const OPEN_REQUISITION_STATUSES = Object.freeze(["DRAFT", "PENDING_APPROVAL", "APPROVED", "POSTED"]);
const REQUISITION_STATUSES = Object.freeze([...OPEN_REQUISITION_STATUSES, "REJECTED", "CLOSED", "WITHDRAWN"]);
const SCORING_PROPOSAL = "SCORING_PROPOSAL";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const listLimit = (value, fallback = DEFAULT_LIST_LIMIT) =>
    Math.min(Math.max(Number(value) || fallback, 1), MAX_LIST_LIMIT);

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
};

/** The candidate's name as the scope may show it: none for scopes without candidates, none once anonymised. */
function candidateDisplay(candidate, scope) {
    if (!candidate) return { candidateName: null };
    if (scope?.canSeeCandidates === false || candidate.anonymizedAt) {
        return { candidateName: null, candidateNameRedacted: true };
    }
    const name = [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim();
    return { candidateName: name || null };
}

const recommendationCounts = (scorecards = []) =>
    scorecards
        .filter((card) => card.submittedAt)
        .reduce((acc, card) => {
            const key = card.recommendation || "UNSPECIFIED";
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

// ── Interviewer workspace ────────────────────────────────────────────────────

const INTERVIEW_SELECT = Object.freeze({
    id: true,
    applicationId: true,
    interviewType: true,
    status: true,
    decision: true,
    scheduledAt: true,
    durationMinutes: true,
    location: true,
    remindersPausedAt: true,
    application: {
        select: {
            id: true,
            jobRequisitionId: true,
            candidate: { select: { id: true, firstName: true, lastName: true, anonymizedAt: true, resumeMediaId: true } },
            jobRequisition: { select: { id: true, title: true } },
        },
    },
    interviewers: { select: { employeeId: true, status: true } },
    scorecards: { select: { reviewerId: true, submittedAt: true } },
    packetItems: { select: { id: true, docClass: true } },
});

function myScorecardState(interview, me) {
    const card = (interview.scorecards || []).find((row) => Number(row.reviewerId) === me);
    if (!card) return { state: SCORECARD_STATE.NOT_STARTED, submittedAt: null };
    return card.submittedAt
        ? { state: SCORECARD_STATE.SUBMITTED, submittedAt: card.submittedAt }
        : { state: SCORECARD_STATE.DRAFT, submittedAt: null };
}

function packetSummary(interview) {
    // The interviewer view an assigned panelist gets: matrix-permitted packet
    // rows, plus the candidate's resume, which rides on the assignment.
    const { visible } = resolvePacketView(
        { audience: AUDIENCES.INTERVIEWER, isAssignedInterviewer: true },
        interview.packetItems || [],
    );
    const resumeAvailable = Boolean(interview.application?.candidate?.resumeMediaId);
    const itemIds = visible.map((item) => item.id);
    return { itemCount: itemIds.length + (resumeAvailable ? 1 : 0), itemIds, resumeAvailable };
}

function shapeMyInterview(interview, me, scope) {
    const mine = myScorecardState(interview, me);
    const othersVisible = mine.state === SCORECARD_STATE.SUBMITTED;
    const panel = activePanel(interview);
    const assignment = (interview.interviewers || []).find((link) => Number(link.employeeId) === me);
    return {
        interviewId: interview.id,
        applicationId: interview.applicationId,
        requisitionId: interview.application?.jobRequisition?.id ?? interview.application?.jobRequisitionId ?? null,
        requisitionTitle: interview.application?.jobRequisition?.title ?? null,
        ...candidateDisplay(interview.application?.candidate, scope),
        interviewType: interview.interviewType,
        status: interview.status,
        decision: interview.decision ?? null,
        scheduledAt: interview.scheduledAt,
        durationMinutes: interview.durationMinutes,
        endsAt: interviewEnd(interview),
        location: interview.location ?? null,
        myAssignmentStatus: assignment?.status ?? null,
        remindersPaused: Boolean(interview.remindersPausedAt),
        packet: packetSummary(interview),
        myScorecard: mine,
        panel: {
            size: panel.length,
            othersScorecardsVisible: othersVisible,
            // Hidden until mine is in: even a count says how far the panel got.
            submittedCount: othersVisible ? panel.length - missingScorecards(interview).length : null,
        },
    };
}

function shapeDecisionPrompt(interview, scope) {
    const panel = activePanel(interview);
    return {
        interviewId: interview.id,
        applicationId: interview.applicationId,
        requisitionId: interview.application?.jobRequisition?.id ?? interview.application?.jobRequisitionId ?? null,
        requisitionTitle: interview.application?.jobRequisition?.title ?? null,
        ...candidateDisplay(interview.application?.candidate, scope),
        interviewType: interview.interviewType,
        status: interview.status,
        scheduledAt: interview.scheduledAt,
        promptedAt: interview.decisionPromptedAt,
        panelSize: panel.length,
        submittedCount: panel.length - missingScorecards(interview).length,
        recommendationCounts: recommendationCounts(interview.scorecards),
    };
}

/**
 * The caller's interviewer workspace.
 *
 * @param {{ tenantId:string, scope:object, now?:Date, limit?:number }} args
 */
export async function getInterviewerWorkspace({ tenantId, scope, now = new Date(), limit } = {}) {
    requireTenant(tenantId);
    const me = positiveInt(scope?.employeeId);
    if (!me) {
        throw fail("The interviewer workspace needs the caller's employee id", 400, "HR-RECRUITMENT-WORKSPACE-EMPLOYEE-REQUIRED");
    }
    const at = new Date(now);
    const take = listLimit(limit, 50);
    const window = WORKSPACE_WINDOW_DAYS * DAY_MS;

    const mineWhere = (scheduledAt) =>
        withTenant(tenantId, {
            AND: [interviewScopeWhere(scope), { interviewers: { some: { employeeId: me } } }],
            status: { not: "CANCELLED" },
            scheduledAt,
        });
    const upcomingWhere = mineWhere({ gte: at, lte: new Date(at.getTime() + window) });
    const recentWhere = mineWhere({ gte: new Date(at.getTime() - window), lt: at });
    const promptsWhere = withTenant(tenantId, {
        AND: [interviewScopeWhere(scope), { application: { jobRequisition: { requestedById: me } } }],
        decisionPromptedAt: { not: null },
        decision: null,
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
    });
    const promptSelect = { ...INTERVIEW_SELECT, decisionPromptedAt: true, scorecards: { select: { reviewerId: true, submittedAt: true, recommendation: true } } };

    const [upcoming, upcomingTotal, recent, recentTotal, prompts, promptsTotal] = await Promise.all([
        prisma.interview.findMany({ where: upcomingWhere, select: INTERVIEW_SELECT, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], take }),
        prisma.interview.count({ where: upcomingWhere }),
        prisma.interview.findMany({ where: recentWhere, select: INTERVIEW_SELECT, orderBy: [{ scheduledAt: "desc" }, { id: "desc" }], take }),
        prisma.interview.count({ where: recentWhere }),
        prisma.interview.findMany({ where: promptsWhere, select: promptSelect, orderBy: [{ decisionPromptedAt: "asc" }, { id: "asc" }], take }),
        prisma.interview.count({ where: promptsWhere }),
    ]);

    return {
        employeeId: me,
        scope: scope?.level ?? null,
        windowDays: WORKSPACE_WINDOW_DAYS,
        upcoming: { items: upcoming.map((row) => shapeMyInterview(row, me, scope)), total: upcomingTotal },
        recent: { items: recent.map((row) => shapeMyInterview(row, me, scope)), total: recentTotal },
        decisionPrompts: { items: prompts.map((row) => shapeDecisionPrompt(row, scope)), total: promptsTotal },
    };
}

// ── Hiring manager workspace ─────────────────────────────────────────────────

/** The requisition predicate for the workspace, or null when the scope reaches none. */
function managerRequisitionScope(scope, managerEmployeeId) {
    if (scope?.level === RECRUITMENT_SCOPE.ORG || scope?.unrestricted) {
        const manager = positiveInt(managerEmployeeId);
        return manager
            ? requisitionScopeWhere({ level: RECRUITMENT_SCOPE.MANAGED, employeeId: manager, unrestricted: false })
            : {};
    }
    if (scope?.level === RECRUITMENT_SCOPE.MANAGED && positiveInt(scope.employeeId)) return requisitionScopeWhere(scope);
    return null;
}

function statusFilter(status) {
    if (status == null || String(status).trim() === "") return { status: { in: [...OPEN_REQUISITION_STATUSES] } };
    const value = String(status).trim().toUpperCase();
    if (value === "ALL") return {};
    if (!REQUISITION_STATUSES.includes(value)) {
        throw fail(`Unsupported requisition status: ${value}`, 400, "HR-RECRUITMENT-WORKSPACE-STATUS-INVALID");
    }
    return { status: value };
}

const emptyManagerWorkspace = (page, pageSize, scope) => ({
    managerEmployeeId: null,
    scope: scope?.level ?? null,
    requisitions: { items: [], total: 0, page, pageSize },
    shortlistProposals: { items: [], total: 0 },
    interviewsAwaitingDecision: { items: [], total: 0, scanCapped: false },
    offersAwaitingAction: { items: [], total: 0 },
});

async function stageCountsFor(tenantId, requisitionIds) {
    if (!requisitionIds.length) return new Map();
    const groups = await prisma.application.groupBy({
        by: ["jobRequisitionId", "stage"],
        where: withTenant(tenantId, { jobRequisitionId: { in: requisitionIds } }),
        _count: { _all: true },
    });
    return groups.reduce((map, row) => {
        const counts = map.get(row.jobRequisitionId) ?? {};
        counts[row.stage] = row._count?._all ?? 0;
        map.set(row.jobRequisitionId, counts);
        return map;
    }, new Map());
}

async function proposalCountsFor(tenantId, requisitionIds) {
    if (!requisitionIds.length) return new Map();
    const groups = await prisma.shortlistEntry.groupBy({
        by: ["requisitionId"],
        where: withTenant(tenantId, { requisitionId: { in: requisitionIds }, source: SCORING_PROPOSAL }),
        _count: { _all: true },
    });
    return new Map(groups.map((row) => [row.requisitionId, row._count?._all ?? 0]));
}

/** Interviews with no decision whose whole active panel has submitted. */
async function awaitingDecision(tenantId, scope, requisitionWhere, now, take) {
    const rows = await prisma.interview.findMany({
        where: withTenant(tenantId, {
            AND: [interviewScopeWhere(scope), { application: { jobRequisition: requisitionWhere } }],
            decision: null,
            status: { in: ["SCHEDULED", "COMPLETED"] },
            scheduledAt: { lte: now },
        }),
        select: {
            ...INTERVIEW_SELECT,
            decisionPromptedAt: true,
            scorecards: { select: { reviewerId: true, submittedAt: true, recommendation: true } },
        },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: AWAITING_SCAN_CAP,
    });
    const ready = rows.filter((row) => activePanel(row).length > 0 && missingScorecards(row).length === 0);
    return {
        ready,
        section: {
            items: ready.slice(0, take).map((row) => shapeDecisionPrompt(row, scope)),
            total: ready.length,
            scanCapped: rows.length === AWAITING_SCAN_CAP,
        },
    };
}

async function shortlistProposals(tenantId, scope, requisitionWhere, take) {
    const where = withTenant(tenantId, {
        source: SCORING_PROPOSAL,
        requisition: requisitionWhere,
        application: applicationScopeWhere(scope),
    });
    const [rows, total] = await Promise.all([
        prisma.shortlistEntry.findMany({
            where,
            select: {
                id: true,
                applicationId: true,
                requisitionId: true,
                note: true,
                addedAt: true,
                application: {
                    select: { stage: true, candidate: { select: { id: true, firstName: true, lastName: true, anonymizedAt: true } } },
                },
            },
            orderBy: [{ addedAt: "asc" }, { id: "asc" }],
            take,
        }),
        prisma.shortlistEntry.count({ where }),
    ]);
    const showNotes = scope?.canSeeInternalNotes === true;
    return {
        items: rows.map((row) => ({
            shortlistEntryId: row.id,
            applicationId: row.applicationId,
            requisitionId: row.requisitionId,
            stage: row.application?.stage ?? null,
            ...candidateDisplay(row.application?.candidate, scope),
            // The proposal note is the recruiter's working record.
            note: showNotes ? row.note ?? null : null,
            ...(showNotes ? {} : { noteRedacted: true }),
            addedAt: row.addedAt,
        })),
        total,
    };
}

async function offersAwaitingAction(tenantId, scope, requisitionWhere, take) {
    // The hiring manager's step of the approval chain is still undecided. No
    // compensation is selected, so nothing needs the offer mask.
    const where = withTenant(tenantId, {
        AND: [offerScopeWhere(scope)],
        jobRequisition: requisitionWhere,
        status: "DRAFT",
        approvalStatus: "PENDING",
        approvalRecords: { none: { stage: "hiringManager" } },
    });
    const [rows, total] = await Promise.all([
        prisma.offer.findMany({
            where,
            select: {
                id: true,
                applicationId: true,
                jobRequisitionId: true,
                status: true,
                approvalStatus: true,
                startDate: true,
                expiryDate: true,
                created_at: true,
            },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
            take,
        }),
        prisma.offer.count({ where }),
    ]);
    return {
        items: rows.map((row) => ({
            offerId: row.id,
            applicationId: row.applicationId,
            requisitionId: row.jobRequisitionId,
            status: row.status,
            approvalStatus: row.approvalStatus,
            pendingStage: "hiringManager",
            startDate: row.startDate ?? null,
            expiryDate: row.expiryDate ?? null,
            createdAt: row.created_at,
        })),
        total,
    };
}

/**
 * The hiring manager workspace.
 *
 * @param {{ tenantId:string, scope:object, managerEmployeeId?:number, status?:string, page?:number, pageSize?:number, listLimit?:number, now?:Date }} args
 */
export async function getManagerWorkspace({
    tenantId,
    scope,
    managerEmployeeId = null,
    status = null,
    page = 1,
    pageSize = 20,
    listLimit: sectionLimit,
    now = new Date(),
} = {}) {
    requireTenant(tenantId);
    const resolvedPage = Math.max(Number(page) || 1, 1);
    const resolvedPageSize = listLimit(pageSize, 20);
    const take = listLimit(sectionLimit);
    const reqScope = managerRequisitionScope(scope, managerEmployeeId);
    if (!reqScope) return emptyManagerWorkspace(resolvedPage, resolvedPageSize, scope);

    const requisitionWhere = { AND: [reqScope], ...statusFilter(status) };
    const where = withTenant(tenantId, requisitionWhere);
    const [rows, total] = await Promise.all([
        prisma.jobRequisition.findMany({
            where,
            select: { id: true, title: true, status: true, openings: true, priority: true, requestedById: true, createdAt: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (resolvedPage - 1) * resolvedPageSize,
            take: resolvedPageSize,
        }),
        prisma.jobRequisition.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);

    const [stageCounts, proposalCounts, awaiting, proposals, offers] = await Promise.all([
        stageCountsFor(tenantId, ids),
        proposalCountsFor(tenantId, ids),
        awaitingDecision(tenantId, scope, requisitionWhere, new Date(now), take),
        shortlistProposals(tenantId, scope, requisitionWhere, take),
        offersAwaitingAction(tenantId, scope, requisitionWhere, take),
    ]);
    const awaitingByRequisition = awaiting.ready.reduce((map, row) => {
        const key = row.application?.jobRequisitionId ?? row.application?.jobRequisition?.id;
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
    }, new Map());

    const scopedManager = scope?.level === RECRUITMENT_SCOPE.MANAGED ? positiveInt(scope.employeeId) : positiveInt(managerEmployeeId);
    return {
        managerEmployeeId: scopedManager ?? null,
        scope: scope?.level ?? null,
        requisitions: {
            items: rows.map((row) => {
                const counts = stageCounts.get(row.id) ?? {};
                return {
                    requisitionId: row.id,
                    title: row.title,
                    status: row.status,
                    openings: row.openings,
                    priority: row.priority ?? null,
                    createdAt: row.createdAt,
                    stageCounts: counts,
                    applicationCount: Object.values(counts).reduce((sum, n) => sum + n, 0),
                    pendingShortlistProposals: proposalCounts.get(row.id) ?? 0,
                    interviewsAwaitingDecision: awaitingByRequisition.get(row.id) ?? 0,
                };
            }),
            total,
            page: resolvedPage,
            pageSize: resolvedPageSize,
        },
        shortlistProposals: proposals,
        interviewsAwaitingDecision: awaiting.section,
        offersAwaitingAction: offers,
    };
}

export default { getInterviewerWorkspace, getManagerWorkspace };
