// src/services/recruitmentAnalytics.service.js
//
// Recruitment Analytics — tenant-scoped computation of hiring KPIs from the
// recruitment tables (Application / Candidate / Offer / Interview /
// JobRequisition / OfferHandoff / InternalReferral / RecruitmentCostConfig).
//
// Phase 5 — NO ILLUSTRATIVE DATA. Every figure in the answer comes from the
// tenant's own rows. A metric with nothing to measure answers null and names
// why in `reasons` (or in its own `reason`), never a placeholder number: cost
// per hire is null without a cost configuration (the old fixed PKR sample
// breakdown is gone), offer acceptance is null when no offer was extended,
// time to hire counts only hires with an accepted offer, and an unconfigured
// SLA reports breached: null rather than 0.
//
// Phase 5 additions to the canonical block (definitions in
// src/lib/recruitmentMetrics.js, each at definition version 1; no v1
// definition changed): timeToStart, recruiterWorkload and costPerHire, each
// also reachable through the drill-down with the same filters.
//
// The dataset is tiny (~24 applications/tenant), so we fetch the applications
// once with the relations we need and compute in JS to avoid N+1 round-trips.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { getCostConfig } from "./recruitmentCost.service.js";
// Phase 12 / decision record §6 — the FROZEN, versioned KPI definitions. The
// service only assembles inputs; the definitions live in the lib.
import {
  aggregateTimeToFill,
  aggregateTimeToHire,
  aggregateTimeToStart,
  costPerHire as costPerHireMetric,
  metricsVersionBlock,
  NULL_REASONS,
  offerAcceptance,
  recruiterWorkload,
  slaAging,
  // Aliased: the legacy block below has a local `sourceEffectiveness` array
  // that used to shadow this function, so the canonical block always threw
  // and reported unavailable.
  sourceEffectiveness as sourceEffectivenessMetric,
  stageFunnel,
  timeInStageForApplication,
  timeToFillForRequisition,
  timeToHireForApplication,
  timeToStartForHire,
} from "../lib/recruitmentMetrics.js";

const log = logger.child({ component: "recruitment-analytics" });

// Stage constants (Application.stage is stored lower-case per schema).
const STAGE_HIRED = "hired";
const SCREENED_STAGES = new Set(["screening", "interview", "offer", "hired"]);

// Offer statuses that count as "extended" (an offer that was sent at least once
// and reached a terminal / in-flight outcome). WITHDRAWN/DRAFT are excluded.
const EXTENDED_OFFER_STATUSES = new Set(["SENT", "ACCEPTED", "DECLINED", "EXPIRED"]);

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Recruiter workload counts interviews inside the requested window, or the
// last 30 days when the caller gave none.
export const DEFAULT_WORKLOAD_PERIOD_DAYS = 30;

// The only cost configuration period the cost tool writes (recruitmentCost.service).
const COST_PERIOD = "all";

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Compute the full recruitment-analytics payload for a tenant.
 * @param {string|null} tenantId RBAC Company.uuid (verbatim; null => no rows).
 * @returns {Promise<object>} analytics object (see hr_recruitment_analytics_get).
 */
/**
 * FR-11 residue — DRILL-DOWN FILTERS + DATE RANGES on the canonical block.
 *
 * Additive (§6.3 discipline): `computeRecruitmentAnalytics(tenantId)` keeps its
 * exact all-time behaviour; the new optional second argument narrows BOTH the
 * legacy payload and the canonical block through the same fetch, so the two
 * can never disagree about the window. Filters are ANDed:
 *
 *   - `dateFrom` / `dateTo`  — applications whose appliedAt (or the
 *     requisition's createdAt when the application edge is absent) falls in the
 *     window; inclusive, ISO strings or Dates.
 *   - `requisitionIds`       — restrict to specific requisitions.
 *   - `departmentId`         — the requisition's department (RBAC Company space).
 *   - `stage`                — the application's CURRENT stage.
 *   - `source`               — the candidate's source string.
 *
 * Unknown keys are refused rather than silently ignored: a filter that does
 * nothing is worse than an error, because the caller believes the numbers are
 * narrower than they are.
 *
 * @param {string|null} tenantId
 * @param {{dateFrom?: string|Date, dateTo?: string|Date, requisitionIds?: number[],
 *          departmentId?: number, stage?: string, source?: string}} [filters]
 * @returns {Promise<object>} the same payload shape, narrowed
 */
