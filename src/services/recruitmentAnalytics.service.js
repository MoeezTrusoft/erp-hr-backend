import { readRecruitmentSettings } from "./recruitmentSettings.service.js";
import prisma from "../lib/prisma.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertPermission } from "../lib/assertPermission.js";
import {
  resolveRecruitmentScope,
  applicationScopeWhere,
  requisitionScopeWhere,
} from "../lib/recruitmentAccess.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { actor } from "./separation/base.js";
import {
  aggregateTimeToFill,
  aggregateTimeToHire,
  metricsVersionBlock,
  offerAcceptance,
  slaAging,
  sourceEffectiveness as canonicalSourceEffectiveness,
  stageFunnel,
  timeInStageForApplication,
  timeToFillForRequisition,
  timeToHireForApplication,
} from "../lib/recruitmentMetrics.js";

const STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "on_hold",
  "withdrawn",
];
const CLOSED = new Set(["hired", "rejected", "withdrawn"]);
const FILTER_KEYS = [
  "dateFrom",
  "dateTo",
  "requisitionIds",
  "departmentId",
  "stage",
  "source",
];
const MAX_ROWS = 50000;
const fail = (
  message,
  status = 400,
  code = "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID",
) => {
  throw Object.assign(new Error(message), { status, code });
};
const positiveId = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;
export function normalizeAnalyticsFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters))
    fail("Filters must be an object");
  if (Object.keys(filters).some((k) => !FILTER_KEYS.includes(k)))
    fail("Unsupported analytics filter");
  const out = {};
  for (const key of ["dateFrom", "dateTo"])
    if (filters[key] != null && filters[key] !== "") {
      const date = new Date(filters[key]);
      if (!Number.isFinite(date.getTime())) fail(key + " is not a valid date");
      out[key] = date;
    }
  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo)
    fail("dateFrom must not be after dateTo");
  if (filters.requisitionIds != null) {
    if (
      !Array.isArray(filters.requisitionIds) ||
      filters.requisitionIds.length > 100 ||
      filters.requisitionIds.some((v) => !positiveId(v))
    )
      fail("Select at most 100 positive requisition IDs");
    if (filters.requisitionIds.length)
      out.requisitionIds = [...new Set(filters.requisitionIds.map(Number))];
  }
  if (filters.departmentId != null) {
    if (!positiveId(filters.departmentId))
      fail("departmentId must be a positive ID");
    out.departmentId = Number(filters.departmentId);
  }
  if (filters.stage != null && filters.stage !== "") {
    if (!STAGES.includes(filters.stage)) fail("Unknown application stage");
    out.stage = filters.stage;
  }
  if (filters.source != null && filters.source !== "") {
    if (
      typeof filters.source !== "string" ||
      !filters.source.trim() ||
      filters.source.length > 200
    )
      fail("Invalid candidate source");
    out.source = filters.source.trim();
  }
  return out;
}
const serializeFilters = (n) =>
  Object.fromEntries(
    Object.entries(n).map(([k, v]) => [
      k,
      v instanceof Date ? v.toISOString() : v,
    ]),
  );
