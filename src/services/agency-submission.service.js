// src/services/agency-submission.service.js
//
// Recruitment Phase 5 (plan 6.2, flag agencyPortal) — agency submissions.
//
// AGENCY side (the caller's scope carries agencyId and agencyRequisitionIds,
// resolved by src/lib/agency-access.util.js):
//   * the open requisitions assigned to the agency, as the agency projection
//     (title, description, location, employment type, closing date — never the
//     salary band, budget, approvals, internal notes, other agencies or other
//     candidates);
//   * submit a candidate: an AgencySubmission PENDING_REVIEW holding the
//     snapshot the agency typed. Nothing is created in the pipeline yet and
//     nothing tells the agency whether the person is already known (no oracle).
//     maxSubmissions on the assignment caps it; the requisition's recruiter is
//     told through hr.recruitment.agency_submission_received.v1;
//   * its own submissions, with the status it may know: REJECTED and DUPLICATE
//     both read as REJECTED with one neutral reason, because the real reason can
//     name another agency or an application in process.
//
// HR side (ORG): list submissions and review one. ACCEPT matches the candidate
// by email or creates it (createCandidate: DNC checked), creates the
// application through the gated createApplication path (eligibility, DNC,
// application_created event) with sourceChannel AGENCY, and records the owning
// agency and ownershipExpiresAt = now + agency.ownershipDays on the candidate,
// the application and the submission. A candidate owned by another agency
// inside its window, or already in process for the requisition, is a DUPLICATE
// with the reason recorded. REJECT needs a reason.
//
// ACCEPT spans two transactions (createApplication owns its own). The
// application is tagged with sourceDetail "agency-submission:<id>", so a review
// retried after a failure between the two resumes onto that application instead
// of reading it as a duplicate.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { APPLICATION_ACCEPTING_STATUSES } from "../lib/requisitionEligibility.js";
import {
    RECRUITMENT_SCOPE,
    agencyRequisitionScopeWhere,
    agencyRequisitionView,
} from "../lib/recruitmentAccess.js";
import { AGENCY_STATUS, ASSIGNMENT_STATUS } from "../lib/agency-access.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { createCandidate } from "./candidateService.js";
import { createApplication } from "./applicationService.js";
import { assertAgencyPortalEnabled, isRequisitionOpenForAgencies } from "./recruitment-agency.service.js";