// ── NFR-12 reporting integrity — the SHARED filter/loader seam ─────────────
//
// The requirement's sharpest line is "allow drill-down to the data behind
// metrics". A drill-down that re-derives its own row set is not evidence: it can
// silently disagree with the number it is supposed to explain. So the filter
// normalization and the fetch/filter pipeline live here ONCE and both the
// metric payload and the drill-down consume them.

const ANALYTICS_FILTER_KEYS = Object.freeze(["dateFrom", "dateTo", "requisitionIds", "departmentId", "stage", "source"]);

const badFilter = (message) =>
  Object.assign(new Error(message), { status: 400, code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" });

/** Validate + normalize a filter object (unknown keys are REFUSED, never ignored). */
export function normalizeAnalyticsFilters(filters = {}) {
  const unknown = Object.keys(filters || {}).filter((k) => !ANALYTICS_FILTER_KEYS.includes(k));
  if (unknown.length > 0) throw badFilter(`Unsupported analytics filter(s): ${unknown.join(", ")}`);

  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (filters?.dateFrom && Number.isNaN(dateFrom.getTime())) throw badFilter("dateFrom is not a valid date");
  if (filters?.dateTo && Number.isNaN(dateTo.getTime())) throw badFilter("dateTo is not a valid date");
  if (dateFrom && dateTo && dateFrom > dateTo) throw badFilter("dateFrom must not be after dateTo");

  const requisitionIds = Array.isArray(filters?.requisitionIds)
    ? filters.requisitionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : null;
  const departmentId = filters?.departmentId != null && Number.isInteger(Number(filters.departmentId)) ? Number(filters.departmentId) : null;
  const stage = typeof filters?.stage === "string" && filters.stage.trim() ? filters.stage.trim().toLowerCase() : null;
  const source = typeof filters?.source === "string" && filters.source.trim() ? filters.source.trim() : null;

  return {
    dateFrom,
    dateTo,
    requisitionIds,
    departmentId,
    stage,
    source,
    hasDateFilter: Boolean(dateFrom || dateTo),
    hasRowFilter: Boolean(requisitionIds?.length || departmentId || stage || source),
  };
}

/** The one fetch + JS filter both consumers use. */
// Every analytics read is tenant-scoped. `tenantId ?? undefined` used to drop
// the predicate entirely when no tenant was passed, reading every tenant.
const requireAnalyticsTenant = (tenantId) => {
  if (!tenantId) throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
};

export async function loadFilteredApplications(tenantId, n = {}) {
  requireAnalyticsTenant(tenantId);
  const {
    dateFrom, dateTo, requisitionIds, departmentId, stage, source, hasDateFilter, hasRowFilter,
  } = n;
  // Single fetch with the relations we need; compute everything in JS.
  const applications = await prisma.application.findMany({
    where: { tenantId },
    select: {
      id: true,
      stage: true,
      appliedAt: true,
      updatedAt: true,
      candidate: { select: { id: true, source: true } },
      // D-15 — `id` is what the requisitionIds filter and the drill-down read.
      jobRequisition: { select: { id: true, title: true, departmentId: true } },
      interviews: { select: { id: true } },
      // Phase 5 — startDate and the handoff feed Time to Start.
      offer: {
        select: {
          id: true,
          status: true,
          respondedAt: true,
          sentAt: true,
          startDate: true,
          handoff: { select: { status: true, employeeId: true } },
        },
      },
    },
  });

  // FR-11 — filter in JS (additive; unfiltered callers take the exact legacy
  // path). Requisitions carrying ZERO applications still matter to time-to-fill,
  // so when a requisition-level filter (ids/department) is active the
  // requisition fetch below is narrowed by the SAME predicates instead.
  let filteredApplications = applications;
  if (hasRowFilter) {
    filteredApplications = filteredApplications.filter((a) => {
      const req = a.jobRequisition;
      if (requisitionIds?.length && !requisitionIds.includes(req?.id)) return false;
      if (departmentId != null && req?.departmentId !== departmentId) return false;
      if (stage && a.stage !== stage) return false;
      if (source && (a.candidate?.source ?? "Unknown") !== source) return false;
      return true;
    });
  }
  if (hasDateFilter) {
    filteredApplications = filteredApplications.filter((a) => {
      const at = a.appliedAt ? new Date(a.appliedAt) : null;
      if (dateFrom && (!at || at < dateFrom)) return false;
      if (dateTo && (!at || at > dateTo)) return false;
      return true;
    });
  }
  return filteredApplications;
}

/**
 * NFR-12 — the metric vocabulary a drill-down may name. Canonical keys are the
 * frozen §6 names; the prefixed forms address one bucket of a grouped metric
 * (`funnel:<stage>`, `source:<name>`, `disposition:<code>`) so an operator can
 * drill into the exact slice a chart drew.
 */
export const DRILLDOWN_METRICS = Object.freeze([
  "totalHires",
  "timeToFillDays",
  "timeToFirstFillDays",
  "timeToHireDays",
  "stageConversion",
  "dropOff",
  "offerAcceptanceRate",
  "sourceEffectiveness",
  "funnel",
  // Phase 5
  "timeToStartDays",
  "recruiterWorkload",
  "costPerHire",
]);

const isKnownMetric = (metric) =>
  DRILLDOWN_METRICS.includes(metric) ||
  /^(funnel|source|disposition|stage):.+$/.test(String(metric || ""));

/**
 * NFR-12 — the row-level evidence behind a metric.
 *
 * Runs the IDENTICAL filter + fetch pipeline as `computeRecruitmentAnalytics`
 * and returns the applications the named metric was computed over, with the
 * facts that metric used. Tenant-scoped by the same `where` (and the RLS policy
 * beneath it), so an export or a drill-down can never widen a caller's view.
 *
 * @returns {Promise<{metric: string, filters: object, total: number,
 *   returned: number, truncated: boolean, rows: object[]}>}
 */
export async function drillDownRecruitmentMetric(tenantId, metric, filters = {}, { limit = 100, now = new Date() } = {}) {
  const key = String(metric || "").trim();
  if (!key || !isKnownMetric(key)) {
    throw Object.assign(
      new Error(`Unsupported drill-down metric: ${key || "(missing)"} (expected one of ${DRILLDOWN_METRICS.join(", ")} or <group>:<value>)`),
      { status: 400, code: "HR-RECRUITMENT-ANALYTICS-DRILLDOWN-INVALID" },
    );
  }

  const normalized = normalizeAnalyticsFilters(filters);
  const applications = await loadFilteredApplications(tenantId, normalized);

  const [group, value] = key.includes(":") ? key.split(/:(.+)/) : [null, null];
  let selected = applications;
  let basis = key;
  const page = (unit, rows, extra = {}) => ({
    metric: key,
    basis,
    filters: serializeFilters(normalized),
    unit,
    ...extra,
    total: rows.length,
    returned: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    rows: rows.slice(0, limit),
  });

  // Phase 5 — the three added metrics answer with the rows their number used,
  // computed by the same helpers the payload calls.
  if (key === "timeToStartDays") {
    const { rows } = await timeToStartFor(tenantId, applications, now);
    return page("hire", rows);
  }
  if (key === "recruiterWorkload") {
    const workload = await loadRecruiterWorkload(tenantId, normalized, now);
    return page("recruiter", workload.recruiters, { period: workload.period });
  }
  if (key === "costPerHire") {
    const hired = applications.filter((a) => a.stage === STAGE_HIRED);
    const cost = await loadCostPerHire(tenantId, normalized, hired.length);
    const rows = cost.value === null && cost.reason === NULL_REASONS.COST_NOT_ATTRIBUTABLE_TO_FILTER
      ? []
      : hired.map((a) => ({
        applicationId: a.id,
        candidateId: a.candidate?.id ?? null,
        requisitionId: a.jobRequisition?.id ?? null,
        requisitionTitle: a.jobRequisition?.title ?? null,
      }));
    return page("hire", rows, {
      value: cost.value,
      reason: cost.reason,
      components: {
        costConfigId: cost.costConfigId ?? null,
        period: cost.period ?? null,
        currency: cost.currency ?? null,
        breakdown: cost.breakdown ?? null,
        referralBonuses: cost.referralBonuses ?? [],
      },
    });
  }

  if (key === "totalHires" || key === "timeToHireDays") {
    selected = applications.filter((a) => a.stage === STAGE_HIRED);
  } else if (group === "funnel" && value) {
    selected = applications.filter((a) => a.stage === value);
  } else if (key === "sourceEffectiveness" || group === "source") {
    const wanted = group === "source" ? value : null;
    selected = applications.filter((a) => (a.candidate?.source ?? "Unknown") === wanted || wanted === null && true);
  } else if (group === "stage" && value) {
    selected = applications.filter((a) => a.stage === value);
  } else if (group === "disposition") {
    // Dispositions live on the screening records; the application ids they carry
    // are the evidence, so this bucket is resolved through the screening table.
    const screenings = await prisma.applicationScreening.findMany({
      where: { tenantId, ...(value ? { reasonCode: value } : {}) },
      select: { applicationId: true, outcome: true, reasonCode: true },
    });
    const ids = new Set(screenings.map((s) => s.applicationId));
    selected = applications.filter((a) => ids.has(a.id));
    basis = `disposition:${value ?? "(any)"}`;
  } else if (key === "offerAcceptanceRate") {
    // F-35 — the evidence for the canonical rate is the offers that reached a
    // final outcome (ACCEPTED, DECLINED, EXPIRED), plus the SENT offers the
    // rate reports as pending. Withdrawn and draft offers are not in the rate,
    // so they are not in its evidence either.
    const counted = new Set(["ACCEPTED", "DECLINED", "EXPIRED", "SENT"]);
    const rows = applications
      .filter((a) => a.offer && counted.has(a.offer.status))
      .map((a) => ({
        offerId: a.offer.id ?? null,
        applicationId: a.id,
        candidateId: a.candidate?.id ?? null,
        requisitionId: a.jobRequisition?.id ?? null,
        requisitionTitle: a.jobRequisition?.title ?? null,
        status: a.offer.status,
        outcome: a.offer.status === "SENT" ? "pending" : "final",
        respondedAt: a.offer.respondedAt ?? null,
      }));
    return {
      metric: key,
      basis,
      filters: serializeFilters(normalized),
      unit: "offer",
      total: rows.length,
      returned: Math.min(rows.length, limit),
      truncated: rows.length > limit,
      rows: rows.slice(0, limit),
    };
  } else if (key === "timeToFillDays" || key === "timeToFirstFillDays" || key === "stageConversion" || key === "dropOff") {
    // Requisition- and offer-shaped metrics: the drill-down answers with the
    // requisitions (the aggregate's unit), each carrying its own applications.
    const byRequisition = new Map();
    for (const a of applications) {
      const id = a.jobRequisition?.id ?? null;
      if (id == null) continue;
      if (!byRequisition.has(id)) byRequisition.set(id, { requisitionId: id, title: a.jobRequisition?.title ?? null, applicationIds: [] });
      byRequisition.get(id).applicationIds.push(a.id);
    }
    const rows = [...byRequisition.values()];
    return {
      metric: key,
      basis,
      filters: serializeFilters(normalized),
      unit: "requisition",
      total: rows.length,
      returned: Math.min(rows.length, limit),
      truncated: rows.length > limit,
      rows: rows.slice(0, limit),
    };
  }

  const rows = selected.map((a) => ({
    applicationId: a.id,
    stage: a.stage,
    appliedAt: a.appliedAt,
    candidateId: a.candidate?.id ?? null,
    source: a.candidate?.source ?? "Unknown",
    requisitionId: a.jobRequisition?.id ?? null,
    requisitionTitle: a.jobRequisition?.title ?? null,
    interviewCount: a.interviews?.length ?? 0,
    offerStatus: a.offer?.status ?? null,
    offerRespondedAt: a.offer?.respondedAt ?? null,
  }));

  return {
    metric: key,
    basis,
    filters: serializeFilters(normalized),
    unit: "application",
    total: rows.length,
    returned: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    rows: rows.slice(0, limit),
  };
}

/** The filter echo an operator can compare against what they asked for. */
const serializeFilters = (n) => ({
  ...(n.dateFrom ? { dateFrom: n.dateFrom.toISOString() } : {}),
  ...(n.dateTo ? { dateTo: n.dateTo.toISOString() } : {}),
  ...(n.requisitionIds?.length ? { requisitionIds: n.requisitionIds } : {}),
  ...(n.departmentId != null ? { departmentId: n.departmentId } : {}),
  ...(n.stage ? { stage: n.stage } : {}),
  ...(n.source ? { source: n.source } : {}),
});

/**
 * Phase 5 — the hire's start dates. A handoff that adopted an existing employee
 * leaves that person's older hire date in place; timeToStartForHire ignores a
 * start before the acceptance, so only this hire's start counts.
 */
async function loadEmployeeStartDates(tenantId, employeeIds) {
  const ids = [...new Set(employeeIds.filter((id) => Number.isInteger(id)))];
  if (!ids.length) return new Map();
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
    select: { id: true, hire_date: true, joining_date: true },
  });
  return new Map(employees.map((e) => [e.id, e.hire_date ?? e.joining_date ?? null]));
}

