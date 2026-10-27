import prisma from "../lib/prisma.js";
import { userIdToUuid } from "@trusoft/contracts/identity";
import { RecruitmentPolicy } from "@trusoft/contracts/recruitment-policy";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import logger from "../lib/logger.js";
import { computeRecruitmentAnalyticsForScheduler } from "./recruitmentAnalytics.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
export function analyticsThresholdBreaches(metrics, policy) {
  const p = policy.analyticsAlerts;
  if (!p.enabled || metrics.unavailable) return [];
  const rows = [];
  const check = (kind, value, threshold, sample, below = false) => {
    if (
      threshold != null &&
      value != null &&
      Number.isFinite(value) &&
      sample >= p.minimumSample &&
      (below ? value < threshold : value > threshold)
    )
      rows.push({ kind, value, threshold, sample });
  };
  check(
    "TIME_TO_FILL",
    metrics.timeToFill.meanTimeToFillDays,
    p.maxTimeToFillDays,
    metrics.timeToFill.requisitionsFilled,
  );
  check(
    "CONFIRMED_TIME_TO_START",
    metrics.attendanceConfirmedTimeToStart.meanTimeToStartDays,
    p.maxConfirmedTimeToStartDays,
    metrics.attendanceConfirmedTimeToStart.startsMeasured,
  );
  check(
    "OFFER_ACCEPTANCE",
    metrics.offerAcceptance.acceptanceRatePct,
    p.minOfferAcceptancePct,
    metrics.offerAcceptance.finalOutcomes,
    true,
  );
  check(
    "OFFER_DECLINE",
    metrics.offerAcceptance.declineRatePct,
    p.maxOfferDeclinePct,
    metrics.offerAcceptance.finalOutcomes,
  );
  if (
    p.maxFailedHandoffs != null &&
    metrics.handoffs?.failed > p.maxFailedHandoffs
  )
    rows.push({
      kind: "FAILED_HANDOFFS",
      value: metrics.handoffs.failed,
      threshold: p.maxFailedHandoffs,
      sample: metrics.handoffs.attempted,
    });
  if (
    metrics.slaAging.configured &&
    metrics.slaAging.breached > p.maxSlaBreaches
  )
    rows.push({
      kind: "STAGE_SLA_BREACHES",
      value: metrics.slaAging.breached,
      threshold: p.maxSlaBreaches,
      sample: metrics.slaAging.openApplications,
    });
  return rows;
}
export async function runRecruitmentAnalyticsAlerts({
  tenantId,
  now = new Date(),
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
      code: "HR-5304",
    });
  if (!isRecruitmentFlagEnabled("analytics"))
    return { skipped: true, reason: "flag-disabled" };
  const settings = await prisma.recruitmentSettings.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      policy: { path: ["analyticsAlerts", "enabled"], equals: true },
    },
    select: { tenantId: true, version: true, policy: true },
  });
  const result = {
    scanned: 0,
    enqueued: 0,
    unchanged: 0,
    unroutable: 0,
    failed: 0,
  };
  for (const setting of settings) {
    try {
      const policy = RecruitmentPolicy.parse(setting.policy),
        p = policy.analyticsAlerts;
      const to = new Date(now);
      to.setUTCHours(0, 0, 0, 0);
      to.setTime(+to - 1);
      const from = new Date(+to + 1 - p.lookbackDays * 86400000);
      const filters = {
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
      };
      const report = await computeRecruitmentAnalyticsForScheduler(
        setting.tenantId,
        filters,
      );
      result.scanned++;
      if (report.policyVersion !== setting.version) continue;
      const breaches = analyticsThresholdBreaches(
        report.canonicalMetrics,
        policy,
      );
      await runWithRequestContext(
        { system: false, user: { tenantId: setting.tenantId } },
        () =>
          tenantTransaction(
            prisma,
            async (tx) => {
              await tx.$executeRawUnsafe(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                setting.tenantId + ":analytics-alerts",
              );
              const current = await tx.$queryRawUnsafe(
                'SELECT version FROM recruitment_settings WHERE "tenantId"=$1::uuid FOR SHARE',
                setting.tenantId,
              );
              if (current[0]?.version !== setting.version) return;
              const recipients = await tx.employee.findMany({
                where: {
                  tenant_id: setting.tenantId,
                  id: { in: p.recipientEmployeeIds },
                  status: "Active",
                  employement_status: "Active",
                  userId: { gt: 0 },
                },
                select: { userId: true },
              });
              if (!recipients.length) {
                result.unroutable++;
                return;
              }
              for (const breach of breaches) {
                const prefix =
                  "analytics-alert:" +
                  setting.version +
                  ":" +
                  breach.kind +
                  ":";
                const prior = await tx.log.findFirst({
                  where: {
                    tenantId: setting.tenantId,
                    module: "Recruitment Analytics",
                    action_type: "THRESHOLD_ALERT",
                    notes: { startsWith: prefix },
                    created_at: {
                      gt: new Date(+now - p.cooldownHours * 3600000),
                    },
                  },
                  select: { id: true },
                });
                if (prior) {
                  result.unchanged++;
                  continue;
                }
                const payload = {
                  ...breach,
                  policyVersion: setting.version,
                  dateFrom: from.toISOString().slice(0, 10),
                  dateTo: to.toISOString().slice(0, 10),
                  recipientUserIds: [
                    ...new Set(
                      recipients.map((e) =>
                        userIdToUuid(setting.tenantId, e.userId),
                      ),
                    ),
                  ],
                };
                await enqueueHrDomainEvent(tx, {
                  tenantId: setting.tenantId,
                  eventName: "hr.recruitment.analytics_threshold_breached.v1",
                  aggregateType: "RecruitmentSettings",
                  aggregateId: setting.tenantId,
                  occurredAt: now.toISOString(),
                  payload,
                });
                await tx.log.create({
                  data: {
                    tenantId: setting.tenantId,
                    type: "Update",
                    action_type: "THRESHOLD_ALERT",
                    module: "Recruitment Analytics",
                    ip: "unknown",
                    os: "server",
                    result: "SUCCESS",
                    created_at: now,
                    notes:
                      prefix +
                      JSON.stringify({
                        ...breach,
                        filters,
                        policyVersion: setting.version,
                      }),
                  },
                });
                result.enqueued++;
              }
            },
            { tenantId: setting.tenantId },
          ),
      );
    } catch (error) {
      result.failed++;
      logger.error(
        { tenantId: setting.tenantId, code: error.code ?? "HR-5000" },
        "Recruitment analytics alert evaluation failed",
      );
    }
  }
  return result;
}