const fail = (message, code, status = 400, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

export const SUBMISSION_STATUS = Object.freeze({
    PENDING_REVIEW: "PENDING_REVIEW",
    ACCEPTED: "ACCEPTED",
    REJECTED: "REJECTED",
    DUPLICATE: "DUPLICATE",
    WITHDRAWN: "WITHDRAWN",
});
export const REVIEW_DECISIONS = Object.freeze(["ACCEPT", "REJECT"]);
export const SUBMISSION_NOTE_MAX = 2000;
export const REJECTION_REASON_MAX = 1000;
export const AGENCY_NEUTRAL_REJECTION = "Not taken forward for this requisition.";

const DAY_MS = 24 * 60 * 60 * 1000;
// Submissions that count against maxSubmissions: everything but a withdrawal.
const COUNTED_STATUSES = Object.freeze(["PENDING_REVIEW", "ACCEPTED", "REJECTED", "DUPLICATE"]);
const LIVE_STATUSES = Object.freeze(["PENDING_REVIEW", "ACCEPTED"]);

const submissionMarker = (id) => `agency-submission:${id}`;

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

// ── Events ─────────────────────────────────────────────────────────────────

/**
 * hr.recruitment.agency_submission_received.v1 — ids only. recruiterId and
 * requestedById route it to the requisition's recruiter (and, when there is no
 * recruiter, the hiring manager); the candidate's name never rides on it.
 */
export function agencySubmissionReceivedEvent(submission, ctx = {}, extra = {}) {
    if (!submission?.tenantId) return null;
    const idStr = (v) => (v == null ? null : String(v));
    return {
        eventName: "hr.recruitment.agency_submission_received.v1",
        tenantId: submission.tenantId,
        aggregateType: "AgencySubmission",
        aggregateId: submission.id,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
        payload: {
            submissionId: String(submission.id),
            agencyId: idStr(submission.agencyId),
            requisitionId: idStr(submission.requisitionId),
            recruiterId: idStr(extra.recruiterId),
            requestedById: idStr(extra.requestedById),
        },
    };
}

// ── Agency side ────────────────────────────────────────────────────────────

/** The scope may act as an agency: AGENCY level (any other scope is refused). */
export function assertAgencyScope(scope) {
    if (scope?.level !== RECRUITMENT_SCOPE.AGENCY) {
        throw fail("This tool is for recruitment agency users", "HR-RECRUITMENT-AGENCY-SCOPE-REQUIRED", 403);
    }
}

const agencyIdOf = (scope) => (Number.isInteger(scope?.agencyId) && scope.agencyId > 0 ? scope.agencyId : null);

// Open requisitions within the agency's assignments: the scope's ids, an
// accepting status and a closing date not yet passed.
const openAssignedWhere = (tenantId, scope, now, extra = {}) => withTenant(tenantId, {
    AND: [
        agencyRequisitionScopeWhere(scope),
        { status: { in: [...APPLICATION_ACCEPTING_STATUSES] } },
        { OR: [{ closesAt: null }, { closesAt: { gte: now } }] },
        extra,
    ],
});

const REQUISITION_VIEW_SELECT = Object.freeze({
    id: true, title: true, description: true, location: true, employmentType: true, closesAt: true,
});

async function assignmentFacts(tenantId, agencyId, requisitionIds) {
    if (!requisitionIds.length) return new Map();
    const [assignments, counts] = await Promise.all([
        prisma.requisitionAgencyAssignment.findMany({
            where: withTenant(tenantId, { agencyId, status: ASSIGNMENT_STATUS.ACTIVE, requisitionId: { in: requisitionIds } }),
            select: { requisitionId: true, maxSubmissions: true },
        }),
        prisma.agencySubmission.findMany({
            where: withTenant(tenantId, { agencyId, requisitionId: { in: requisitionIds }, status: { in: [...COUNTED_STATUSES] } }),
            select: { requisitionId: true },
        }),
    ]);
    const used = new Map();
    for (const row of counts) used.set(row.requisitionId, (used.get(row.requisitionId) ?? 0) + 1);
    return new Map(assignments.map((a) => [a.requisitionId, { maxSubmissions: a.maxSubmissions ?? null, submittedCount: used.get(a.requisitionId) ?? 0 }]));
}

const portalRequisition = (row, facts) => ({
    ...agencyRequisitionView(row),
    maxSubmissions: facts?.maxSubmissions ?? null,
    submittedCount: facts?.submittedCount ?? 0,
});

/** The open requisitions assigned to the caller's agency. */
export async function listAgencyRequisitions({ tenantId, scope, q, page, pageSize, now = new Date() } = {}) {
    assertAgencyScope(scope);
    const paging = pageArgs({ page, pageSize });
    const agencyId = agencyIdOf(scope);
    if (!agencyId) return { items: [], total: 0, page: paging.page, pageSize: paging.pageSize };
    const where = openAssignedWhere(tenantId, scope, now, q ? { title: { contains: String(q).trim(), mode: "insensitive" } } : {});
    const [rows, total] = await Promise.all([
        prisma.jobRequisition.findMany({ where, select: REQUISITION_VIEW_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.pageSize }),
        prisma.jobRequisition.count({ where }),
    ]);
    const facts = await assignmentFacts(tenantId, agencyId, rows.map((r) => r.id));
    return { items: rows.map((r) => portalRequisition(r, facts.get(r.id))), total, page: paging.page, pageSize: paging.pageSize };
}

/** One open requisition assigned to the caller's agency, else not found. */
export async function getAgencyRequisition({ tenantId, scope, requisitionId, now = new Date() } = {}) {
    assertAgencyScope(scope);
    const id = positiveId(requisitionId, "requisition");
    const agencyId = agencyIdOf(scope);
    const row = agencyId
        ? await prisma.jobRequisition.findFirst({ where: openAssignedWhere(tenantId, scope, now, { id }), select: REQUISITION_VIEW_SELECT })
        : null;
    if (!row) throw fail("Requisition not found", "HR-RECRUITMENT-REQUISITION-NOT-FOUND", 404);
    const facts = await assignmentFacts(tenantId, agencyId, [row.id]);
    return portalRequisition(row, facts.get(row.id));
}

function text(value, key, max, { required = false } = {}) {
    const out = value == null ? "" : String(value).trim();
    if (!out) {
        if (required) throw fail(`${key} is required`, "HR-RECRUITMENT-AGENCY-SUBMISSION-INVALID");
        return null;
    }
    if (out.length > max) throw fail(`${key} must be at most ${max} characters`, "HR-RECRUITMENT-AGENCY-SUBMISSION-INVALID");
    return out;
}

/** Validate the agency's submission into the stored snapshot. Pure. */
export function normalizeSubmissionInput(input = {}) {
    const email = text(input.email, "email", 254, { required: true }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail("email must be an email address", "HR-RECRUITMENT-AGENCY-SUBMISSION-INVALID");
    let resumeMediaId = null;
    if (input.resumeMediaId != null) resumeMediaId = positiveId(input.resumeMediaId, "resume media");
    return {
        snapshot: {
            firstName: text(input.firstName, "firstName", 100, { required: true }),
            lastName: text(input.lastName, "lastName", 100, { required: true }),
            email,
            phone: text(input.phone, "phone", 40),
            resumeMediaId,
        },
        note: text(input.note, "note", SUBMISSION_NOTE_MAX, { required: true }),
    };
}

/** What an agency may see of its own submission. */
export function agencySubmissionView(row) {
    const hidden = row.status === SUBMISSION_STATUS.REJECTED || row.status === SUBMISSION_STATUS.DUPLICATE;
    const snap = row.candidateSnapshot ?? {};
    return {
        id: row.id,
        requisitionId: row.requisitionId,
        status: hidden ? SUBMISSION_STATUS.REJECTED : row.status,
        candidate: { firstName: snap.firstName ?? null, lastName: snap.lastName ?? null, email: snap.email ?? null },
        note: row.note ?? null,
        submittedAt: row.createdAt ?? null,
        reviewedAt: row.reviewedAt ?? null,
        rejectionReason: hidden ? AGENCY_NEUTRAL_REJECTION : null,
        ownershipExpiresAt: row.status === SUBMISSION_STATUS.ACCEPTED ? row.ownershipExpiresAt ?? null : null,
    };
}

/**
 * Submit a candidate for one of the agency's open requisitions. An unassigned,
 * ended, closed or foreign requisition reads as not found or not open; the
 * agency never learns whether the person is already known.
 */
export async function submitAgencyCandidate({ tenantId, scope, userId, input = {}, now = new Date() } = {}) {
    assertAgencyPortalEnabled();
    assertAgencyScope(scope);
    const requisitionId = positiveId(input.requisitionId, "requisition");
    const { snapshot, note } = normalizeSubmissionInput(input);
    const agencyId = agencyIdOf(scope);
    const notFound = () => fail("Requisition not found", "HR-RECRUITMENT-REQUISITION-NOT-FOUND", 404);
    if (!agencyId || !scope.agencyRequisitionIds?.includes(requisitionId)) throw notFound();

    const row = await tenantTransaction(prisma, async (tx) => {
        // One submitter at a time per agency and requisition, so two concurrent
        // submissions cannot both squeeze under maxSubmissions.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:agency-submit:${agencyId}:${requisitionId}`}))`;
        const assignment = await tx.requisitionAgencyAssignment.findFirst({
            where: withTenant(tenantId, { agencyId, requisitionId, status: ASSIGNMENT_STATUS.ACTIVE }),
            select: { id: true, maxSubmissions: true },
        });
        const agency = await tx.recruitmentAgency.findFirst({
            where: withTenant(tenantId, { id: agencyId, status: AGENCY_STATUS.ACTIVE }),
            select: { id: true },
        });
        if (!assignment || !agency) throw notFound();
        const requisition = await tx.jobRequisition.findFirst({
            where: withTenant(tenantId, { id: requisitionId }),
            select: { id: true, status: true, closesAt: true, recruiterId: true, requestedById: true },
        });
        if (!requisition) throw notFound();
        if (!isRequisitionOpenForAgencies(requisition, now)) {
            throw fail("This requisition is not accepting submissions", "HR-RECRUITMENT-AGENCY-REQUISITION-NOT-OPEN", 409);
        }
        const mine = await tx.agencySubmission.findMany({
            where: withTenant(tenantId, { agencyId, requisitionId, status: { in: [...COUNTED_STATUSES] } }),
            select: { status: true, candidateSnapshot: true },
        });
        if (assignment.maxSubmissions != null && mine.length >= assignment.maxSubmissions) {
            throw fail(`This requisition takes at most ${assignment.maxSubmissions} submissions from your agency`, "HR-RECRUITMENT-AGENCY-SUBMISSION-LIMIT", 409);
        }
        // The agency's OWN earlier submission of the same person is its data,
        // so saying so is no oracle.
        if (mine.some((s) => LIVE_STATUSES.includes(s.status) && String(s.candidateSnapshot?.email ?? "").toLowerCase() === snapshot.email)) {
            throw fail("You have already submitted this candidate for this requisition", "HR-RECRUITMENT-AGENCY-SUBMISSION-EXISTS", 409);
        }
        const created = await tx.agencySubmission.create({
            data: {
                tenantId,
                agencyId,
                requisitionId,
                submittedByUserId: String(userId),
                status: SUBMISSION_STATUS.PENDING_REVIEW,
                candidateSnapshot: snapshot,
                note,
            },
        });
        await enqueueHrDomainEvent(tx, agencySubmissionReceivedEvent(created, { actorId: userId }, {
            recruiterId: requisition.recruiterId,
            requestedById: requisition.requestedById,
        }));
        return created;
    });
    logger.info({ tenantId, agencyId, requisitionId, submissionId: row.id }, "agency submission received");
    return agencySubmissionView(row);
}

/** The caller's agency's own submissions. */
export async function listOwnAgencySubmissions({ tenantId, scope, status, requisitionId, page, pageSize } = {}) {
    assertAgencyScope(scope);
    const paging = pageArgs({ page, pageSize });
    const agencyId = agencyIdOf(scope);
    if (!agencyId) return { items: [], total: 0, page: paging.page, pageSize: paging.pageSize };
    // The agency filters on the statuses it is shown: REJECTED covers DUPLICATE.
    const wanted = status ? String(status).toUpperCase() : null;
    const statusWhere = !wanted ? {}
        : wanted === SUBMISSION_STATUS.REJECTED ? { status: { in: [SUBMISSION_STATUS.REJECTED, SUBMISSION_STATUS.DUPLICATE] } }
            : { status: wanted };
    const where = withTenant(tenantId, {
        agencyId,
        ...statusWhere,
        ...(requisitionId != null ? { requisitionId: positiveId(requisitionId, "requisition") } : {}),
    });
    const [rows, total] = await Promise.all([
        prisma.agencySubmission.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.pageSize }),
        prisma.agencySubmission.count({ where }),
    ]);
    return { items: rows.map(agencySubmissionView), total, page: paging.page, pageSize: paging.pageSize };
}

