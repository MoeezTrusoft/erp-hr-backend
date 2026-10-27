import { resolveJobBoardSource } from "./job-board-feeds.service.js";
import { referralChanged, agencyChanged } from "./recruitmentSourcingEvents.service.js";
import { draftApplicationOrigin } from "./recruitmentDraftSource.service.js";
import { computeRetentionUntil } from "./candidatePrivacy.service.js";
import { enqueueCandidateResume } from "./candidateResumeQueue.service.js";
import { convertAcceptedPoolInvitation } from "./talentPoolConversion.service.js";
import { snapshotApplicationQuestions } from "../lib/applicationQuestionSnapshot.js";
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
import { portalPolicy } from "../lib/portalPolicy.js";
import { resolveDraft } from "./applicationDraft.service.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationCreatedEvent } from "./hrEvents.js";
import { issueEmailVerification, issueStatusLink } from "./candidateVerification.service.js";
import {
  evaluateRequisitionEligibility,
  closedApplicationMessage,
} from "../lib/requisitionEligibility.js";
import { validateAnswer } from "../lib/applicationQuestions.js";
import { parsePublicApplicationInput } from "../lib/publicPortal.js";

const fail = (message, status, code, details) =>
  Object.assign(new Error(message), {
    status,
    code,
    ...(details ? { details } : {}),
  });

// The uniform response for a submitted application. Deliberately ignores
// whether the candidate was new or matched — that difference must not be
// observable (§3.4).
const SUBMITTED = Object.freeze({
  received: true,
  // A reference the candidate can quote; it is the application row's id.
  // Stable across the new/existing cases because both produce an application.
});

