import { runRecruitmentAnalyticsAlerts } from "./recruitmentAnalyticsAlerts.service.js";
import { runTalentCampaignSuggestions } from "./talentCampaignSuggestions.service.js";
import { runCandidateDuplicateDetection } from "./candidateDuplicates.service.js";
import { runOnboardingCalendarSync } from "./onboardingCalendarSync.service.js";
import { runOnboardingUploads } from "./onboardingDocuments.service.js";
import { runOnboardingSignatures } from "./onboardingSignatures.service.js";
import { runOnboardingProvisioning } from "./onboardingProvisioning.service.js";
import { runOnboardingAutomation } from "./onboardingAutomation.service.js";
import { runInterviewStaffNotices } from "./interviewStaffNotices.service.js";
import { runInterviewReminders } from "./interviewReminders.service.js";
import { runInterviewCalendarSync } from "./interviewCalendarSync.service.js";
import { runOfferSignatures } from "./offerSignature.service.js";
import { runCandidateResumeParsing } from "./candidateResumeWorker.service.js";
import { runCandidateCommunicationErasure } from "./candidateCommunicationErasure.service.js";
import { runCandidateCommunicationProjection } from "./candidateCommunicationEvents.service.js";
import { runCandidateCommunicationDelivery } from "./candidateCommunicationDelivery.service.js";
import { runApplicationScoring } from "./applicationScoringWorker.service.js";
import { runCandidateMediaCleanup } from "./candidate-media-cleanup.service.js";
import prisma from "../lib/prisma.js";
import {
  runWithRequestContext,
  currentRequestContext,
} from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { autoCloseFilledRequisitions } from "./requisitionPublication.service.js";
import { closeRequisition } from "./requisitionMgmt.service.js";
import { expireInvitations } from "./talentPoolInvitation.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

