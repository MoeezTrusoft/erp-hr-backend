// src/services/internal-board.service.js
//
// Recruitment Phase 5 (plan 6.2) — the internal job board and employee
// referrals, the employee side. Every function is pinned to the caller's own
// employee id (the tools take it from the verified claim, never from input).
//
//   * The board: open requisitions with a live CAREER_SITE or INTERNAL posting
//     (boardRequisitionWhere). Title, department id, location, employment
//     type, posted and closing dates and a plain description, nothing else:
//     no salary band, no budget, no approval state, no notes. A requisition
//     the caller owns (hiring manager, recruiter) or is being replaced on is
//     not on the caller's board at all (see the util for why).
//   * Applying: the caller's Candidate is reused (matched by work email, else
//     personal email) or created, and the application goes through the SAME
//     gated creation path every recruiter-side intake uses
//     (applicationService.createApplicationInTx: eligibility, DNC, the
//     application_created event) with sourceChannel INTERNAL and
//     applicantEmployeeId, in ONE transaction. One application per requisition.
//   * Referring: the contact is matched or created, an InternalReferral is
//     recorded and the contact's application created (sourceChannel REFERRAL,
//     sourceDetail referral:<id>). A contact already in process for the
//     requisition gives a DUPLICATE referral and no second application. The
//     recruiter hears about it through hr.recruitment.referral_submitted.v1.
//
// Privacy of the referred contact: the referrer must not learn what HR holds
// about them. A contact on the do-not-contact register, or whose candidate
// record is archived or has withdrawn consent, is not processed: the referral
// is recorded as REJECTED with no candidate link and no application, nothing
// is sent, and the response has the same shape as any other referral; one
// pino line records the tenant and a hash of the address.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    REFERRAL_NAME_MAX_LENGTH,
    REFERRAL_NOTE_MAX_LENGTH,
    REFERRAL_RELATIONSHIP_MAX_LENGTH,
    REFERRAL_STATUS,
    boardRequisitionSelect,
    boardRequisitionWhere,
    employeeEmails,
    employeeName,
    isStillEmployed,
    normalizeEmail,
    referralSourceDetail,
    toBoardJob,
    toSelfReferral,
} from "../lib/internal-mobility.util.js";
import { checkIntakeDnc, logIntakeSuppressed } from "./intake-dnc.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { referralSubmittedEvent, requisitionTitles } from "./internal-referral.service.js";
// Namespace import: createApplicationInTx is the transaction-composable half
// of createApplication (see the Phase 5 note). A named import of a missing
// export would fail at link time for every importer; a property read fails
// only on the call, with a clear code.
import * as applicationService from "./applicationService.js";

const log = logger.child({ component: "internal-board" });

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const requireTenantId = (tenantId) => {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    return tenantId;
};

const jobNotFound = () => fail("Job not found", 404, "HR-RECRUITMENT-INTERNAL-JOB-NOT-FOUND");

const MAX_PAGE_SIZE = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d][\d\s()-]{5,19}$/;

const EMPLOYEE_SELECT = Object.freeze({
    id: true,
    first_name: true,
    last_name: true,
    employee_name: true,
    work_email: true,
    email: true,
    work_phone: true,
    personal_contact: true,
    separatedAt: true,
    status: true,
    employement_status: true,
});

const CANDIDATE_SELECT = Object.freeze({
    id: true,
    email: true,
    status: true,
    archivedAt: true,
    consentStatus: true,
});

async function loadActiveEmployee(tx, tenantId, employeeId, now) {
    const employee = await tx.employee.findFirst({
        where: { id: employeeId, tenant_id: tenantId },
        select: EMPLOYEE_SELECT,
    });
    if (!isStillEmployed(employee, now)) {
        throw fail("Only current employees can use the internal job board", 403, "HR-RECRUITMENT-INTERNAL-NOT-EMPLOYED");
    }
    return employee;
}