const applicationFilters = (n) => ({
  ...(n.stage ? { stage: n.stage } : {}),
  ...(n.source
    ? n.source === "Unknown"
      ? {
          AND: [
            { OR: [{ source: null }, { source: "" }] },
            { candidate: { OR: [{ source: null }, { source: "" }] } },
          ],
        }
      : {
          OR: [
            { source: n.source },
            {
              AND: [
                { OR: [{ source: null }, { source: "" }] },
                { candidate: { source: n.source } },
              ],
            },
          ],
        }
    : {}),
  ...(n.dateFrom || n.dateTo
    ? {
        appliedAt: {
          ...(n.dateFrom ? { gte: n.dateFrom } : {}),
          ...(n.dateTo ? { lte: n.dateTo } : {}),
        },
      }
    : {}),
});
const requisitionFilters = (n) => ({
  ...(n.requisitionIds ? { id: { in: n.requisitionIds } } : {}),
  ...(n.departmentId ? { departmentId: n.departmentId } : {}),
});
const appSelect = {
  source: true,
  id: true,
  stage: true,
  appliedAt: true,
  updatedAt: true,
  candidate: { select: { id: true, source: true } },
  jobRequisition: {
    select: { id: true, title: true, departmentId: true, recruiterId: true },
  },
  interviews: { select: { id: true } },
  offer: {
    select: {
      status: true,
      respondedAt: true,
      sentAt: true,
      startDate: true,
      handoff: {
        select: {
          id: true,
          status: true,
          attemptCount: true,
          updated_at: true,
        },
      },
    },
  },
  stageHistory: { select: { fromStage: true, toStage: true, createdAt: true } },
  screenings: { select: { outcome: true, reasonCode: true, reviewedAt: true } },
};
async function snapshot(tenantId, filters, method = "GET", automation = false) {
  const ctx = currentRequestContext();
  if (automation) {
    if (
      !ctx?.recruitmentAutomation ||
      !tenantId ||
      ctx.user?.tenantId !== tenantId
    )
      fail("Scheduler company context required", 403);
  } else {
    if (!ctx?.actorVerified || !tenantId || ctx.user?.tenantId !== tenantId)
      fail("Verified company context required", 401);
    assertPermission(ctx.permissions, method, "hr:recruitment", false);
  }
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = automation ? null : await actor(tx, ctx),
        scope = automation
          ? { level: "ORG", unrestricted: true }
          : resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (!["ORG", "MANAGED"].includes(scope.level))
        fail("Recruiter or hiring manager required", 403);
      const settings = await readRecruitmentSettings(tx, tenantId);
      const n = normalizeAnalyticsFilters(filters),
        appFilters = applicationFilters(n),
        reqFilters = requisitionFilters(n);
      const applications = await tx.application.findMany({
        where: {
          AND: [
            { tenantId },
            applicationScopeWhere(scope),
            appFilters,
            { jobRequisition: reqFilters },
          ],
        },
        select: appSelect,
        orderBy: { id: "asc" },
        take: MAX_ROWS + 1,
      });
      if (applications.length > MAX_ROWS)
        fail(
          "Narrow the reporting filters to at most 50,000 applications",
          413,
          "HR-RECRUITMENT-ANALYTICS-TOO-LARGE",
        );
      const requisitions = await tx.jobRequisition.findMany({
        where: {
          AND: [
            { tenantId },
            requisitionScopeWhere(scope),
            reqFilters,
            ...(Object.keys(appFilters).length
              ? [{ applications: { some: { tenantId, ...appFilters } } }]
              : []),
          ],
        },
        select: {
          id: true,
          title: true,
          departmentId: true,
          recruiterId: true,
          status: true,
          openings: true,
          transitions: {
            select: { fromStatus: true, toStatus: true, createdAt: true },
          },
        },
        orderBy: { id: "asc" },
        take: MAX_ROWS + 1,
      });
      if (requisitions.length > MAX_ROWS)
        fail(
          "Narrow the reporting filters to at most 50,000 requisitions",
          413,
          "HR-RECRUITMENT-ANALYTICS-TOO-LARGE",
        );
      const generatedAt = new Date();
      // Join only the already-authorized application cohort. A completed handoff
      // and settled attendance are evidence of joining; the planned date is not.
      const starts = applications.length
        ? await tx.$queryRawUnsafe(
            `SELECT o."applicationId", a.id AS "attendanceId", a.check_in AS "actualStartAt"
             FROM offers o
             JOIN offer_handoffs h ON h."offerId"=o.id AND h."tenantId"=o."tenantId" AND h.status='COMPLETED'
             JOIN "Employee" e ON e.id=h."employeeId" AND e.tenant_id=o."tenantId"
             JOIN LATERAL (
               SELECT att.id, att.check_in FROM "Attendance" att
               WHERE att."tenantId"=o."tenantId" AND att."employeeId"=e.id
                 AND att.status IN ('PRESENT','LATE','HALF_DAY','EARLY_CHECKOUT')
                 AND att."processingState"='FINALIZED' AND att."finalizedAt" IS NOT NULL
                 AND NOT att.requires_regularization AND att.day_credit>0
                 AND att.check_in >= GREATEST(o."respondedAt", COALESCE(o."startDate",o."respondedAt"))
                 AND att.check_in <= $3 AND att."finalizedAt" <= $3
               ORDER BY att.check_in, att.id LIMIT 1
             ) a ON TRUE
             WHERE o."tenantId"=$1::uuid AND o."applicationId"=ANY($2::int[])
               AND o.status='ACCEPTED' AND o."respondedAt" IS NOT NULL`,
            tenantId,
            applications.filter((a) => a.stage === "hired").map((a) => a.id),
            generatedAt,
          )
        : [];
      const startsByApplication = new Map(
        starts.map((s) => [s.applicationId, s]),
      );
      // All-time tenant spend cannot be allocated to a filtered cohort or a manager's subset.
      const costReason =
        scope.level !== "ORG"
          ? "scope-not-allocated"
          : Object.keys(n).length
            ? "filters-not-allocated"
            : null;
      const cost = costReason
        ? null
        : await tx.recruitmentCostConfig.findFirst({
            where: { tenantId, period: "all" },
          });
      return {
        applications: applications.map((a) => ({
          ...a,
          confirmedStart: startsByApplication.get(a.id) ?? null,
        })),
        requisitions,
        cost,
        costReason: costReason ?? (cost ? null : "not-configured"),
        filters: serializeFilters(n),
        generatedAt: generatedAt.toISOString(),
        policyVersion: settings.version,
        stageSlaDays: settings.version
          ? settings.policy.stageSlaDays
          : getSlaConfig(),
        scope: scope.level,
      };
    },
    {
      tenantId,
      txOptions: { isolationLevel: "RepeatableRead", timeout: 30000 },
    },
  );
}
function disposition(a) {
  return (
    [...(a.screenings ?? [])]
      .filter((s) => s.outcome !== "ADVANCE" && s.reasonCode)
      .sort((x, y) => new Date(y.reviewedAt) - new Date(x.reviewedAt))[0]
      ?.reasonCode ?? null
  );
}
const funnelInput = (a) => ({
  applicationId: a.id,
  currentStage: a.stage,
  appliedAt: a.appliedAt,
  history: a.stageHistory ?? [],
  dispositionReasonCode: disposition(a),
});
function getSlaConfig() {
  try {
    const v = JSON.parse(process.env.HR_RECRUITMENT_STAGE_SLA_DAYS || "{}");
    return Object.fromEntries(
      Object.entries(v).filter(
        ([k, d]) =>
          (STAGES.includes(k) || k === "*") &&
          typeof d === "number" &&
          Number.isFinite(d) &&
          d >= 0,
      ),
    );
  } catch {
    return {};
  }
}
function evidence(s) {
  const byReq = new Map();
  for (const a of s.applications) {
    if (!byReq.has(a.jobRequisition.id)) byReq.set(a.jobRequisition.id, []);
    byReq.get(a.jobRequisition.id).push(a);
  }
  const requisitions = s.requisitions.map((r) => {
    const apps = byReq.get(r.id) ?? [];
    return {
      requisitionId: r.id,
      title: r.title,
      departmentId: r.departmentId,
      recruiterId: r.recruiterId,
      status: r.status,
      applicationIds: apps.map((a) => a.id),
      ...timeToFillForRequisition(
        r.transitions,
        apps.map((a) => a.offer).filter(Boolean),
        r.openings,
      ),
    };
  });
  const sla = s.stageSlaDays;
  const applications = s.applications.map((a) => {
    const durations = timeInStageForApplication(
      a.stageHistory ?? [],
      a.stage,
      a.appliedAt,
      new Date(s.generatedAt),
    );
    const current = durations.find((d) => d.isCurrent);
    const timeToStartDays =
      a.offer?.status === "ACCEPTED" && a.offer.respondedAt && a.offer.startDate
        ? Math.round(
            (new Date(a.offer.startDate) - new Date(a.offer.respondedAt)) /
              8640000,
          ) / 10
        : null;
    return {
      applicationId: a.id,
      candidateId: a.candidate.id,
      stage: a.stage,
      appliedAt: a.appliedAt,
      source: a.source || a.candidate.source || "Unknown",
      requisitionId: a.jobRequisition.id,
      requisitionTitle: a.jobRequisition.title,
      interviewCount: a.interviews.length,
      handoffId: a.offer?.handoff?.id ?? null,
      handoffStatus: a.offer?.handoff?.status ?? null,
      handoffAttempts: a.offer?.handoff?.attemptCount ?? 0,
      handoffUpdatedAt: a.offer?.handoff?.updated_at ?? null,
      offerStatus: a.offer?.status ?? null,
      offerRespondedAt: a.offer?.respondedAt ?? null,
      startDate: a.offer?.startDate ?? null,
      timeToHireDays: timeToHireForApplication(a),
      timeToStartDays: timeToStartDays >= 0 ? timeToStartDays : null,
      actualStartAt: a.confirmedStart?.actualStartAt ?? null,
      attendanceId: a.confirmedStart?.attendanceId ?? null,
      confirmedTimeToStartDays:
        a.confirmedStart && a.offer?.respondedAt
          ? Math.round(
              (new Date(a.confirmedStart.actualStartAt) -
                new Date(a.offer.respondedAt)) /
                8640000,
            ) / 10
          : null,
      dispositionReasonCode: disposition(a),
      stageDurations: durations,
      funnel: stageFunnel([funnelInput(a)]),
      sla:
        !CLOSED.has(a.stage) && current
          ? slaAging(current.stage, current.daysInStage, sla)
          : null,
    };
  });
  const workload = new Map();
  for (const r of requisitions) {
    const k = r.recruiterId ?? null;
    if (!workload.has(k))
      workload.set(k, {
        recruiterId: k,
        openRequisitions: 0,
        activeApplications: 0,
        requisitionIds: [],
        applicationIds: [],
      });
    const row = workload.get(k);
    if (!["CLOSED", "WITHDRAWN", "REJECTED"].includes(r.status)) {
      row.openRequisitions++;
      row.requisitionIds.push(r.requisitionId);
    }
  }
  for (const a of s.applications)
    if (!CLOSED.has(a.stage)) {
      const row = workload.get(a.jobRequisition.recruiterId ?? null);
      if (row) {
        row.activeApplications++;
        row.applicationIds.push(a.id);
      }
    }
  return { applications, requisitions, workload: [...workload.values()], sla };
}
function costPayload(s) {
  const c = s.cost,
    parts = c
      ? {
          jobAds: Number(c.jobAds),
          agencyFees: Number(c.agencyFees),
          tools: Number(c.tools),
          other: Number(c.other),
        }
      : null;
  const total = parts ? Object.values(parts).reduce((a, b) => a + b, 0) : null;
  const hires = s.applications.filter((a) => a.stage === "hired").length;
  return {
    costPerHire: {
      value:
        total != null && hires ? Math.round((total / hires) * 100) / 100 : null,
      totalCost: total,
      currency: c?.currency ?? null,
      costModel: c ? "actual" : "unavailable",
      reason: s.costReason,
    },
    costBreakdown: {
      ...(parts ?? {
        jobAds: null,
        agencyFees: null,
        tools: null,
        other: null,
      }),
      currency: c?.currency ?? null,
      costModel: c ? "actual" : "unavailable",
      reason: s.costReason,
    },
  };
}
function report(s) {
  const e = evidence(s),
    cost = costPayload(s),
    apps = s.applications;
  const hires = apps.filter((a) => a.stage === "hired"),
    sourceRows = canonicalSourceEffectiveness(
      apps.map((a) => ({
        source: a.source || a.candidate.source,
        applicationId: a.id,
        enteredInterview:
          (a.stageHistory ?? []).some((h) => h.toStage === "interview") ||
          ["interview", "offer", "hired"].includes(a.stage),
        isHire: a.stage === "hired",
        timeToHireDays: timeToHireForApplication(a),
      })),
    );
  const acceptance = offerAcceptance(apps.map((a) => a.offer).filter(Boolean)),
    timeToHire = aggregateTimeToHire(
      e.applications.map((a) => a.timeToHireDays),
    );
  const slaRows = e.applications.map((a) => a.sla).filter(Boolean);
  const monthly = new Map();
  for (const a of e.applications)
    if (a.timeToHireDays != null) {
      const month = new Date(a.offerRespondedAt).toISOString().slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, []);
      monthly.get(month).push(a.timeToHireDays);
    }
  const timeToHireTrend = [...monthly]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({ month, ...aggregateTimeToHire(values) }));
  const startLead = aggregateTimeToHire(
    e.applications.map((a) => a.timeToStartDays),
  );
  const confirmedStarts = aggregateTimeToHire(
    e.applications.map((a) => a.confirmedTimeToStartDays),
  );
  const canonical = {
    ...metricsVersionBlock(),
    unavailable: false,
    timeToFill: {
      ...aggregateTimeToFill(e.requisitions),
      perRequisition: e.requisitions,
    },
    timeToHire,
    timeToHireTrend,
    timeToStart: {
      definition:
        "Accepted offer to planned start date; excludes missing dates and starts before acceptance. This is planned lead time, not attendance-confirmed joining.",
      meanTimeToStartDays: startLead.meanTimeToHireDays,
      medianTimeToStartDays: startLead.medianTimeToHireDays,
      startsMeasured: startLead.hiresMeasured,
    },
    attendanceConfirmedTimeToStart: {
      definitionVersion: 1,
      definition:
        "Accepted offer to first finalized, positive-credit attendance check-in on or after the planned start and acceptance, for a completed hire handoff. Pending, absent, leave and future attendance are excluded.",
      meanTimeToStartDays: confirmedStarts.meanTimeToHireDays,
      medianTimeToStartDays: confirmedStarts.medianTimeToHireDays,
      startsMeasured: confirmedStarts.hiresMeasured,
    },
    recruiterWorkload: e.workload,
    stageFunnel: stageFunnel(apps.map(funnelInput)),
    offerAcceptance: acceptance,
    handoffs: {
      definitionVersion: 1,
      definition:
        "Latest handoff state for offers in the authorized application cohort. Failed counts unresolved failures, not historical retry attempts.",
      attempted: e.applications.filter((a) => a.handoffStatus != null).length,
      failed: e.applications.filter((a) => a.handoffStatus === "FAILED").length,
      completed: e.applications.filter((a) => a.handoffStatus === "COMPLETED")
        .length,
      inProgress: e.applications.filter(
        (a) => a.handoffStatus === "IN_PROGRESS",
      ).length,
    },
    sourceEffectiveness: sourceRows,
    slaAging: {
      configured: Object.keys(e.sla).length > 0,
      openApplications: slaRows.length,
      breached: slaRows.filter((r) => r.breached).length,
      byStage: slaRows.reduce((o, r) => {
        o[r.stage] ??= { open: 0, breached: 0, worstAgingDays: null };
        const x = o[r.stage];
        x.open++;
        if (r.breached) x.breached++;
        if (r.agingDays != null)
          x.worstAgingDays = Math.max(x.worstAgingDays ?? 0, r.agingDays);
        return o;
      }, {}),
    },
  };
  return {
    filters: s.filters,
    policyVersion: s.policyVersion,
    generatedAt: s.generatedAt,
    scope: s.scope,
    illustrativeCostData: false,
    totalHires: hires.length,
    timeToHireDays: timeToHire.meanTimeToHireDays,
    offerAcceptanceRatePct: acceptance.acceptanceRatePct,
    ...cost,
    hiringFunnel: {
      applied: apps.length,
      screened: apps.filter((a) =>
        ["screening", "interview", "offer", "hired"].includes(a.stage),
      ).length,
      interviewed: apps.filter((a) => a.interviews.length).length,
      offered: apps.filter((a) => a.offer).length,
      hired: hires.length,
    },
    sourceEffectiveness: sourceRows.map((r) => ({
      ...r,
      candidates: r.applications,
    })),
    metrics: hires.map((a) => ({
      hireDate: a.offer?.respondedAt ?? null,
      role: a.jobRequisition.title,
      department: a.jobRequisition.departmentId,
    })),
    canonicalMetrics: isRecruitmentFlagEnabled("analytics")
      ? canonical
      : { version: null, unavailable: true, reason: "flag-disabled" },
  };
}
export async function computeRecruitmentAnalytics(
  tenantId,
  filters = {},
  options = {},
) {
  return report(await snapshot(tenantId, filters, options.method ?? "GET"));
}
/** Trusted job entry point; public reporting still requires a verified human actor. */
export async function computeRecruitmentAnalyticsForScheduler(
  tenantId,
  filters = {},
) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  return runWithRequestContext(
    { system: false, recruitmentAutomation: true, user: { tenantId } },
    async () => report(await snapshot(tenantId, filters, "GET", true)),
  );
}
export const DRILLDOWN_METRICS = Object.freeze([
  "failedHandoffs",
  "offerDeclineRate",
  "totalHires",
  "timeToFillDays",
  "timeToFirstFillDays",
  "timeToHireDays",
  "timeToStartDays",
  "confirmedTimeToStartDays",
  "stageConversion",
  "dropOff",
  "offerAcceptanceRate",
  "sourceEffectiveness",
  "funnel",
  "costPerHire",
  "recruiterWorkload",
  "slaAging",
]);
export async function drillDownRecruitmentMetric(
  tenantId,
  metric,
  filters = {},
  { limit = 100 } = {},
) {
  if (
    !DRILLDOWN_METRICS.includes(metric) &&
    !/^(funnel|source|disposition|stage):.+$/.test(metric ?? "")
  )
    fail(
      "Unsupported drill-down metric",
      400,
      "HR-RECRUITMENT-ANALYTICS-DRILLDOWN-INVALID",
    );
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    fail("Limit must be between 1 and 500");
  const s = await snapshot(tenantId, filters),
    e = evidence(s);
  let rows = e.applications,
    unit = "application";
  const colon = metric.indexOf(":"),
    group = colon < 0 ? null : metric.slice(0, colon),
    value = colon < 0 ? null : metric.slice(colon + 1);
  if (metric === "totalHires") rows = rows.filter((a) => a.stage === "hired");
  else if (metric === "timeToHireDays")
    rows = rows.filter((a) => a.timeToHireDays != null);
  else if (metric === "confirmedTimeToStartDays")
    rows = rows.filter((a) => a.confirmedTimeToStartDays != null);
  else if (metric === "timeToStartDays")
    rows = rows.filter((a) => a.timeToStartDays != null);
  else if (metric === "timeToFillDays" || metric === "timeToFirstFillDays") {
    rows = e.requisitions;
    unit = "requisition";
  } else if (metric === "offerAcceptanceRate")
    rows = rows.filter((a) =>
      ["ACCEPTED", "DECLINED", "EXPIRED", "SENT"].includes(a.offerStatus),
    );
  else if (metric === "failedHandoffs")
    rows = rows.filter((a) => a.handoffStatus === "FAILED");
  else if (metric === "offerDeclineRate")
    rows = rows.filter((a) =>
      ["ACCEPTED", "DECLINED", "EXPIRED"].includes(a.offerStatus),
    );
  else if (metric === "slaAging") rows = rows.filter((a) => a.sla?.breached);
  else if (metric === "recruiterWorkload") {
    rows = e.workload;
    unit = "recruiter";
  } else if (metric === "costPerHire") {
    rows = [
      {
        ...costPayload(s).costPerHire,
        applicationIds: rows
          .filter((a) => a.stage === "hired")
          .map((a) => a.applicationId),
      },
    ];
    unit = "cost";
  } else if (group === "source") rows = rows.filter((a) => a.source === value);
  else if (group === "disposition")
    rows = rows.filter((a) => a.dispositionReasonCode === value);
  else if (group === "funnel")
    rows = rows.filter((a) =>
      a.funnel.some((f) => f.stage === value && f.entered),
    );
  else if (group === "stage") rows = rows.filter((a) => a.stage === value);
  return {
    metric,
    basis: metric,
    filters: s.filters,
    generatedAt: s.generatedAt,
    unit,
    total: rows.length,
    returned: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    rows: rows.slice(0, limit),
  };
}
