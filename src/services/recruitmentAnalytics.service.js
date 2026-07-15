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
export async function computeRecruitmentAnalytics(tenantId) {
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

  const hiredApps = applications.filter((a) => a.stage === STAGE_HIRED);
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
  for (const a of applications) {
    const status = a.offer?.status;
    if (!status) continue;
    if (EXTENDED_OFFER_STATUSES.has(status)) extended += 1;
    if (status === "ACCEPTED") accepted += 1;
  }
  const offerAcceptanceRatePct = extended > 0 ? Math.round((accepted / extended) * 100) : 0;

  // ── costPerHire (ILLUSTRATIVE) ──────────────────────────────────────────
  const totalCost = Object.values(ILLUSTRATIVE_COST_BREAKDOWN).reduce((s, v) => s + v, 0);
  const costPerHire = {
    value: totalHires > 0 ? Math.round(totalCost / totalHires) : null,
    totalCost,
    currency: "PKR",
    costModel: "illustrative",
  };

  // ── hiringFunnel ────────────────────────────────────────────────────────
  const hiringFunnel = {
    applied: applications.length,
    screened: applications.filter((a) => SCREENED_STAGES.has(a.stage)).length,
    interviewed: applications.filter((a) => (a.interviews?.length ?? 0) >= 1).length,
    offered: applications.filter((a) => a.offer != null).length,
    hired: totalHires,
  };

  // ── sourceEffectiveness ─────────────────────────────────────────────────
  // Group candidates (that have applications) by Candidate.source. A candidate
  // is counted once per source; hires count that candidate's hired applications.
  const bySource = new Map();
  const seenCandidatesBySource = new Map();
  for (const a of applications) {
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

  // ── costBreakdown (ILLUSTRATIVE) ────────────────────────────────────────
  const costBreakdown = {
    ...ILLUSTRATIVE_COST_BREAKDOWN,
    currency: "PKR",
    costModel: "illustrative",
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

  return {
    illustrativeCostData: true,
    totalHires,
    timeToHireDays,
    offerAcceptanceRatePct,
    costPerHire,
    hiringFunnel,
    sourceEffectiveness,
    costBreakdown,
    metrics,
  };
}
