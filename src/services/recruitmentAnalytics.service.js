// src/services/recruitmentAnalytics.service.js
//
// Recruitment Analytics — tenant-scoped computation of hiring KPIs from the
// recruitment tables (Application / Candidate / Offer / Interview /
// JobRequisition). The DB carries NO cost data, so every cost figure exposed
// here is derived from clearly-labelled ILLUSTRATIVE constants (see
// ILLUSTRATIVE_COST_BREAKDOWN) — the object is stamped `illustrativeCostData:
// true` and each cost sub-object carries `costModel: "illustrative"` so no
// consumer mistakes them for real spend. All real metrics (hires, funnel,
// time-to-hire, offer-acceptance, source effectiveness) are computed from live
// rows.
//
// The dataset is tiny (~24 applications/tenant), so we fetch the applications
// once with the relations we need and compute in JS to avoid N+1 round-trips.
import prisma from "../lib/prisma.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { getCostConfig } from "./recruitmentCost.service.js";
// Phase 12 / decision record §6 — the FROZEN, versioned KPI definitions. The
// service only assembles inputs; the definitions live in the lib.
import {
  aggregateTimeToFill,
  aggregateTimeToHire,
  finalApprovalAt,
  metricsVersionBlock,
  offerAcceptance,
  slaAging,
  sourceEffectiveness,
  stageFunnel,
  timeInStageForApplication,
  timeToFillForRequisition,
  timeToHireForApplication,
} from "../lib/recruitmentMetrics.js";

// Stage constants (Application.stage is stored lower-case per schema).
const STAGE_HIRED = "hired";
const SCREENED_STAGES = new Set(["screening", "interview", "offer", "hired"]);

// Offer statuses that count as "extended" (an offer that was sent at least once
// and reached a terminal / in-flight outcome). WITHDRAWN/DRAFT are excluded.
const EXTENDED_OFFER_STATUSES = new Set(["SENT", "ACCEPTED", "DECLINED", "EXPIRED"]);

// ── ILLUSTRATIVE cost model ───────────────────────────────────────────────
// NOT sourced from the DB. Fixed PKR constants used only to demonstrate the
// cost-per-hire shape. Do not treat as real spend.
export const ILLUSTRATIVE_COST_BREAKDOWN = Object.freeze({
  jobAds: 50000,
  agencyFees: 120000,
  tools: 30000,
  other: 20000,
});

