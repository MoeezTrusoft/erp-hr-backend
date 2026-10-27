import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
import { interviewCalendarFile } from "../lib/interviewCalendarFile.js";
import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { decryptString } from "../lib/crypto.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { sendCandidateNotification } from "../lib/notificationClient.js";
import {
  RECRUITMENT_TOKEN_TEMPLATES,
  RECRUITMENT_CALENDAR_TEMPLATES,
  recruitmentTemplateId,
} from "@trusoft/contracts/recruitment-communications";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { portalBaseUrl, readRecruitmentSettings } from "./recruitmentSettings.service.js";
const stageLabels = {
  applied: "submitted",
  screening: "under review",
  interview: "in the interview process",
  offer: "at the offer stage",
  hired: "accepted",
  rejected: "closed",
  on_hold: "under review",
  withdrawn: "withdrawn",
};
const stop = async (db, row, reason, status = "SUPPRESSED") => {
  await db.candidateCommunication.update({
    where: { id: row.id },
    data: {
      status,
      lastError: reason,
      encryptedPayload: null,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return null;
};
async function prepare(db, row, now) {
  if (row.expiresAt && row.expiresAt <= now) return stop(db, row, "Message expired", "CANCELLED");
  const candidate = await db.candidate.findFirst({
    where: {
      id: row.candidateId,
      tenantId: row.tenantId,
      anonymizedAt: null,
      status: "active",
    },
    select: { id: true, firstName: true, email: true, phone: true },
  });
  if (!candidate) return stop(db, row, "Candidate unavailable");
  try {
    await assertCommunicationsAllowed(
      {
        tenantId: row.tenantId,
        candidateId: row.candidateId,
        purpose: row.purpose,
        requireExplicitConsent: !RECRUITMENT_TOKEN_TEMPLATES.includes(row.templateKey),
        at: now,
      },
      { db },
    );
  } catch (e) {
    if (
      e.code === "HR-5701" ||
      e.code?.startsWith("HR-RECRUITMENT-DNC") ||
      e.code?.startsWith("HR-RECRUITMENT-CONSENT")
    )
      return stop(db, row, "Contact preference prevents delivery");
    throw e;
  }
  const context = row.context ?? {};
  let data = { firstName: candidate.firstName ?? "" };
  if (RECRUITMENT_TOKEN_TEMPLATES.includes(row.templateKey)) {
    const token =
      context.tokenPurpose === "DRAFT"
        ? await db.applicationDraft.findFirst({
            where: {
              tenantId: row.tenantId,
              candidateId: row.candidateId,
              tokenHash: context.tokenHash,
              expiresAt: { gt: now },
              submittedAt: null,
            },
            select: { id: true },
          })
        : await db.candidateEmailVerification.findFirst({
            where: {
              tenantId: row.tenantId,
              candidateId: row.candidateId,
              tokenHash: context.tokenHash,
              purpose: context.tokenPurpose,
              expiresAt: { gt: now },
              consumedAt: null,
              email: candidate.email,
            },
            select: { id: true },
          });
    if (!token || !row.encryptedPayload)
      return stop(db, row, "Mailbox link replaced or expired", "CANCELLED");
    const payload = JSON.parse(decryptString(row.encryptedPayload));
    if (payload.email !== candidate.email) return stop(db, row, "Mailbox changed", "CANCELLED");
    data = payload.data;
  } else if (row.templateKey === "talent_invitation") {
    const invitation = await db.talentPoolInvitation.findFirst({
      where: {
        id: context.invitationId ?? -1,
        tenantId: row.tenantId,
        candidateId: row.candidateId,
        status: "INVITED",
        expiresAt: { gt: now },
      },
    });
    if (!invitation) return stop(db, row, "Invitation no longer open", "CANCELLED");
    let job = null;
    if (invitation.jobRequisitionId) {
      job = await db.jobRequisition.findFirst({
        where: {
          id: invitation.jobRequisitionId,
          tenantId: row.tenantId,
          status: "POSTED",
        },
        include: { postings: { where: { channel: "CAREER_SITE" } } },
      });
      if (!job || !evaluateRequisitionEligibility(job, { postings: job.postings, now }).eligible)
        return stop(db, row, "Invited role no longer open", "CANCELLED");
    }
    data = {
      ...data,
      jobTitle: job?.title ?? "future opportunities",
      portalUrl: (await portalBaseUrl(db, row.tenantId)) + (job ? "/jobs/" + job.id : "/jobs"),
    };
  } else {
    if (row.applicationId)
      await db.$queryRawUnsafe(
        'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        row.applicationId,
        row.tenantId,
      );
    const application = row.applicationId
      ? await db.application.findFirst({
          where: {
            id: row.applicationId,
            tenantId: row.tenantId,
            candidateId: row.candidateId,
          },
          include: {
            jobRequisition: { select: { title: true } },
            offer: { select: { status: true } },
          },
        })
      : null;
    if (!application) return stop(db, row, "Application unavailable", "CANCELLED");
    if (row.templateKey === "interview_slots_offered") {
      const rows = await db.$queryRawUnsafe(
        `SELECT id FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid AND id=$2 AND "applicationId"=$3 AND status='OPEN' AND "expiresAt">$4`,
        row.tenantId,
        context.slotOfferId ?? -1,
        application.id,
        now,
      );
      if (!rows.length || ["hired", "rejected", "withdrawn"].includes(application.stage))
        return stop(db, row, "Slot offer is no longer open", "CANCELLED");
    }
    if (
      context.expectedApplicationVersion &&
      application.version !== context.expectedApplicationVersion
    )
      return stop(
        db,
        row,
        "Application version changed since this message was queued",
        "CANCELLED",
      );
    if (context.expectedStage && application.stage !== context.expectedStage)
      return stop(db, row, "Application moved since this message was queued", "CANCELLED");
    if (context.expectedOfferStatus && application.offer?.status !== context.expectedOfferStatus)
      return stop(db, row, "Offer moved since this message was queued", "CANCELLED");
    if (
      row.templateKey === "requisition_closed" &&
      (application.stage === "hired" || application.offer?.status === "ACCEPTED")
    )
      return stop(db, row, "Offer already accepted", "CANCELLED");
    const base = await portalBaseUrl(db, row.tenantId);
    data = {
      ...data,
      jobTitle: application.jobRequisition.title,
      statusLabel: stageLabels[application.stage] ?? "under review",
      portalUrl: base + "/status",
    };
    if (context.interviewId) {
      const interview = await db.interview.findFirst({
        where: {
          id: context.interviewId,
          tenantId: row.tenantId,
          applicationId: application.id,
        },
      });
      if (!interview) return stop(db, row, "Interview unavailable", "CANCELLED");
      if (
        ["interview_scheduled", "interview_rescheduled", "interview_reminder"].includes(
          row.templateKey,
        ) &&
        (interview.status !== "SCHEDULED" ||
          (context.eventTime &&
            new Date(context.eventTime).getTime() !== interview.scheduledAt.getTime()))
      )
        return stop(db, row, "Interview schedule changed", "CANCELLED");
      if (row.templateKey === "interview_cancelled" && interview.status !== "CANCELLED")
        return stop(db, row, "Interview cancellation no longer current", "CANCELLED");
      if (row.templateKey === "interview_reminder") {
        const latest = await db.interviewLifecycleEvent.findFirst({
          where: { tenantId: row.tenantId, interviewId: interview.id },
          orderBy: { id: "desc" },
          select: { id: true, eventType: true },
        });
        if (
          interview.scheduledAt <= now ||
          ["hired", "rejected", "withdrawn"].includes(application.stage) ||
          latest?.eventType === "RESCHEDULE_REQUESTED" ||
          (latest?.id ?? 0) !== context.interviewLifecycleId
        )
          return stop(db, row, "Interview reminder paused or superseded", "CANCELLED");
      }
      const { policy } = await readRecruitmentSettings(db, row.tenantId);
      data.interviewTime =
        new Intl.DateTimeFormat("en-GB", {
          dateStyle: "full",
          timeStyle: "short",
          timeZone: policy.timezone,
        }).format(interview.scheduledAt) +
        " (" +
        policy.timezone +
        ")";
      data.location = interview.location ?? "";
      data.meetingUrl = "";
      if (
        row.channel === "EMAIL" &&
        isRecruitmentFlagEnabled("calendar") &&
        RECRUITMENT_CALENDAR_TEMPLATES.includes(row.templateKey)
      ) {
        const sequence = await db.interviewLifecycleEvent.count({
          where: {
            tenantId: row.tenantId,
            interviewId: interview.id,
            eventType: { in: ["RESCHEDULED", "CANCELLED"] },
          },
        });
        data.calendarFile = interviewCalendarFile({
          ...interview,
          jobTitle: application.jobRequisition.title,
          sequence,
        });
      }
    }
  }
  const address = row.channel === "SMS" ? candidate.phone : candidate.email;
  if (!address || (row.channel === "SMS" && !/^\+[1-9]\d{7,14}$/.test(address)))
    return stop(db, row, "No valid address for this channel");
  return {
    tenantId: row.tenantId,
    ...(row.channel === "SMS" ? { phone: address } : { email: address }),
    channel: row.channel.toLowerCase(),
    templateId: recruitmentTemplateId(row.templateKey),
    data: { ...data, communicationExpiresAt: row.expiresAt?.toISOString() },
    dedupeKey: "recruitment:" + row.id,
    category: "hr.recruitment.candidate",
  };
}
export async function runCandidateCommunicationDelivery({
  now = new Date(),
  limit = 50,
  tenantId,
  send = sendCandidateNotification,
} = {}) {
  const where = {
    ...(tenantId ? { tenantId } : {}),
    scheduledAt: { lte: now },
    OR: [{ status: "PENDING" }, { status: "CLAIMED", leaseUntil: { lt: now } }],
  };
  if (!isRecruitmentFlagEnabled("communications"))
    where.templateKey = { in: RECRUITMENT_TOKEN_TEMPLATES };
  const rows = await prisma.candidateCommunication.findMany({
    where,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: { id: true, tenantId: true },
    take: Math.max(1, Math.min(limit, 200)),
  });
  const counts = { sent: 0, retried: 0, failed: 0, suppressed: 0 };
  for (const ref of rows)
    await runWithRequestContext({ system: false, user: { tenantId: ref.tenantId } }, async () => {
      const leaseToken = randomUUID();
      const claim = await tenantTransaction(
        prisma,
        async (db) => {
          const rows =
            await db.$queryRaw`SELECT id FROM candidate_communications WHERE id=${ref.id} AND "tenantId"=${ref.tenantId}::uuid AND "scheduledAt"<=${now} AND (status='PENDING' OR (status='CLAIMED' AND "leaseUntil"<${now})) FOR UPDATE SKIP LOCKED`;
          if (!rows.length) return null;
          const row = await db.candidateCommunication.findUnique({
            where: { id: ref.id },
          });
          // Suppression and expiry are permanent outcomes; provider/configuration failures retry.
          let message;
          try {
            message = await prepare(db, row, now);
          } catch {
            await db.candidateCommunication.update({
              where: { id: row.id },
              data: {
                status: "FAILED",
                lastError: "Message preparation requires operator attention",
                leaseToken: null,
                leaseUntil: null,
              },
            });
            return { outcome: "failed" };
          }
          if (!message) {
            return { outcome: "suppressed" };
          }
          await db.candidateCommunication.update({
            where: { id: row.id },
            data: {
              status: "CLAIMED",
              leaseToken,
              leaseUntil: new Date(now.getTime() + 5 * 60000),
              attempts: { increment: 1 },
            },
          });
          return { message, attempts: row.attempts + 1 };
        },
        { tenantId: ref.tenantId },
      );
      if (!claim) return;
      if (claim.outcome) {
        counts[claim.outcome]++;
        return;
      }
      let result;
      try {
        result = await send(claim.message);
      } catch {
        result = { sent: false, reason: "hub-unreachable" };
      }
      const terminal = claim.attempts >= 8;
      const status = result.sent
        ? "SENT"
        : result.suppressed
          ? "SUPPRESSED"
          : terminal
            ? "FAILED"
            : "PENDING";
      const changed = await tenantTransaction(
        prisma,
        (db) =>
          db.candidateCommunication.updateMany({
            where: {
              id: ref.id,
              tenantId: ref.tenantId,
              status: "CLAIMED",
              leaseToken,
            },
            data: {
              status,
              leaseToken: null,
              leaseUntil: null,
              providerRef: result.notificationId ?? null,
              sentAt: result.sent ? now : null,
              encryptedPayload: result.sent || result.suppressed ? null : undefined,
              scheduledAt: result.sent
                ? now
                : new Date(
                    now.getTime() + Math.min(21600000, 60000 * 2 ** Math.min(claim.attempts, 8)),
                  ),
              lastError: result.sent
                ? null
                : result.suppressed
                  ? "Provider suppressed this message"
                  : "Notification hub unavailable; retry required",
            },
          }),
        { tenantId: ref.tenantId },
      );
      // A cancelled or superseded lease has no committed outcome to count.
      if (changed.count !== 1) return;
      if (result.sent) counts.sent++;
      else if (result.suppressed) counts.suppressed++;
      else if (terminal) counts.failed++;
      else counts.retried++;
    });
  return counts;
}