export const submitPublicApplication = async ({
  tenantId,
  requisitionId,
  body = {},
  draftToken = null,
  now = new Date(),
} = {}) => {
  // Phase 15 — the portal is flag-gated (§3). Off returns the SAME 404 shape
  // as an unknown job: an anonymous caller must never learn whether the
  // portal is disabled or the position does not exist (§3.4's no-oracle rule).
  if (!isRecruitmentFlagEnabled("portal")) {
    throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
  }
  if (!tenantId) throw fail("Tenant context is required", 500, "HR-TENANT-REQUIRED");
  let input = draftToken ? null : parsePublicApplicationInput(body);
  const reqId = Number(requisitionId);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    // Same shape as "unknown job": no oracle for id probing.
    throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
  }

  const result = await tenantTransaction(
    prisma,
    async (tx) => {
      const draft = draftToken
        ? await resolveDraft(tx, {
            tenantId,
            token: draftToken,
            now,
            lock: true,
          })
        : null;
      if (draftToken && (!draft || draft.requisitionId !== reqId))
        throw fail("This draft link is not valid", 400, "HR-5801");
      if (draft)
        input = parsePublicApplicationInput({
          ...draft.payload,
          email: draft.candidate.email,
        });
      const policy = portalPolicy(tenantId);
      if (!input.consent || input.policyVersion !== policy.version)
        throw fail("Please review and accept the current privacy policy.", 400, "HR-5803");
      if (draft) {
        await tx.applicationDraft.update({
          where: { id: draft.id },
          data: { submittedAt: now },
        });
        await tx.candidate.update({
          where: { id: draft.candidateId },
          data: {
            emailVerifiedAt: now,
            ...(draft.resumeMediaId ? { resumeMediaId: draft.resumeMediaId } : {}),
          },
        });
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":" + input.email}, 0))`;
      await tx.$queryRawUnsafe(
        'SELECT id FROM "JobRequisition" WHERE id=$1 AND "tenantId"=$2::uuid FOR SHARE',
        reqId,
        tenantId,
      );
      const requisition = await tx.jobRequisition.findFirst({
        where: {
          id: reqId,
          tenantId,
          status: "POSTED",
          postings: {
            some: {
              isActive: true,
              closedAt: null,
              channel: ["INTERNAL", "REFERRAL", "AGENCY"].includes(draft?.source)
                ? draft.source
                : "CAREER_SITE",
            },
          },
        },
        include: {
          postings: {
            where: {
              isActive: true,
              closedAt: null,
              channel: ["INTERNAL", "REFERRAL", "AGENCY"].includes(draft?.source)
                ? draft.source
                : "CAREER_SITE",
            },
          },
        },
      });
      // Anti-enumeration: unknown id and closed job look IDENTICAL from the
      // outside — same status, same code, same message.
      if (!requisition) throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
      const evaluation = evaluateRequisitionEligibility(requisition, {
        postings: requisition.postings,
        now,
      });
      if (!evaluation.eligible) {
        throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND", {
          candidateMessage: closedApplicationMessage(requisition, evaluation),
        });
      }

      const applicationSource =
        draft?.source ||
        (await resolveJobBoardSource(tx, {
          tenantId,
          requisitionId: reqId,
          receipt: body?.sourceReceipt,
          now,
        }));
      const dnc = await tx.candidateDncEntry.findFirst({
        where: { tenantId, email: input.email, liftedAt: null },
      });
      if (dnc) return { applicationId: null };
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
            source: applicationSource,
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
        where: { tenantId, candidateId, jobRequisitionId: reqId },
      });
      if (duplicate && !draft) {
        return { applicationId: duplicate.id };
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

      // A mailbox-owned resubmission may attach accepted invitation provenance,
      // but it must not rewrite frozen answers or resurrect a terminal application.
      if (duplicate) {
        if (draft.candidateId === candidateId) {
          await convertAcceptedPoolInvitation(tx, duplicate);
          if (draft.resumeMediaId)
            await enqueueCandidateResume(tx, {
              tenantId,
              candidateId,
              mediaId: draft.resumeMediaId,
              now,
            });
        }
        return { applicationId: duplicate.id };
      }

      const application = await tx.application.create({
        data: {
          candidateId,
          ...draftApplicationOrigin(draft),
          source: applicationSource,
          jobRequisitionId: reqId,
          stage: "applied",
          status: "open",
          tenantId,
          questionSnapshot: snapshotApplicationQuestions(questions),
          createdById: null, // anonymous — no employee actor exists
        },
      });

      if (draft?.source === "REFERRAL") {
        const referral = await tx.internalReferral.update({
          where: { id: draft.internalReferralId },
          data: { state: "SUBMITTED", version: { increment: 1 } },
        });
        await referralChanged(tx, referral);
      }
      if (["INTERNAL", "REFERRAL", "AGENCY"].includes(draft?.source)) {
        await tx.candidate.update({
          where: { id: candidateId },
          data: {
            consentStatus: "GRANTED",
            consentUpdatedAt: now,
            retentionPopulation: "APPLICANT",
            retentionUntil: await computeRetentionUntil({ tenantId, from: now }, { db: tx }),
          },
        });
      }
      if (draft?.source === "AGENCY") {
        const submission = await tx.agencySubmission.update({
          where: { id: draft.agencySubmissionId },
          data: { state: "SUBMITTED", version: { increment: 1 } },
        });
        await agencyChanged(tx, { ...submission, submissionId: submission.id });
      }
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
          reason:
            draft?.source === "INTERNAL"
              ? "internal employee application"
              : draft?.source === "REFERRAL"
                ? "employee referral application"
                : draft?.source === "AGENCY"
                  ? "candidate-confirmed agency application"
                  : "public portal application",
          actorId: null,
          source:
            draft?.source === "INTERNAL"
              ? "internal-self-service"
              : draft?.source === "REFERRAL"
                ? "employee-referral"
                : draft?.source === "AGENCY"
                  ? "agency-candidate"
                  : "public-portal",
        },
      });

      await logAction({
        employeeId: null,
        type: "CREATE",
        module: "Public Application",
        result: "SUCCESS",
        notes: `Application "${application.id}" received via public portal for requisition "${reqId}"`,
        tenantId,
      });

      await enqueueHrDomainEvent(tx, applicationCreatedEvent(application, {}));
      // Only possession of the emailed draft can associate the accepted invitation.
      // An anonymous email submission must never promote somebody else’s application.
      if (draft && draft.candidateId === candidateId) {
        await convertAcceptedPoolInvitation(tx, application);
        if (draft.resumeMediaId)
          await enqueueCandidateResume(tx, {
            tenantId,
            candidateId,
            mediaId: draft.resumeMediaId,
            now,
          });
      }

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
        templateKey: existing
          ? "portal_application_confirmed_existing"
          : "portal_application_confirmed",
        applicationRef: application.id,
        jobTitle: requisition.title,
        tenantId,
        candidate: { id: candidateId, firstName: input.firstName },
        email: input.email,
      });

      return {
        applicationId: application.id,
        issued,
        statusLink,
        reconciled: Boolean(existing),
        jobTitle: requisition.title,
      };
    },
    { tenantId },
  );

  // Message intents already committed with the application; the worker owns delivery.
  return {
    ...SUBMITTED,
    applicationId: result.applicationId,
    requisitionId: reqId,
  };
};

/** The public listing/detail reads — thin re-exports so routes import one module. */
export { listPublicJobs, getPublicJob } from "../lib/publicPortal.js";