// ── HR side ────────────────────────────────────────────────────────────────

export async function listAgencySubmissions({ tenantId, status, agencyId, requisitionId, page, pageSize } = {}) {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    const paging = pageArgs({ page, pageSize });
    const where = withTenant(tenantId, {
        ...(status ? { status: String(status).toUpperCase() } : {}),
        ...(agencyId != null ? { agencyId: positiveId(agencyId, "agency") } : {}),
        ...(requisitionId != null ? { requisitionId: positiveId(requisitionId, "requisition") } : {}),
    });
    const [items, total] = await Promise.all([
        prisma.agencySubmission.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: paging.skip,
            take: paging.pageSize,
            include: { agency: { select: { id: true, name: true } } },
        }),
        prisma.agencySubmission.count({ where }),
    ]);
    return { items, total, page: paging.page, pageSize: paging.pageSize };
}

// Settle a PENDING_REVIEW submission; a concurrent reviewer who got there
// first makes this a 409 rather than a second decision.
async function settle(tx, tenantId, id, data) {
    const claimed = await tx.agencySubmission.updateMany({
        where: withTenant(tenantId, { id, status: SUBMISSION_STATUS.PENDING_REVIEW }),
        data,
    });
    if (claimed.count === 0) {
        throw fail("This submission has already been reviewed", "HR-RECRUITMENT-AGENCY-SUBMISSION-DECIDED", 409);
    }
    return tx.agencySubmission.findFirst({ where: withTenant(tenantId, { id }) });
}

