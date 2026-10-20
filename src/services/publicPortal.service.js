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
//
// Recruitment Phase 2 adds four things, all inside the same transaction:
//
//   * DNC AT INTAKE (D-11). An address on the do-not-contact register is
//     accepted on the wire exactly like any other — same status, same body —
//     but nothing is created and nothing is sent; one pino line records the
//     tenant and a hash of the address. The check runs AFTER the form is
//     validated, so a bad form is refused the same way for every address.
//   * D-16 ORDER. The answers are validated before the duplicate check too, so
//     "already applied" cannot be told apart from "new" by sending an invalid
//     form (it used to short-circuit to 201 before validation); a concurrent
//     duplicate that loses the unique race also answers 201.
//   * KNOCKOUT. Each answer is checked against its question's knockout rule;
//     the application stores answerScore / answerMaxScore / knockedOut and each
//     answer its own knockedOut. With the `knockout` flag on, a knocked-out
//     application gets a PENDING scheduled disposition (reversible until it
//     runs — services/scheduled-disposition.service.js); off, the outcome is
//     only recorded.
//   * SOURCE + RESUME. sourceChannel / sourcePostingId / sourceDetail from the
//     job feed's apply link are stamped on the application (CAREER_SITE by
//     default); a resume carried by a draft is linked to the candidate and
//     queued for parsing after commit.
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationCreatedEvent } from "./hrEvents.js";
import { issueEmailVerification, sendVerificationEmail, issueStatusLink, sendApplicationConfirmation } from "./candidateVerification.service.js";
import { evaluateRequisitionEligibility, closedApplicationMessage } from "../lib/requisitionEligibility.js";
import { validateAnswer, scoreAnswers } from "../lib/applicationQuestions.js";
import { parsePublicApplicationInput, getPublicJob as getPublicJobShape } from "../lib/publicPortal.js";
import { INTERNAL_ONLY_CHANNELS, PUBLIC_CHANNELS, publicPostings } from "../lib/requisitionPublication.js";
import {
    checkIntakeDnc,
    logIntakeSuppressed,
    normalizeSourceChannel,
    normalizeSourceDetail,
} from "./intake-dnc.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { scheduleKnockoutDisposition } from "./scheduled-disposition.service.js";
import { enqueueCandidateResumeParse } from "./resume-parse-queue.service.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// The uniform response for a submitted application. Deliberately ignores
// whether the candidate was new or matched — that difference must not be
// observable (§3.4).
const SUBMITTED = Object.freeze({
    received: true,
    // D-16 — the response is byte-identical for a new and a repeated
    // application. The candidate's reference travels in the confirmation email
    // to the mailbox owner, never in the anonymous HTTP response.
});

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// The channels an anonymous portal applicant may not tag themselves with.
export const PORTAL_UNCLAIMABLE_CHANNELS = Object.freeze([...INTERNAL_ONLY_CHANNELS, "REFERRAL"]);

/**
 * Source attribution from the apply link the job feed published
 * (`<portalBaseUrl>/jobs/<id>?source=<CHANNEL>&posting=<postingId>`), sent by
 * the portal as body fields. The posting is kept only when it is one of THIS
 * requisition's active postings (the requisition was read tenant-scoped with
 * its active postings), so a forged id attributes nothing. Pure.
 */
export function parseSourceAttribution(body = {}, { postings = [], defaultChannel = "CAREER_SITE" } = {}) {
    const postingId = positiveInt(body?.sourcePostingId);
    // Recruitment Phase 5 — an anonymous applicant cannot claim the internal
    // channel: INTERNAL attribution belongs to the employees' own board.
    // Phase 6 — nor REFERRAL: a referral only comes from an employee through
    // that board, so a self-tagged one would credit (and pay) nobody's referral.
    const claimed = normalizeSourceChannel(body?.sourceChannel, defaultChannel);
    return {
        sourceChannel: PORTAL_UNCLAIMABLE_CHANNELS.includes(claimed) ? defaultChannel : claimed,
        sourcePostingId: postingId && postings.some((p) => p.id === postingId && p.isActive !== false) ? postingId : null,
        sourceDetail: normalizeSourceDetail(body?.sourceDetail),
    };
}