async function findBoardRequisition(db, { tenantId, employeeId, requisitionId, now, extraSelect = {} }) {
    const id = positiveInt(requisitionId);
    if (!id) return null;
    return db.jobRequisition.findFirst({
        where: { ...boardRequisitionWhere({ tenantId, employeeId, now }), id },
        select: { ...boardRequisitionSelect(tenantId), ...extraSelect },
    });
}

// The live board posting the application answered (INTERNAL first).
const boardPostingId = (requisition) => {
    const postings = requisition?.postings ?? [];
    return (postings.find((p) => p.channel === "INTERNAL") ?? postings[0])?.id ?? null;
};

function gatedCreateApplication() {
    const create = applicationService.createApplicationInTx;
    if (typeof create !== "function") {
        throw fail(
            "Internal applications are not available yet",
            500,
            "HR-RECRUITMENT-INTERNAL-BOARD-NOT-WIRED",
        );
    }
    return create;
}

// ── The board ──────────────────────────────────────────────────────────────

/**
 * The caller's internal board, newest postings first.
 * @returns {Promise<{ items: object[], total: number, page: number, pageSize: number }>}
 */
export async function listInternalJobs({ tenantId, employeeId, q = null, page = 1, pageSize = 50, now = new Date() } = {}) {
    requireTenantId(tenantId);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), MAX_PAGE_SIZE);
    const pageNo = Math.max(Number(page) || 1, 1);
    const search = String(q ?? "").trim();
    const where = {
        ...boardRequisitionWhere({ tenantId, employeeId, now }),
        ...(search ? { title: { contains: search.slice(0, 100), mode: "insensitive" } } : {}),
    };
    const [total, rows] = await Promise.all([
        prisma.jobRequisition.count({ where }),
        prisma.jobRequisition.findMany({
            where,
            select: boardRequisitionSelect(tenantId),
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            skip: (pageNo - 1) * size,
            take: size,
        }),
    ]);
    const applied = await appliedRequisitionIds(prisma, tenantId, employeeId, rows.map((r) => r.id));
    return {
        items: rows.map((row) => toBoardJob(row, { applied: applied.has(row.id) })),
        total,
        page: pageNo,
        pageSize: size,
    };
}

async function appliedRequisitionIds(db, tenantId, employeeId, ids) {
    if (!ids.length) return new Set();
    const rows = await db.application.findMany({
        where: withTenant(tenantId, { applicantEmployeeId: employeeId, jobRequisitionId: { in: ids } }),
        select: { jobRequisitionId: true },
    });
    return new Set(rows.map((r) => r.jobRequisitionId));
}

/** One job on the caller's board; anything not on it is the same 404. */
export async function getInternalJob({ tenantId, employeeId, requisitionId, now = new Date() } = {}) {
    requireTenantId(tenantId);
    const requisition = await findBoardRequisition(prisma, { tenantId, employeeId, requisitionId, now });
    if (!requisition) throw jobNotFound();
    const applied = await appliedRequisitionIds(prisma, tenantId, employeeId, [requisition.id]);
    return toBoardJob(requisition, { applied: applied.has(requisition.id) });
}

// ── Applying ────────────────────────────────────────────────────────────────

const alreadyApplied = (applicationId) =>
    fail("You have already applied for this job", 409, "HR-RECRUITMENT-INTERNAL-ALREADY-APPLIED", { applicationId });

/** The caller's candidate row: work email first, then personal email. */
async function findOwnCandidate(tx, tenantId, emails) {
    for (const email of emails) {
        const candidate = await tx.candidate.findFirst({
            where: withTenant(tenantId, { email: { equals: email, mode: "insensitive" }, anonymizedAt: null }),
            select: CANDIDATE_SELECT,
        });
        if (candidate) return candidate;
    }
    return null;
}

/**
 * Apply for a job on the caller's board.
 *
 * `consent` is the employee confirming the candidate privacy notice (the
 * version they saw in `policyVersion` when the client knows it): it is
 * recorded as PROCESSING consent. An employee who once withdrew consent as a
 * candidate gives it again by applying; the do-not-contact register still
 * refuses (409 HR-RECRUITMENT-CANDIDATE-DNC, from the gated path) until HR
 * lifts the entry.
 */