/**
 * Phase 5 — Time to Start rows over the given (already filtered) applications:
 * one per ACCEPTED offer whose handoff COMPLETED. Accepted offers still waiting
 * for their handoff are counted, not measured.
 */
async function timeToStartFor(tenantId, applications, now) {
  const accepted = applications.filter((a) => a.offer?.status === "ACCEPTED" && a.offer?.respondedAt);
  const handedOff = accepted.filter((a) => a.offer.handoff?.status === "COMPLETED");
  const starts = await loadEmployeeStartDates(tenantId, handedOff.map((a) => a.offer.handoff.employeeId));
  const rows = handedOff.map((a) => {
    const measured = timeToStartForHire(
      {
        acceptedAt: a.offer.respondedAt,
        employeeStartAt: starts.get(a.offer.handoff.employeeId) ?? null,
        offerStartAt: a.offer.startDate ?? null,
      },
      now,
    );
    return {
      applicationId: a.id,
      offerId: a.offer.id ?? null,
      requisitionId: a.jobRequisition?.id ?? null,
      employeeId: a.offer.handoff.employeeId ?? null,
      acceptedAt: a.offer.respondedAt,
      ...measured,
    };
  });
  return { rows, awaitingHandoff: accepted.length - handedOff.length };
}

/**
 * Phase 5 — recruiter workload. The requisition-level filters (ids,
 * department) narrow the requisitions; stage and source narrow the
 * applications counted; the date window is the period interviews are counted
 * in (default: the last 30 days). Open requisitions and active applications
 * are as of now.
 */