const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
export async function computeRecruitmentAnalytics(tenantId, filters = {}) {
  const ALLOWED_FILTER_KEYS = new Set(["dateFrom", "dateTo", "requisitionIds", "departmentId", "stage", "source"]);
  const unknown = Object.keys(filters || {}).filter((k) => !ALLOWED_FILTER_KEYS.has(k));
  if (unknown.length > 0) {
    throw Object.assign(
      new Error(`Unsupported analytics filter(s): ${unknown.join(", ")}`),
      { status: 400, code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" },
    );
  }

  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (filters?.dateFrom && Number.isNaN(dateFrom.getTime())) {
    throw Object.assign(new Error("dateFrom is not a valid date"), { status: 400, code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" });
  }
  if (filters?.dateTo && Number.isNaN(dateTo.getTime())) {
    throw Object.assign(new Error("dateTo is not a valid date"), { status: 400, code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" });
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw Object.assign(new Error("dateFrom must not be after dateTo"), { status: 400, code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" });
  }

  const requisitionIds = Array.isArray(filters?.requisitionIds)
    ? filters.requisitionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : null;
  const departmentId = filters?.departmentId != null && Number.isInteger(Number(filters.departmentId)) ? Number(filters.departmentId) : null;
  const stage = typeof filters?.stage === "string" && filters.stage.trim() ? filters.stage.trim().toLowerCase() : null;
  const source = typeof filters?.source === "string" && filters.source.trim() ? filters.source.trim() : null;

  const hasDateFilter = Boolean(dateFrom || dateTo);
  const hasRowFilter = Boolean(requisitionIds?.length || departmentId || stage || source);

  // Single fetch with the relations we need; compute everything in JS.
  const applications = await prisma.application.findMany({
    where: { tenantId: tenantId ?? undefined },
    select: {
      id: true,
      stage: true,
      appliedAt: true,
      updatedAt: true,
      candidate: { select: { id: true, source: true } },
      jobRequisition: { select: { title: true, departmentId: true } },
      interviews: { select: { id: true } },
      offer: { select: { status: true, respondedAt: true, sentAt: true } },
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

  // FR-11 — every downstream computation reads the FILTERED set; the variable
  // name stays `applications` so the legacy code body is untouched.
  const hiredApps = filteredApplications.filter((a) => a.stage === STAGE_HIRED);
  const totalHires = hiredApps.length;

  // ── timeToHireDays ──────────────────────────────────────────────────────
  // hireDate = offer.respondedAt when the offer was ACCEPTED, else the
  // application's updatedAt. Average (hireDate - appliedAt) in days over hires.
  let timeToHireDays = null;
  if (totalHires > 0) {
    const totalDays = hiredApps.reduce((sum, a) => {
      const accepted = a.offer?.status === "ACCEPTED" && a.offer?.respondedAt;
      const hireDate = accepted ? a.offer.respondedAt : a.updatedAt;
      return sum + (new Date(hireDate).getTime() - new Date(a.appliedAt).getTime()) / MS_PER_DAY;
    }, 0);
    timeToHireDays = round1(totalDays / totalHires);
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
  const offerAcceptanceRatePct = extended > 0 ? Math.round((accepted / extended) * 100) : 0;

  // ── cost model: real (from RecruitmentCostConfig) if configured, else illustrative ──
  const costCfg = await getCostConfig(tenantId, "all");
  const costModel = costCfg ? "actual" : "illustrative";
  const costCurrency = costCfg?.currency ?? "PKR";
  const costParts = costCfg
    ? { jobAds: costCfg.jobAds, agencyFees: costCfg.agencyFees, tools: costCfg.tools, other: costCfg.other }
    : { ...ILLUSTRATIVE_COST_BREAKDOWN };
  const totalCost = Object.values(costParts).reduce((s, v) => s + v, 0);
  const costPerHire = {
    value: totalHires > 0 ? Math.round(totalCost / totalHires) : null,
    totalCost,
    currency: costCurrency,
    costModel,
  };

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

  // ── costBreakdown (real if configured, else illustrative) ───────────────
  const costBreakdown = {
    ...costParts,
    currency: costCurrency,
    costModel,
  };

  // ── metrics (per hired application) ─────────────────────────────────────
  const metrics = hiredApps.map((a) => {
    const accepted = a.offer?.status === "ACCEPTED" && a.offer?.respondedAt;
    const hireDate = accepted ? a.offer.respondedAt : a.updatedAt;
    return {
      hireDate,
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
  if (!isRecruitmentFlagEnabled("analytics")) canonical = { version: null, unavailable: true, reason: "flag-disabled" };
  else try {
    // FR-11 — the canonical requisition fetch is narrowed by the SAME row-level
    // predicates (ids/department) so time-to-fill per requisition agrees with
    // the application-level numbers above; date/stage/source filtering happens
    // per application below, matching the legacy block's semantics.
    const requisitionWhere = { tenantId: tenantId ?? undefined };
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

    const slaByStage = getSlaConfig();
    const slaRows = allApplications
      .map((a) => {
        const durations = timeInStageForApplication(a.stageHistory, a.stage, a.appliedAt);
        const current = durations.find((d) => d.isCurrent);
        return current ? slaAging(current.stage, current.daysInStage, slaByStage) : null;
      })
      .filter(Boolean);

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
      sourceEffectiveness: sourceEffectiveness(
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
        configured: Object.keys(slaByStage).length > 0,
        openApplications: slaRows.length,
        breached: slaRows.filter((s) => s.breached).length,
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
    };
  } catch {
    // §6.3 — the canonical block is additive: a failure computing it must not
    // take the legacy payload down. It reports as unavailable, not as zeros.
    canonical = { version: null, unavailable: true };
  }

  return {
    illustrativeCostData: costModel === "illustrative",
    totalHires,
    timeToHireDays,
    offerAcceptanceRatePct,
    costPerHire,
    hiringFunnel,
    sourceEffectiveness,
    costBreakdown,
    metrics,
    canonicalMetrics: canonical,
  };
}

/** §6 row 5 — SLA days per stage, from configuration (HR_RECRUITMENT_STAGE_SLA_DAYS). */
function getSlaConfig() {
  const raw = process.env.HR_RECRUITMENT_STAGE_SLA_DAYS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
