// src/services/publicPortal.service.js
//
// Phase 5 / decision record §3.1–§3.5 — public application intake.
//
// The portal accepts an application from an anonymous visitor. The decisions
// that shape this file:
//
//   * §3.4 — DO NOT REVEAL WHETHER AN EMAIL EXISTS. A returning candidate's
//     application is reconciled onto their existing Candidate row; the response
//     body and status are byte-identical for "created a new candidate" and
//     "matched an existing one", so responses cannot be diffed to enumerate the
//     candidate base. Reconciliation updates ONLY contact fields the submitter
//     themselves typed, and never resurrects an anonymized/archived row.
//   * §3.3 — consent records the policy document version the portal sent, the
//     purpose (PROCESSING), the timestamp and the portal source. It never
//     invents a version; a missing policyVersion is stored as null rather than
//     fabricated as "v1".
//   * §3.3a — this records PROCESSING consent ONLY. Talent-pool and marketing
//     consent are separate records with separate purposes and are never bundled
//     into a job application.
//   * §2.9 — the requisition eligibility gate (the same rule the recruiter-side
//     creation path uses) runs inside the write transaction, so a window that
//     closes mid-flight still wins.
//   * Everything commits or rolls back as ONE transaction: candidate row,
//     application row, stage history, consent record.
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationCreatedEvent } from "./hrEvents.js";
import { evaluateRequisitionEligibility, closedApplicationMessage } from "../lib/requisitionEligibility.js";
import { validateAnswer } from "../lib/applicationQuestions.js";
import { parsePublicApplicationInput } from "../lib/publicPortal.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// The uniform response for a submitted application. Deliberately ignores
// whether the candidate was new or matched — that difference must not be
// observable (§3.4).
const SUBMITTED = Object.freeze({
    received: true,
    // A reference the candidate can quote; it is the application row's id.
    // Stable across the new/existing cases because both produce an application.
});