export async function loadRecruiterWorkload(tenantId, n = {}, now = new Date()) {
  requireAnalyticsTenant(tenantId);
  const to = n.dateTo ?? new Date(now);
  const from = n.dateFrom ?? new Date(new Date(to).getTime() - DEFAULT_WORKLOAD_PERIOD_DAYS * MS_PER_DAY);
  const where = { tenantId };
  if (n.requisitionIds?.length) where.id = { in: n.requisitionIds };
  if (n.departmentId != null) where.departmentId = n.departmentId;
  const requisitions = await prisma.jobRequisition.findMany({
    where,
    select: {
      id: true,
      status: true,
      recruiterId: true,
      applications: {
        select: {
          id: true,
          stage: true,
          candidate: { select: { source: true } },
          interviews: { select: { id: true, scheduledAt: true, status: true } },
        },
      },
    },
  });
  const narrowed = requisitions.map((r) => ({
    ...r,
    applications: (r.applications ?? []).filter((a) => {
      if (n.stage && a.stage !== n.stage) return false;
      if (n.source && (a.candidate?.source ?? "Unknown") !== n.source) return false;
      return true;
    }),
  }));
  return {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    recruiters: recruiterWorkload(narrowed, { from, to }),
  };
}

/**
 * Phase 5 — cost per hire from actual spend. Costs are recorded per tenant for
 * the configuration's whole period, so they cannot be attributed to a filtered
 * slice: with any filter the answer is null with that reason rather than an
 * all-time cost divided by a narrowed hire count.
 */
