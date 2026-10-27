import prisma from "../lib/prisma.js";
import { userIdToUuid } from "@trusoft/contracts/identity";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
import { suggestedCampaignFilters } from "./talentPoolCampaign.service.js";
import { summarizeTalentPoolSegment } from "./talentPoolInvitation.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

/** Publication produces a recruiter review notice, never candidate invitations.
 * An audit receipt commits with its outbox event, once per posting and owner. */
export async function runTalentCampaignSuggestions({
  now = new Date(),
  tenantId,
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
      code: "HR-5304",
    });
  if (!isRecruitmentFlagEnabled("workflow"))
    return { skipped: true, reason: "flag-disabled" };
  const where = {
    tenantId: tenantId ?? { not: null },
    channel: "CAREER_SITE",
    isActive: true,
  };
  const tenants = await prisma.jobPosting.findMany({
    where,
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  const result = { scanned: 0, suggested: 0, unchanged: 0, unroutable: 0 };
  for (const tenant of tenants)
    await runWithRequestContext(
      {
        system: false,
        recruitmentAutomation: true,
        user: { tenantId: tenant.tenantId },
      },
      async () => {
        let cursor = 0;
        for (;;) {
          const rows = await prisma.jobPosting.findMany({
            where: { ...where, tenantId: tenant.tenantId, id: { gt: cursor } },
            select: { id: true, requisitionId: true },
            orderBy: { id: "asc" },
            take: 100,
          });
          for (const ref of rows) {
            result.scanned++;
            await tenantTransaction(
              prisma,
              async (tx) => {
                await tx.$queryRawUnsafe(
                  'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
                  tenant.tenantId,
                  ref.requisitionId,
                );
                const job = await tx.jobRequisition.findFirst({
                  where: {
                    tenantId: tenant.tenantId,
                    id: ref.requisitionId,
                    status: "POSTED",
                  },
                  include: {
                    postings: {
                      where: {
                        tenantId: tenant.tenantId,
                        id: ref.id,
                        channel: "CAREER_SITE",
                        isActive: true,
                      },
                    },
                  },
                });
                if (
                  !job ||
                  !evaluateRequisitionEligibility(job, {
                    postings: job.postings,
                    now,
                  }).eligible
                )
                  return;
                const recipient = job.recruiterId
                  ? await tx.employee.findFirst({
                      where: {
                        tenant_id: tenant.tenantId,
                        id: job.recruiterId,
                        status: "Active",
                        employement_status: "Active",
                        userId: { gt: 0 },
                      },
                      select: { id: true, userId: true },
                    })
                  : null;
                if (!recipient) {
                  result.unroutable++;
                  return;
                }
                const prefix =
                  "talent-suggestion:" + ref.id + ":" + recipient.userId + ":";
                const seen = await tx.log.findFirst({
                  where: {
                    tenantId: tenant.tenantId,
                    module: "Talent Pool Campaign",
                    action_type: "CAMPAIGN_SUGGESTED",
                    notes: { startsWith: prefix },
                  },
                  select: { id: true },
                });
                if (seen) {
                  result.unchanged++;
                  return;
                }
                const filters = suggestedCampaignFilters(job);
                const segment = await summarizeTalentPoolSegment({
                  tenantId: tenant.tenantId,
                  filters,
                  db: tx,
                });
                // Keep only aggregate counts in the notice; review fetches fresh candidates.
                if (!segment.counts.matched) return;
                await enqueueHrDomainEvent(tx, {
                  tenantId: tenant.tenantId,
                  eventName: "hr.recruitment.talent_campaign_suggested.v1",
                  aggregateType: "JobRequisition",
                  aggregateId: String(job.id),
                  occurredAt: now.toISOString(),
                  payload: {
                    requisitionId: String(job.id),
                    postingId: String(ref.id),
                    matchedCount: segment.counts.matched,
                    recipientUserIds: [
                      userIdToUuid(tenant.tenantId, recipient.userId),
                    ],
                  },
                });
                await tx.log.create({
                  data: {
                    tenantId: tenant.tenantId,
                    employeeId: recipient.id,
                    type: "Update",
                    action_type: "CAMPAIGN_SUGGESTED",
                    module: "Talent Pool Campaign",
                    ip: "unknown",
                    os: "server",
                    result: "SUCCESS",
                    notes:
                      prefix +
                      JSON.stringify({
                        jobRequisitionId: job.id,
                        postingId: ref.id,
                        filters,
                        matchedCount: segment.counts.matched,
                      }),
                  },
                });
                result.suggested++;
              },
              {
                tenantId: tenant.tenantId,
                txOptions: { maxWait: 10000, timeout: 60000 },
              },
            );
          }
          if (rows.length < 100) break;
          cursor = rows.at(-1).id;
        }
      },
    );
  return result;
}