export async function applyToInternalJob({
    tenantId,
    employeeId,
    requisitionId,
    consent,
    policyVersion = null,
    now = new Date(),
} = {}) {
    requireTenantId(tenantId);
    if (consent !== true) {
        throw fail("Confirm the candidate privacy notice to apply", 400, "HR-RECRUITMENT-INTERNAL-CONSENT-REQUIRED");
    }
    const createApplicationInTx = gatedCreateApplication();
    const at = new Date(now);
    const version = String(policyVersion ?? "").trim().slice(0, 50) || null;

    const result = await tenantTransaction(
        prisma,
        async (tx) => {
            const employee = await loadActiveEmployee(tx, tenantId, employeeId, at);
            const requisition = await findBoardRequisition(tx, { tenantId, employeeId, requisitionId, now: at });
            if (!requisition) throw jobNotFound();

            const own = await tx.application.findFirst({
                where: withTenant(tenantId, { jobRequisitionId: requisition.id, applicantEmployeeId: employeeId }),
                select: { id: true },
            });
            if (own) throw alreadyApplied(own.id);

            const emails = employeeEmails(employee);
            if (!emails.length) {
                throw fail(
                    "Your employee record has no email address; ask HR to add one before applying",
                    422,
                    "HR-RECRUITMENT-INTERNAL-NO-EMAIL",
                );
            }

            let candidate = await findOwnCandidate(tx, tenantId, emails);
            if (candidate) {
                if (candidate.status !== "active" || candidate.archivedAt) {
                    throw fail(
                        "Your earlier candidate record is archived; ask HR to restore it before applying",
                        409,
                        "HR-RECRUITMENT-INTERNAL-CANDIDATE-ARCHIVED",
                    );
                }
                const earlier = await tx.application.findFirst({
                    where: withTenant(tenantId, { candidateId: candidate.id, jobRequisitionId: requisition.id }),
                    select: { id: true },
                });
                if (earlier) throw alreadyApplied(earlier.id);
                if (candidate.consentStatus !== "GRANTED") {
                    await tx.candidate.updateMany({
                        where: withTenant(tenantId, { id: candidate.id }),
                        data: { consentStatus: "GRANTED", consentUpdatedAt: at, version: { increment: 1 } },
                    });
                }
            } else {
                const { firstName, lastName } = employeeName(employee);
                candidate = await tx.candidate.create({
                    data: {
                        tenantId,
                        firstName,
                        lastName,
                        email: emails[0],
                        phone: employee.work_phone ?? employee.personal_contact ?? null,
                        source: "Internal",
                        status: "active",
                        createdById: employeeId,
                        consentStatus: "GRANTED",
                        consentUpdatedAt: at,
                    },
                    select: CANDIDATE_SELECT,
                });
            }

            await tx.candidateConsent.create({
                data: {
                    candidateId: candidate.id,
                    tenantId,
                    purpose: "PROCESSING",
                    status: "GRANTED",
                    policyVersion: version,
                    source: "internal-board",
                    evidence: "The employee applied on the internal job board and confirmed the privacy notice",
                    occurredAt: at,
                    recordedById: employeeId,
                },
            });

            const application = await createApplicationInTx(tx, {
                candidateId: candidate.id,
                jobRequisitionId: requisition.id,
                tenantId,
                createdById: employeeId,
                source: "internal-board",
                sourceChannel: "INTERNAL",
                sourcePostingId: boardPostingId(requisition),
                applicantEmployeeId: employeeId,
            });
            return { applicationId: application.id, requisitionId: requisition.id };
        },
        { tenantId },
    );

    log.info({ tenantId, employeeId, requisitionId: result.requisitionId, applicationId: result.applicationId }, "internal application created");
    return { applied: true, requisitionId: result.requisitionId, applicationId: result.applicationId };
}

// ── Referring ───────────────────────────────────────────────────────────────