export const RECRUITMENT_JOBS = Object.freeze([
  {
    name: "recruitment-analytics-alerts",
    flag: "analytics",
    pattern: "35 * * * *",
  },
  {
    name: "talent-campaign-suggestions",
    flag: "workflow",
    pattern: "*/5 * * * *",
  },
  {
    name: "candidate-duplicate-detection",
    flag: "workflow",
    pattern: "*/10 * * * *",
  },
  { name: "onboarding-calendar-sync", flag: null, pattern: "* * * * *" },
  { name: "onboarding-document-scans", flag: null, pattern: "* * * * *" },
  { name: "onboarding-signatures", flag: null, pattern: "* * * * *" },
  {
    name: "onboarding-provisioning",
    flag: "onboarding",
    pattern: "*/5 * * * *",
  },
  { name: "onboarding-milestones", flag: "onboarding", pattern: "0 * * * *" },
  {
    name: "interview-staff-notices",
    flag: "communications",
    pattern: "* * * * *",
  },
  { name: "interview-reminders", flag: "communications", pattern: "* * * * *" },
  { name: "interview-calendar-sync", flag: null, pattern: "* * * * *" },
  { name: "offer-signatures", flag: null, pattern: "* * * * *" },
  { name: "candidate-resume-parsing", flag: "ai", pattern: "* * * * *" },
  {
    name: "candidate-communication-events",
    flag: "communications",
    pattern: "* * * * *",
  },
  {
    name: "candidate-communication-delivery",
    flag: null,
    pattern: "* * * * *",
  },
  { name: "application-scoring", flag: "scoring", pattern: "*/2 * * * *" },
  {
    name: "candidate-communication-erasure",
    flag: null,
    pattern: "*/5 * * * *",
  },
  { name: "candidate-media-cleanup", flag: null, pattern: "*/5 * * * *" },
  { name: "requisition-autoclose", flag: "workflow", pattern: "0 * * * *" },
  {
    name: "talent-pool-invitation-expiry",
    flag: "workflow",
    pattern: "20 4 * * *",
  },
  { name: "offer-expiry", flag: "offerHandoff", pattern: "0 * * * *" },
]);
export async function runRecruitmentAutomation({
  kind,
  now = new Date(),
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
      code: "HR-5304",
    });
  const definition = RECRUITMENT_JOBS.find((j) => j.name === kind);
  if (!definition) throw new Error("Unknown recruitment job");
  if (definition.flag && !isRecruitmentFlagEnabled(definition.flag))
    return { skipped: true, reason: "flag-disabled" };
  if (kind === "recruitment-analytics-alerts")
    return runRecruitmentAnalyticsAlerts({ now });
  if (kind === "talent-campaign-suggestions")
    return runTalentCampaignSuggestions({ now });
  if (kind === "candidate-duplicate-detection")
    return runCandidateDuplicateDetection({ now });
  if (kind === "onboarding-calendar-sync")
    return runOnboardingCalendarSync({ now });
  if (kind === "onboarding-document-scans")
    return runOnboardingUploads({ now });
  if (kind === "onboarding-signatures") return runOnboardingSignatures({ now });
  if (kind === "onboarding-provisioning")
    return runOnboardingProvisioning({ now });
  if (kind === "onboarding-milestones") return runOnboardingAutomation({ now });
  if (kind === "interview-staff-notices")
    return runInterviewStaffNotices({ now });
  if (kind === "interview-reminders") return runInterviewReminders({ now });
  if (kind === "interview-calendar-sync")
    return runInterviewCalendarSync({ now });
  if (kind === "offer-signatures") return runOfferSignatures({ now });
  if (kind === "candidate-communication-events")
    return runCandidateCommunicationProjection({ now });
  if (kind === "candidate-communication-delivery")
    return runCandidateCommunicationDelivery({ now });
  if (kind === "candidate-resume-parsing")
    return runCandidateResumeParsing({ now });
  if (kind === "application-scoring") return runApplicationScoring({ now });
  if (kind === "candidate-communication-erasure")
    return runCandidateCommunicationErasure();
  if (kind === "candidate-media-cleanup")
    return runCandidateMediaCleanup({ now });
  const model =
    kind === "offer-expiry"
      ? "offer"
      : kind === "talent-pool-invitation-expiry"
        ? "talentPoolInvitation"
        : "jobRequisition";
  const tenants = await prisma[model].findMany({
    where: { tenantId: { not: null } },
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  const results = [];
  for (const { tenantId } of tenants) {
    await runWithRequestContext(
      { system: false, recruitmentAutomation: true, user: { tenantId } },
      async () => {
        if (kind === "requisition-autoclose") {
          const closed = await autoCloseFilledRequisitions({ tenantId, now });
          const expired = await prisma.jobRequisition.findMany({
            where: { tenantId, status: "POSTED", closesAt: { lte: now } },
            select: { id: true },
            take: 500,
          });
          for (const r of expired)
            await closeRequisition(
              r.id,
              tenantId,
              null,
              "APPLICATION_WINDOW_EXPIRED",
            );
          results.push({
            tenantId,
            closed: closed.length,
            expired: expired.length,
          });
        } else if (kind === "talent-pool-invitation-expiry") {
          results.push({
            tenantId,
            ...(await expireInvitations({
              tenantId,
              asOf: now,
              dryRun: false,
            })),
          });
        } else {
          const offers = await prisma.offer.findMany({
            where: { tenantId, status: "SENT", expiryDate: { lte: now } },
            select: { id: true, candidateId: true, createdById: true },
            take: 500,
          });
          for (const offer of offers)
            await tenantTransaction(
              prisma,
              async (tx) => {
                await tx.$queryRawUnsafe(
                  'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
                  offer.candidateId,
                  tenantId,
                );
                await tx.$queryRawUnsafe(
                  'SELECT id FROM offers WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
                  offer.id,
                  tenantId,
                );
                const signing = await tx.$queryRawUnsafe(
                  'SELECT state FROM offer_signature_requests WHERE "tenantId"=$1::uuid AND "offerId"=$2',
                  tenantId,
                  offer.id,
                );
                // The signature worker must reconcile the provider before expiring an offer.
                if (
                  signing.some(
                    (job) =>
                      !["CANCELLED", "ERASED", "FAILED"].includes(job.state),
                  )
                )
                  return;
                const changed = await tx.offer.updateMany({
                  where: {
                    tenantId,
                    id: offer.id,
                    status: "SENT",
                    expiryDate: { lte: now },
                  },
                  data: { status: "EXPIRED", version: { increment: 1 } },
                });
                if (changed.count)
                  await enqueueHrDomainEvent(tx, {
                    tenantId,
                    eventName: "hr.recruitment.offer_expired.v1",
                    aggregateType: "Offer",
                    aggregateId: String(offer.id),
                    payload: {
                      offerId: String(offer.id),
                      candidateId: String(offer.candidateId),
                      createdById:
                        offer.createdById == null
                          ? null
                          : String(offer.createdById),
                    },
                  });
              },
              { tenantId },
            );
          results.push({ tenantId, expired: offers.length });
        }
      },
    );
  }
  return { kind, results };
}