export async function loadCostPerHire(tenantId, n = {}, hires = 0) {
  requireAnalyticsTenant(tenantId);
  if (n.hasDateFilter || n.hasRowFilter) {
    return {
      value: null,
      reason: NULL_REASONS.COST_NOT_ATTRIBUTABLE_TO_FILTER,
      currency: null,
      totalCost: null,
      hires,
      period: null,
      breakdown: null,
      referralBonuses: [],
    };
  }
  const config = await getCostConfig(tenantId, COST_PERIOD);
  const paid = config
    ? await prisma.internalReferral.findMany({
      where: { tenantId, bonusStatus: "PAID" },
      select: { id: true, applicationId: true, bonusAmount: true, bonusCurrency: true },
      orderBy: { id: "asc" },
    })
    : [];
  const referralBonuses = paid.map((r) => ({
    referralId: r.id,
    applicationId: r.applicationId ?? null,
    amount: r.bonusAmount == null ? 0 : Number(String(r.bonusAmount)),
    currency: r.bonusCurrency ?? null,
  }));
  const result = costPerHireMetric({ config, paidReferralBonuses: referralBonuses, hires });
  return { ...result, costConfigId: config?.id ?? null, referralBonuses };
}

export async function computeRecruitmentAnalytics(tenantId, filters = {}, { now = new Date() } = {}) {
  // FR-11 + NFR-12 — ONE normalizer and ONE loader for the payload AND the
  // drill-down, so a reported number and the rows behind it can never come from
  // two slightly different queries.
  const normalized = normalizeAnalyticsFilters(filters);
  const {
    dateFrom, dateTo, requisitionIds, departmentId, stage, source, hasDateFilter, hasRowFilter,
  } = normalized;

  const filteredApplications = await loadFilteredApplications(tenantId, normalized);

  // FR-11 — every downstream computation reads the FILTERED set; the variable
  // name stays `applications` so the legacy code body is untouched.
  const hiredApps = filteredApplications.filter((a) => a.stage === STAGE_HIRED);
  const totalHires = hiredApps.length;

  // Why a top-level figure is null (Phase 5: never a placeholder instead).
  const reasons = {};

  // ── timeToHireDays ──────────────────────────────────────────────────────
  // Average (offer.respondedAt - appliedAt) in days over hires with an
  // ACCEPTED offer. Phase 5: a hire without one used to borrow the
  // application's updatedAt as its hire date; that is not a hire date, so such
  // hires are left out (and with none left the figure is null).
  const measuredHires = hiredApps.filter((a) => a.offer?.status === "ACCEPTED" && a.offer?.respondedAt && a.appliedAt);
  let timeToHireDays = null;
  if (measuredHires.length > 0) {
    const totalDays = measuredHires.reduce(
      (sum, a) => sum + (new Date(a.offer.respondedAt).getTime() - new Date(a.appliedAt).getTime()) / MS_PER_DAY,
      0,
    );
    timeToHireDays = round1(totalDays / measuredHires.length);
  } else {
    reasons.timeToHireDays = totalHires > 0 ? NULL_REASONS.NO_ACCEPTED_OFFERS : NULL_REASONS.NO_HIRES;
  }

  // ── offerAcceptanceRatePct ──────────────────────────────────────────────
  // ACCEPTED / (SENT + ACCEPTED + DECLINED + EXPIRED) * 100, rounded.
  let accepted = 0;
  let extended = 0;
  for (const a of filteredApplications) {
    const status = a.offer?.status;
    if (!status) continue;
    if (EXTENDED_OFFER_STATUSES.has(status)) extended += 1;
    if (status === "ACCEPTED") accepted += 1;
  }
  // Phase 5: no offer extended is "no data", not a 0% acceptance rate.
  const offerAcceptanceRatePct = extended > 0 ? Math.round((accepted / extended) * 100) : null;
  if (offerAcceptanceRatePct === null) reasons.offerAcceptanceRatePct = NULL_REASONS.NO_OFFERS_EXTENDED;

  // ── cost per hire: actual spend only (Phase 5; no illustrative fallback) ──
  const cost = await loadCostPerHire(tenantId, normalized, totalHires);
  const costPerHire = {
    value: cost.value,
    totalCost: cost.totalCost,
    currency: cost.currency,
    hires: cost.hires,
    period: cost.period,
    reason: cost.reason,
  };
  if (cost.value === null) reasons.costPerHire = cost.reason;

  // ── hiringFunnel ────────────────────────────────────────────────────────
  const hiringFunnel = {
    applied: filteredApplications.length,
    screened: filteredApplications.filter((a) => SCREENED_STAGES.has(a.stage)).length,
    interviewed: filteredApplications.filter((a) => (a.interviews?.length ?? 0) >= 1).length,
    offered: filteredApplications.filter((a) => a.offer != null).length,
    hired: totalHires,
  };

  // ── sourceEffectiveness ─────────────────────────────────────────────────
  // Group candidates (that have applications) by Candidate.source. A candidate
  // is counted once per source; hires count that candidate's hired applications.
  const bySource = new Map();
  const seenCandidatesBySource = new Map();
  for (const a of filteredApplications) {
    const source = a.candidate?.source ?? "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, { source, candidates: 0, hires: 0 });
      seenCandidatesBySource.set(source, new Set());
    }
    const entry = bySource.get(source);
    const seen = seenCandidatesBySource.get(source);
    const candId = a.candidate?.id;
    if (candId != null && !seen.has(candId)) {
      seen.add(candId);
      entry.candidates += 1;
    }
    if (a.stage === STAGE_HIRED) entry.hires += 1;
  }
  const sourceEffectiveness = [...bySource.values()].sort((x, y) => y.candidates - x.candidates);

  // ── costBreakdown: the actual components, or null with the same reason ──
  const costBreakdown = cost.breakdown ? { ...cost.breakdown, currency: cost.currency } : null;
  if (!costBreakdown) reasons.costBreakdown = cost.reason;

  // ── metrics (per hired application) ─────────────────────────────────────
  // The hire date is the accepted offer's response; a hire without one has no
  // recorded hire date (null), not the row's last-touched time.
  const metrics = hiredApps.map((a) => {
    const accepted = a.offer?.status === "ACCEPTED" && a.offer?.respondedAt;
    return {
      hireDate: accepted ? a.offer.respondedAt : null,
      role: a.jobRequisition?.title ?? null,
      department: a.jobRequisition?.departmentId ?? null,
    };
  });

  // ── Phase 12 / §6 — the canonical, versioned metrics block ─────────────
  // ADDITIVE (§6.3): every legacy field above stays exactly where it was; the
  // frozen definitions arrive as a sibling `canonicalMetrics` object so no
  // consumer breaks. Sources: requisition_transitions (final approval),
  // accepted offers (fills), application_stage_history (time-in-stage),
  // offers (acceptance), candidates.source, screening dispositions
  // (drop-off classification). SLAs come from configuration when set;
  // absent SLAs report null, never a guess.
  // Phase 15 — the block is also flag-gated (HR_RECRUITMENT_CANONICAL_ANALYTICS):
  // off reports as unavailable rather than disappearing, so consumers keep the
  // same payload shape during a staged rollout.
  let canonical = null;
  if (!isRecruitmentFlagEnabled("analytics")) canonical = { version: null, unavailable: true, reason: "flag-disabled", reasonCode: NULL_REASONS.FLAG_DISABLED };
  else try {
    // FR-11 — the canonical requisition fetch is narrowed by the SAME row-level
    // predicates (ids/department) so time-to-fill per requisition agrees with
    // the application-level numbers above; date/stage/source filtering happens
    // per application below, matching the legacy block's semantics.
    const requisitionWhere = { tenantId };
    if (requisitionIds?.length) requisitionWhere.id = { in: requisitionIds };
    if (departmentId != null) requisitionWhere.departmentId = departmentId;
    const requisitions = await prisma.jobRequisition.findMany({
      where: requisitionWhere,
      select: {
        id: true,
        openings: true,
        transitions: { select: { fromStatus: true, toStatus: true, createdAt: true } },
        applications: {
          select: {
            id: true,
            stage: true,
            appliedAt: true,
            candidate: { select: { source: true } },
            offer: { select: { status: true, respondedAt: true } },
            stageHistory: { select: { fromStage: true, toStage: true, createdAt: true } },
            screenings: { select: { outcome: true, reasonCode: true, reviewedAt: true } },
          },
        },
      },
    });

    const perRequisition = requisitions.map((r) =>
      timeToFillForRequisition(
        r.transitions,
        r.applications.map((a) => a.offer ?? { status: null, respondedAt: null }),
        r.openings,
      ),
    );
    const tthPerApp = filteredApplications.map((a) => timeToHireForApplication(a));

    // The latest REJECT/HOLD disposition code per application classifies its
    // drop-off; ADVANCE rows never classify (§6 row 7 + §4.2).
    const dispositionByApp = new Map();
    for (const r of requisitions) {
      for (const a of r.applications) {
        const coded = (a.screenings ?? [])
          .filter((s) => s.outcome !== "ADVANCE" && s.reasonCode)
          .sort((x, y) => new Date(y.reviewedAt) - new Date(x.reviewedAt))[0];
        if (coded) dispositionByApp.set(a.id, coded.reasonCode);
      }
    }

    const allApplications = requisitions.flatMap((r) => r.applications).filter((a) => {
      if (stage && a.stage !== stage) return false;
      if (source && (a.candidate?.source ?? "Unknown") !== source) return false;
      if (dateFrom && (!a.appliedAt || new Date(a.appliedAt) < dateFrom)) return false;
      if (dateTo && (!a.appliedAt || new Date(a.appliedAt) > dateTo)) return false;
      return true;
    });
    const funnel = stageFunnel(
      allApplications.map((a) => ({
        applicationId: a.id,
        currentStage: a.stage,
        appliedAt: a.appliedAt,
        history: a.stageHistory,
        dispositionReasonCode: dispositionByApp.get(a.id) ?? null,
      })),
    );

    const offerRows = allApplications.map((a) => a.offer).filter(Boolean);

    const slaByStage = getStageSlaConfig();
    const slaConfigured = Object.keys(slaByStage).length > 0;
    const slaRows = allApplications
      .map((a) => {
        const durations = timeInStageForApplication(a.stageHistory, a.stage, a.appliedAt);
        const current = durations.find((d) => d.isCurrent);
        return current ? slaAging(current.stage, current.daysInStage, slaByStage) : null;
      })
      .filter(Boolean);

    // Phase 5 — over the SAME filtered applications the drill-down reads.
    const startRows = await timeToStartFor(tenantId, filteredApplications, now);
    const workload = await loadRecruiterWorkload(tenantId, normalized, now);

    canonical = {
      ...metricsVersionBlock(),
      timeToFill: {
        ...aggregateTimeToFill(perRequisition),
        perRequisition: perRequisition.map((r, i) => ({
          requisitionId: requisitions[i].id,
          openings: r.openings,
          filled: r.filled,
          startAt: r.startAt,
          overallFillAt: r.overallFillAt,
          timeToFillDays: r.timeToFillDays,
          timeToFirstFillDays: r.timeToFirstFillDays,
          perOpeningFillDates: r.perOpeningFillDates,
        })),
      },
      timeToHire: aggregateTimeToHire(tthPerApp),
      stageFunnel: funnel,
      offerAcceptance: offerAcceptance(offerRows),
      sourceEffectiveness: sourceEffectivenessMetric(
        allApplications.map((a) => ({
          source: a.candidate?.source ?? null,
          applicationId: a.id,
          enteredInterview:
            (a.stageHistory ?? []).some((h) => h.toStage === "interview") ||
            a.stage === "interview" ||
            ["offer", "hired"].includes(a.stage),
          isHire: a.stage === "hired",
          timeToHireDays: timeToHireForApplication(a),
        })),
      ),
      slaAging: {
        configured: slaConfigured,
        openApplications: slaRows.length,
        // Phase 5: with no SLA configured nothing can breach it; that is
        // "not measured" (null), not zero breaches.
        breached: slaConfigured ? slaRows.filter((s) => s.breached).length : null,
        ...(slaConfigured ? {} : { reason: NULL_REASONS.SLA_NOT_CONFIGURED }),
        byStage: slaRows.reduce((acc, s) => {
          acc[s.stage] ??= { open: 0, breached: 0, worstAgingDays: null };
          acc[s.stage].open += 1;
          if (s.breached) acc[s.stage].breached += 1;
          if (s.agingDays !== null && (acc[s.stage].worstAgingDays === null || s.agingDays > acc[s.stage].worstAgingDays)) {
            acc[s.stage].worstAgingDays = s.agingDays;
          }
          return acc;
        }, {}),
      },
      // Phase 5 additions (definition version 1 each).
      timeToStart: { ...aggregateTimeToStart(startRows.rows), awaitingHandoff: startRows.awaitingHandoff },
      recruiterWorkload: workload,
      costPerHire: {
        value: cost.value,
        reason: cost.reason,
        currency: cost.currency,
        totalCost: cost.totalCost,
        hires: cost.hires,
        period: cost.period,
        breakdown: cost.breakdown,
        referralBonusesCount: cost.referralBonuses?.length ?? 0,
      },
    };
    if (canonical.timeToStart.startsMeasured === 0) canonical.timeToStart.reason = NULL_REASONS.NO_STARTS;
  } catch (err) {
    // §6.3 — the canonical block is additive: a failure computing it must not
    // take the legacy payload down. It reports as unavailable, not as zeros.
    log.error({ tenantId, code: err?.code, errMessage: err?.message }, "canonical recruitment metrics failed");
    canonical = { version: null, unavailable: true, reasonCode: NULL_REASONS.COMPUTATION_FAILED };
  }

  return {
    totalHires,
    timeToHireDays,
    offerAcceptanceRatePct,
    costPerHire,
    hiringFunnel,
    sourceEffectiveness,
    costBreakdown,
    metrics,
    canonicalMetrics: canonical,
    reasons,
  };
}

/**
 * §6 row 5 — SLA days per stage, from configuration (HR_RECRUITMENT_STAGE_SLA_DAYS).
 * Exported for the Phase 5 SLA-breach alert, which must read the same SLA.
 */
export function getStageSlaConfig() {
  const raw = process.env.HR_RECRUITMENT_STAGE_SLA_DAYS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