const trimmed = (value, max) => {
    const text = String(value ?? "").trim();
    return text ? text.slice(0, max) : null;
};

/** Validate the referral form. Throws 400 with one code for every problem. */
export function normalizeReferralInput(input = {}) {
    const invalid = (message) => fail(message, 400, "HR-RECRUITMENT-REFERRAL-INPUT-INVALID");
    const firstName = trimmed(input.firstName, REFERRAL_NAME_MAX_LENGTH);
    if (!firstName) throw invalid("firstName is required");
    const email = normalizeEmail(input.email);
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw invalid("A valid email is required");
    const phone = trimmed(input.phone, 30);
    if (phone && !PHONE_RE.test(phone)) throw invalid("phone is not a valid phone number");
    const note = input.note == null ? null : String(input.note).trim() || null;
    if (note && note.length > REFERRAL_NOTE_MAX_LENGTH) throw invalid(`note is longer than ${REFERRAL_NOTE_MAX_LENGTH} characters`);
    if (input.consent !== true) {
        throw fail(
            "Confirm that the person agreed to be referred",
            400,
            "HR-RECRUITMENT-REFERRAL-CONSENT-REQUIRED",
        );
    }
    return {
        firstName,
        lastName: trimmed(input.lastName, REFERRAL_NAME_MAX_LENGTH),
        email,
        phone,
        relationship: trimmed(input.relationship, REFERRAL_RELATIONSHIP_MAX_LENGTH),
        note,
    };
}

/**
 * Refer a contact for a job on the caller's board.
 * @returns {Promise<object>} the referral as the referrer sees it (toSelfReferral)
 */