/**
 * Validate and score every answer against the active question set. Throws the
 * uniform 400 on any problem; returns the rows to store and the outcome.
 */
function evaluateAnswers(questions, rawAnswers) {
    const answerErrors = [];
    const scoredAnswers = [];
    for (const question of questions) {
        const key = String(question.id);
        const raw = Object.prototype.hasOwnProperty.call(rawAnswers, key) ? rawAnswers[key] : undefined;
        const result = validateAnswer(question, raw);
        if (!result.ok) answerErrors.push(...result.errors);
        else {
            scoredAnswers.push({
                questionId: question.id,
                value: result.value,
                score: result.score,
                knockedOut: result.knockedOut === true,
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
    return { scoredAnswers, outcome: scoreAnswers(questions, scoredAnswers) };
}

/**
 * @param {object} args
 * @param {number|null} [args.resumeMediaId] a resume the TRUSTED caller (the
 *   draft submit, from its own row) carries; never read from the anonymous body.
 */
export const submitPublicApplication = async ({ tenantId, requisitionId, body = {}, now = new Date(), resumeMediaId = null } = {}) => {
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
    const mediaId = positiveInt(resumeMediaId);
    // Read before the transaction: the delay only matters when the flag is on.
    const knockoutEnabled = isRecruitmentFlagEnabled("knockout");
    const settings = knockoutEnabled ? await getRecruitmentSettings({ tenantId }) : null;

    let result;
    try {
        result = await tenantTransaction(
            prisma,
            async (tx) => await intakeInTransaction(tx, { tenantId, reqId, input, body, now, mediaId, knockoutEnabled, settings }),
            { tenantId },
        );
    } catch (err) {
        // D-16 — two concurrent submissions of the same candidate+requisition:
        // the loser hits the unique index. It is still "received", exactly
        // like the duplicate path; the winner's emails cover the mailbox.
        if (err?.code === "P2002") return { ...SUBMITTED, requisitionId: reqId };
        throw err;
    }

    if (result.suppressed) {
        logIntakeSuppressed({ tenantId, email: input.email, path: "portal.apply", reason: result.reason });
        return { ...SUBMITTED, requisitionId: reqId };
    }

    // AFTER commit: queue the carried resume for parsing. Never fails the apply
    // (the queue's own contract), and a parse never runs inside the request.
    if (result.created && mediaId) {
        await enqueueCandidateResumeParse({
            tenantId,
            candidateId: result.candidateId,
            mediaId,
            applicationId: result.applicationId,
        });
    }

    await sendIntakeEmails(tenantId, result);

    return {
        ...SUBMITTED,
        requisitionId: reqId,
    };
};

/**
 * Candidate reconciliation (§3.4). Only rows in the caller's tenant
 * participate; an anonymized or archived row is NOT resurrected — a fresh row
 * is created, because re-identifying an erased person would defeat the erasure.
 */
async function reconcileCandidate(tx, { tenantId, input, now, mediaId }) {
    const existing = await tx.candidate.findFirst({
        where: {
            tenantId,
            email: input.email,
            anonymizedAt: null,
            status: "active",
        },
    });

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
                // A carried resume fills an empty slot; it never replaces one.
                ...(mediaId && existing.resumeMediaId == null ? { resumeMediaId: mediaId } : {}),
                version: { increment: 1 },
            },
        });
        return { candidateId: existing.id, reconciled: true };
    }
    const created = await tx.candidate.create({
        data: {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            phone: input.phone,
            source: input.source,
            ...(mediaId ? { resumeMediaId: mediaId } : {}),
            status: "active",
            tenantId,
            // §3.3 — consent state on the row itself, so the legacy
            // consentStatus reads stay truthful without a join.
            consentStatus: "GRANTED",
            consentUpdatedAt: now,
        },
    });
    return { candidateId: created.id, reconciled: false };
}