export const submitPublicApplication = async ({ tenantId, requisitionId, body = {}, now = new Date() } = {}) => {
    // Phase 15 — the portal is flag-gated (§3). Off returns the SAME 404 shape
    // as an unknown job: an anonymous caller must never learn whether the
    // portal is disabled or the position does not exist (§3.4's no-oracle rule).
    if (!isRecruitmentFlagEnabled("portal")) {
        throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
    }
    if (!tenantId) throw fail("Tenant context is required", 500, "HR-TENANT-REQUIRED");
    const input = parsePublicApplicationInput(body);
    const reqId = Number(requisitionId);
    if (!Number.isInteger(reqId) || reqId <= 0) {
        // Same shape as "unknown job": no oracle for id probing.
        throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
    }

    return tenantTransaction(prisma, async (tx) => {
        const requisition = await tx.jobRequisition.findFirst({
            where: { id: reqId, tenantId, status: "POSTED" },
            include: { postings: { where: { isActive: true } } },
        });
        // Anti-enumeration: unknown id and closed job look IDENTICAL from the
        // outside — same status, same code, same message.
        if (!requisition) throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
        const evaluation = evaluateRequisitionEligibility(requisition, { postings: requisition.postings, now });
        if (!evaluation.eligible) {
            throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND", {
                candidateMessage: closedApplicationMessage(requisition, evaluation),
            });
        }

        // ── Candidate reconciliation (§3.4) ──────────────────────────────────
        // Only rows in the caller's tenant participate; an anonymized or
        // archived row is NOT resurrected — a fresh row is created, because
        // re-identifying an erased person would defeat the erasure.
        const existing = await tx.candidate.findFirst({
            where: {
                tenantId,
                email: input.email,
                anonymizedAt: null,
                status: "active",
            },
        });

        let candidateId;
        if (existing) {
            // Update ONLY what the submitter themselves typed, and only when the
            // row is missing it — a candidate's existing phone must not be
            // overwritten by whatever the portal form sent.
            await tx.candidate.update({
                where: { id: existing.id },
                data: {
                    firstName: existing.firstName || input.firstName,
                    lastName: existing.lastName ?? input.lastName,
                    phone: existing.phone ?? input.phone,
                    version: { increment: 1 },
                },
            });
            candidateId = existing.id;
        } else {
            const created = await tx.candidate.create({
                data: {
                    firstName: input.firstName,
                    lastName: input.lastName,
                    email: input.email,
                    phone: input.phone,
                    source: input.source,
                    status: "active",
                    tenantId,
                    // §3.3 — consent state on the row itself, so the legacy
                    // consentStatus reads stay truthful without a join.
                    consentStatus: "GRANTED",
                    consentUpdatedAt: now,
                },
            });
            candidateId = created.id;
        }

        // Duplicate application: same candidate, same requisition. Rejected with
        // the SAME envelope as a success-minus-duplicate, so the endpoint cannot
        // be used to test which emails have applied where.
        const duplicate = await tx.application.findFirst({
            where: { candidateId, jobRequisitionId: reqId },
            select: { id: true },
        });
        if (duplicate) {
            throw fail("Application already received", 409, "HR-PORTAL-DUPLICATE");
        }

        // ── §3.5 per-requisition questions ───────────────────────────────────
        // The requisition's ACTIVE question set is the form contract. Every
        // answer is validated and scored HERE, at submission time, against the
        // same pure module the recruiter-facing CRUD uses — scores are stored,
        // never recomputed, so later weight edits cannot rewrite a candidate's
        // record. A skipped optional question still gets a row (value null),
        // so "was this question asked?" stays answerable for analytics.
        const questions = await tx.applicationQuestion.findMany({
            where: { requisitionId: reqId, tenantId, isActive: true },
            orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
        });
        const rawAnswers = input.answers ?? {};
        const answerErrors = [];
        const scoredAnswers = [];
        for (const question of questions) {
            const key = String(question.id);
            const raw = Object.prototype.hasOwnProperty.call(rawAnswers, key)
                ? rawAnswers[key]
                : undefined;
            const result = validateAnswer(question, raw);
            if (!result.ok) answerErrors.push(...result.errors);
            else {
                scoredAnswers.push({
                    questionId: question.id,
                    value: result.value,
                    score: result.score,
                });
            }
        }
        // Keys that map to no active question mean the caller is answering a
        // form the requisition no longer presents — refuse rather than silently
        // drop what the candidate typed.
        for (const key of Object.keys(rawAnswers)) {
            if (!questions.some((q) => String(q.id) === key)) {
                answerErrors.push(`Unknown answer for question "${key}"`);
            }
        }
        if (answerErrors.length) {
            throw fail("Please review your answers", 400, "HR-PORTAL-ANSWERS-INVALID", {
                errors: answerErrors,
            });
        }

        const application = await tx.application.create({
            data: {
                candidateId,
                jobRequisitionId: reqId,
                stage: "applied",
                status: "open",
                tenantId,
                createdById: null, // anonymous — no employee actor exists
            },
        });

        if (scoredAnswers.length) {
            await tx.applicationAnswer.createMany({
                data: scoredAnswers.map((a) => ({
                    applicationId: application.id,
                    questionId: a.questionId,
                    value: a.value,
                    score: a.score,
                })),
            });
        }

        await tx.applicationStageHistory.create({
            data: {
                applicationId: application.id,
                tenantId,
                fromStage: "applied",
                toStage: "applied",
                reason: "public portal application",
                actorId: null,
                source: "public-portal",
            },
        });

        // §3.3 — the consent record, only when the portal declared a policy
        // version. Recording PROCESSING consent without knowing which document
        // the candidate saw would be worse than not recording it.
        if (input.policyVersion) {
            await tx.candidateConsent.create({
                data: {
                    candidateId,
                    tenantId,
                    purpose: "PROCESSING",
                    status: "GRANTED",
                    policyVersion: input.policyVersion,
                    source: "portal",
                    occurredAt: now,
                    recordedById: null,
                },
            });
        }

        await logAction({
            employeeId: null,
            type: "CREATE",
            module: "Public Application",
            result: "SUCCESS",
            notes: `Application "${application.id}" received via public portal for requisition "${reqId}"`,
            tenantId,
        });

        await enqueueHrDomainEvent(tx, applicationCreatedEvent(application, {}));

        return {
            ...SUBMITTED,
            applicationId: application.id,
            requisitionId: reqId,
        };
    });
};

/** The public listing/detail reads — thin re-exports so routes import one module. */
export { listPublicJobs, getPublicJob } from "../lib/publicPortal.js";