export async function createReferral({ tenantId, employeeId, requisitionId, now = new Date(), ...form } = {}) {
    requireTenantId(tenantId);
    const input = normalizeReferralInput(form);
    const createApplicationInTx = gatedCreateApplication();
    const at = new Date(now);
    const ctx = eventContext({ actorId: employeeId });

    const outcome = await tenantTransaction(
        prisma,
        async (tx) => {
            await loadActiveEmployee(tx, tenantId, employeeId, at);
            const requisition = await findBoardRequisition(tx, {
                tenantId,
                employeeId,
                requisitionId,
                now: at,
                extraSelect: { recruiterId: true, requestedById: true },
            });
            if (!requisition) throw jobNotFound();
            const routing = { recruiterId: requisition.recruiterId, requestedById: requisition.requestedById };

            // Employees (the referrer included) apply on the board themselves.
            const colleague = await tx.employee.findFirst({
                where: {
                    tenant_id: tenantId,
                    OR: [
                        { work_email: { equals: input.email, mode: "insensitive" } },
                        { email: { equals: input.email, mode: "insensitive" } },
                    ],
                },
                select: { id: true },
            });
            if (colleague) {
                throw fail(
                    "Employees cannot be referred; they can apply on the internal job board",
                    422,
                    "HR-RECRUITMENT-REFERRAL-EMPLOYEE",
                );
            }

            const base = {
                tenantId,
                requisitionId: requisition.id,
                referrerEmployeeId: employeeId,
                relationship: input.relationship,
                note: input.note,
            };

            const dnc = await checkIntakeDnc({ tenantId, email: input.email, tx, at });
            const existing = await tx.candidate.findFirst({
                // Case-insensitive: a recruiter may have keyed the address in mixed case.
                where: withTenant(tenantId, { email: { equals: input.email, mode: "insensitive" }, anonymizedAt: null }),
                select: CANDIDATE_SELECT,
            });
            const suppressedReason = dnc.blocked
                ? dnc.reason
                : existing && (existing.status !== "active" || existing.archivedAt)
                  ? "CANDIDATE_ARCHIVED"
                  : existing?.consentStatus === "WITHDRAWN"
                    ? "CONSENT_WITHDRAWN"
                    : null;
            if (suppressedReason) {
                const referral = await tx.internalReferral.create({ data: { ...base, status: REFERRAL_STATUS.REJECTED } });
                return { referral, suppressedReason, jobTitle: requisition.title };
            }

            if (existing) {
                // The same referrer sending the same contact again gets the
                // referral they already have, not a second row.
                const mine = await tx.internalReferral.findFirst({
                    where: withTenant(tenantId, {
                        requisitionId: requisition.id,
                        referrerEmployeeId: employeeId,
                        candidateId: existing.id,
                    }),
                });
                if (mine) return { referral: mine, replayed: true, jobTitle: requisition.title };

                const inProcess = await tx.application.findFirst({
                    where: withTenant(tenantId, { candidateId: existing.id, jobRequisitionId: requisition.id }),
                    select: { id: true },
                });
                if (inProcess) {
                    // No second application; the referral has none of its own
                    // either, so the status sync never moves it.
                    const referral = await tx.internalReferral.create({
                        data: { ...base, candidateId: existing.id, status: REFERRAL_STATUS.DUPLICATE },
                    });
                    await enqueueHrDomainEvent(tx, referralSubmittedEvent(referral, ctx, routing));
                    return { referral, jobTitle: requisition.title };
                }
            }

            const candidate =
                existing ??
                (await tx.candidate.create({
                    data: {
                        tenantId,
                        firstName: input.firstName,
                        lastName: input.lastName,
                        email: input.email,
                        phone: input.phone,
                        source: "Referral",
                        status: "active",
                        createdById: employeeId,
                        consentStatus: "GRANTED",
                        consentUpdatedAt: at,
                    },
                    select: CANDIDATE_SELECT,
                }));

            const created = await tx.internalReferral.create({
                data: { ...base, candidateId: candidate.id, status: REFERRAL_STATUS.SUBMITTED },
            });
            await tx.candidateConsent.create({
                data: {
                    candidateId: candidate.id,
                    tenantId,
                    purpose: "PROCESSING",
                    status: "GRANTED",
                    policyVersion: null,
                    source: "referral",
                    evidence: `The referring employee confirmed the person agreed to be referred (referral ${created.id})`,
                    occurredAt: at,
                    recordedById: employeeId,
                },
            });
            const application = await createApplicationInTx(tx, {
                candidateId: candidate.id,
                jobRequisitionId: requisition.id,
                tenantId,
                createdById: employeeId,
                source: "referral",
                sourceChannel: "REFERRAL",
                sourceDetail: referralSourceDetail(created.id),
            });
            await tx.internalReferral.updateMany({
                where: withTenant(tenantId, { id: created.id }),
                data: { applicationId: application.id },
            });
            const referral = { ...created, applicationId: application.id };
            await enqueueHrDomainEvent(tx, referralSubmittedEvent(referral, ctx, routing));
            return { referral, jobTitle: requisition.title };
        },
        { tenantId },
    );

    if (outcome.suppressedReason) {
        logIntakeSuppressed({ tenantId, email: input.email, path: "internal.referral", reason: outcome.suppressedReason });
    }
    return toSelfReferral(outcome.referral, { jobTitle: outcome.jobTitle });
}

/** The caller's own referrals, newest first: status and bonus status only. */
export async function listMyReferrals({ tenantId, employeeId, page = 1, pageSize = 50 } = {}) {
    requireTenantId(tenantId);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), MAX_PAGE_SIZE);
    const pageNo = Math.max(Number(page) || 1, 1);
    const where = withTenant(tenantId, { referrerEmployeeId: employeeId });
    const [total, rows] = await Promise.all([
        prisma.internalReferral.count({ where }),
        prisma.internalReferral.findMany({
            where,
            select: { id: true, requisitionId: true, relationship: true, status: true, bonusStatus: true, createdAt: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (pageNo - 1) * size,
            take: size,
        }),
    ]);
    const titles = await requisitionTitles(tenantId, rows.map((r) => r.requisitionId));
    return {
        items: rows.map((row) => toSelfReferral(row, { jobTitle: titles.get(row.requisitionId) ?? null })),
        total,
        page: pageNo,
        pageSize: size,
    };
}