/**
 * The duplicate rule, pure: why an ACCEPT must become DUPLICATE, or null.
 * `application` is the candidate's existing application to the requisition.
 */
export function duplicateReasonFor({ candidate, application, agencyId, submissionId, now = new Date() }) {
    if (application && application.sourceDetail !== submissionMarker(submissionId)) {
        return `Candidate already in process for this requisition (application ${application.id})`;
    }
    const expires = candidate?.ownershipExpiresAt ? new Date(candidate.ownershipExpiresAt) : null;
    if (candidate?.ownerAgencyId && candidate.ownerAgencyId !== agencyId && expires && expires.getTime() > now.getTime()) {
        return `Candidate owned by agency ${candidate.ownerAgencyId} until ${expires.toISOString()}`;
    }
    return null;
}

/**
 * Review one submission. ACCEPT puts the person into the pipeline with the
 * agency's ownership; REJECT records the reason; either way the decision is
 * final (409 when it was already made).
 */
export async function reviewAgencySubmission({ tenantId, actorId = null, id, decision, reason, now = new Date() } = {}) {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    assertAgencyPortalEnabled();
    const submissionId = positiveId(id, "submission");
    const verdict = String(decision ?? "").toUpperCase();
    if (!REVIEW_DECISIONS.includes(verdict)) throw fail("decision must be ACCEPT or REJECT", "HR-RECRUITMENT-AGENCY-SUBMISSION-INVALID");
    const reviewed = { reviewedById: actorId ?? null, reviewedAt: now };

    const submission = await prisma.agencySubmission.findFirst({ where: withTenant(tenantId, { id: submissionId }) });
    if (!submission) throw fail("Submission not found", "HR-RECRUITMENT-AGENCY-SUBMISSION-NOT-FOUND", 404);
    if (submission.status !== SUBMISSION_STATUS.PENDING_REVIEW) {
        throw fail("This submission has already been reviewed", "HR-RECRUITMENT-AGENCY-SUBMISSION-DECIDED", 409);
    }

    if (verdict === "REJECT") {
        const why = text(reason, "reason", REJECTION_REASON_MAX, { required: true });
        const row = await tenantTransaction(prisma, async (tx) =>
            await settle(tx, tenantId, submissionId, { status: SUBMISSION_STATUS.REJECTED, rejectionReason: why, ...reviewed }));
        logger.info({ tenantId, submissionId, decision: "REJECT" }, "agency submission reviewed");
        return { submission: row, outcome: SUBMISSION_STATUS.REJECTED };
    }

    const agency = await prisma.recruitmentAgency.findFirst({
        where: withTenant(tenantId, { id: submission.agencyId }),
        select: { id: true, ownershipDays: true },
    });
    if (!agency) throw fail("Agency not found", "HR-RECRUITMENT-AGENCY-NOT-FOUND", 404);
    const snap = submission.candidateSnapshot ?? {};
    const email = String(snap.email ?? "").trim();
    if (!email) throw fail("The submission has no candidate email", "HR-RECRUITMENT-AGENCY-SUBMISSION-INVALID", 409);

    let candidate = await prisma.candidate.findFirst({
        where: withTenant(tenantId, { email: { equals: email, mode: "insensitive" } }),
        select: { id: true, ownerAgencyId: true, ownershipExpiresAt: true },
    });
    let application = null;
    if (candidate) {
        application = await prisma.application.findFirst({
            where: withTenant(tenantId, { candidateId: candidate.id, jobRequisitionId: submission.requisitionId }),
            select: { id: true, sourceDetail: true },
        });
        const duplicate = duplicateReasonFor({ candidate, application, agencyId: agency.id, submissionId, now });
        if (duplicate) {
            const row = await tenantTransaction(prisma, async (tx) =>
                await settle(tx, tenantId, submissionId, {
                    status: SUBMISSION_STATUS.DUPLICATE,
                    rejectionReason: duplicate.slice(0, REJECTION_REASON_MAX),
                    candidateId: candidate.id,
                    ...reviewed,
                }));
            logger.info({ tenantId, submissionId, decision: "ACCEPT", outcome: "DUPLICATE" }, "agency submission reviewed");
            return { submission: row, outcome: SUBMISSION_STATUS.DUPLICATE, reason: duplicate };
        }
    } else {
        candidate = await createCandidate({
            firstName: snap.firstName,
            lastName: snap.lastName ?? null,
            email,
            phone: snap.phone ?? null,
            source: "AGENCY",
            resumeMediaId: snap.resumeMediaId ?? null,
            tenantId,
            createdById: actorId,
        });
    }

    if (!application) {
        application = await createApplication({
            candidateId: candidate.id,
            jobRequisitionId: submission.requisitionId,
            tenantId,
            createdById: actorId,
            source: "agency",
            sourceChannel: "AGENCY",
            sourceDetail: submissionMarker(submissionId),
        });
    }

    const ownershipExpiresAt = new Date(now.getTime() + Number(agency.ownershipDays ?? 0) * DAY_MS);
    const ownership = { ownerAgencyId: agency.id, ownershipExpiresAt };
    const row = await tenantTransaction(prisma, async (tx) => {
        const settled = await settle(tx, tenantId, submissionId, {
            status: SUBMISSION_STATUS.ACCEPTED,
            candidateId: candidate.id,
            applicationId: application.id,
            ownershipExpiresAt,
            ...reviewed,
        });
        await tx.application.updateMany({ where: withTenant(tenantId, { id: application.id }), data: ownership });
        await tx.candidate.updateMany({ where: withTenant(tenantId, { id: candidate.id }), data: ownership });
        return settled;
    });
    logger.info({ tenantId, submissionId, decision: "ACCEPT", applicationId: application.id }, "agency submission reviewed");
    return { submission: row, outcome: SUBMISSION_STATUS.ACCEPTED, candidateId: candidate.id, applicationId: application.id };
}