/** The intake itself, on the caller's tenant transaction. */
async function intakeInTransaction(tx, { tenantId, reqId, input, body, now, mediaId, knockoutEnabled, settings }) {
    // Recruitment Phase 5 — only PUBLIC postings open a job to the portal; an
    // INTERNAL-only job answers like an unknown one.
    const requisition = await tx.jobRequisition.findFirst({
        where: { id: reqId, tenantId, status: "POSTED" },
        include: { postings: { where: { isActive: true, channel: { in: [...PUBLIC_CHANNELS] } } } },
    });
    // Anti-enumeration: unknown id and closed job look IDENTICAL from the
    // outside — same status, same code, same message.
    if (!requisition) throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
    const evaluation = evaluateRequisitionEligibility(requisition, { postings: publicPostings(requisition.postings), now });
    if (!evaluation.eligible) {
        throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND", {
            candidateMessage: closedApplicationMessage(requisition, evaluation),
        });
    }

    // ── §3.5 per-requisition questions ───────────────────────────────────
    // The requisition's ACTIVE question set is the form contract. Every
    // answer is validated and scored HERE, at submission time, against the
    // same pure module the recruiter-facing CRUD uses — scores are stored,
    // never recomputed, so later weight edits cannot rewrite a candidate's
    // record. A skipped optional question still gets a row (value null),
    // so "was this question asked?" stays answerable for analytics.
    // Validated BEFORE the DNC and duplicate checks (D-16, see header).
    const questions = await tx.applicationQuestion.findMany({
        where: { requisitionId: reqId, tenantId, isActive: true },
        orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
    });
    const { scoredAnswers, outcome } = evaluateAnswers(questions, input.answers ?? {});

    // ── D-11 do-not-contact ──────────────────────────────────────────────
    // A register hit creates nothing and sends nothing; the caller answers
    // with the uniform success body.
    const dnc = await checkIntakeDnc({ tenantId, email: input.email, tx, at: now });
    if (dnc.blocked) return { suppressed: true, reason: dnc.reason };

    // ── Candidate reconciliation (§3.4) ──────────────────────────────────────
    const { candidateId, reconciled } = await reconcileCandidate(tx, { tenantId, input, now, mediaId });

    // Duplicate application: same candidate, same requisition. D-16 — it is
    // answered exactly like a new one (201, same body), so the endpoint
    // cannot be used to test which emails have applied where. Nothing new
    // is created; the mailbox owner gets a fresh status link and an
    // "already received" email instead.
    const duplicate = await tx.application.findFirst({
        where: { candidateId, jobRequisitionId: reqId },
        select: { id: true },
    });
    if (duplicate) {
        const statusLink = await issueStatusLink(tx, {
            tenantId,
            candidate: { id: candidateId, firstName: input.firstName },
            email: input.email,
        });
        return {
            applicationId: duplicate.id,
            candidateId,
            created: false,
            issued: null,
            statusLink,
            reconciled: true,
            jobTitle: requisition.title,
        };
    }

    const application = await tx.application.create({
        data: {
            candidateId,
            jobRequisitionId: reqId,
            stage: "applied",
            status: "open",
            tenantId,
            createdById: null, // anonymous — no employee actor exists
            ...parseSourceAttribution(body, { postings: requisition.postings ?? [] }),
            answerScore: outcome.answerScore,
            answerMaxScore: outcome.answerMaxScore,
            knockedOut: outcome.knockedOut,
        },
    });

    if (scoredAnswers.length) {
        await tx.applicationAnswer.createMany({
            data: scoredAnswers.map((a) => ({
                applicationId: application.id,
                questionId: a.questionId,
                value: a.value,
                score: a.score,
                // The column defaults to false; only a knockout is written.
                ...(a.knockedOut ? { knockedOut: true } : {}),
            })),
        });
    }

    // Knockout — flag on: the reversible rejection is scheduled in this
    // transaction; flag off: the outcome above is all that is recorded.
    if (outcome.knockedOut && knockoutEnabled) {
        await scheduleKnockoutDisposition(tx, {
            tenantId,
            applicationId: application.id,
            questionIds: outcome.knockoutQuestionIds,
            delayHours: settings?.knockoutDelayHours,
            now,
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

    // (returns: the application id rides out of the transaction; the token
    // and the reconciled-candidate artifacts are sent post-commit below)

    // §3.2 — the verification token row JOINS the application transaction
    // (HTTP-free; the email goes out after commit — an outbound call must
    // never hold a DB transaction open). FR-04.11 — a STATUS LINK is also
    // issued in-transaction, because the confirmation email that goes out
    // after commit CARRIES it: every applicant — new or returning — gets
    // their self-service tracking/recovery entry point at submission (the
    // spec's "existing candidate email must offer sign-in/recovery" edge
    // case, made concrete). The §3.4 mailbox-owner notice is folded into
    // the RECONCILED confirmation variant, so the reconciled applicant
    // gets ONE email that both confirms and warns — and none of the
    // response's byte-identical contract depends on which variant was
    // chosen (that happens off the wire, in the post-commit send).
    const issued = await issueEmailVerification(tx, {
        tenantId,
        candidate: { id: candidateId, firstName: input.firstName },
        email: input.email,
    });
    const statusLink = await issueStatusLink(tx, {
        tenantId,
        candidate: { id: candidateId, firstName: input.firstName },
        email: input.email,
    });

    return {
        applicationId: application.id,
        candidateId,
        created: true,
        issued,
        statusLink,
        reconciled,
        jobTitle: requisition.title,
    };
}

// AFTER commit: the fire-and-forget sends. A hub outage never fails the
// submission (sendCandidateEmail is fail-soft and outcome-logged).
async function sendIntakeEmails(tenantId, result) {
    if (result.issued) {
        await sendVerificationEmail({
            tenantId,
            email: result.issued.email,
            firstName: result.issued.firstName,
            token: result.issued.token,
        });
    }
    if (result.statusLink) {
        await sendApplicationConfirmation({
            tenantId,
            email: result.statusLink.email,
            firstName: result.statusLink.firstName,
            token: result.statusLink.token,
            jobTitle: result.jobTitle,
            applicationRef: result.applicationId,
            reconciled: result.reconciled,
        });
    }
}

// What the public form may know about a question: what to ask and how to
// render it. Never the weights, the score ceiling or the knockout flag/rule —
// a visible knockout rule is an answer key.
const PUBLIC_QUESTION_SELECT = Object.freeze({
    id: true,
    type: true,
    prompt: true,
    required: true,
    options: true,
});

const toPublicQuestion = (q) => ({
    id: q.id,
    label: q.prompt,
    type: q.type,
    required: q.required === true,
    options: q.options ?? null,
});

/**
 * One job's public detail plus its application form (the active questions in
 * display order). Null in every "not available" case, like the shape it wraps.
 */
export async function getPublicJob({ tenantId, prisma: db = prisma, id, now = new Date() } = {}) {
    const job = await getPublicJobShape({ tenantId, prisma: db, id, now });
    if (!job) return null;
    const questions = await db.applicationQuestion.findMany({
        where: { requisitionId: job.id, tenantId, isActive: true },
        orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
        select: PUBLIC_QUESTION_SELECT,
    });
    return { ...job, questions: questions.map(toPublicQuestion) };
}

/** The public listing read — a thin re-export so routes import one module. */
export { listPublicJobs } from "../lib/publicPortal.js";
