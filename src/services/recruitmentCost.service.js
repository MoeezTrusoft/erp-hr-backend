// src/services/recruitmentCost.service.js — per-tenant recruitment cost config
// backing real cost-per-hire in analytics. Tenant-scoped, one row per period.
import prisma from "../lib/prisma.js";

const PERIOD = "all";

export async function getCostConfig(tenantId, period = PERIOD) {
  return prisma.recruitmentCostConfig.findFirst({ where: { tenantId: tenantId ?? null, period } });
}

export async function setCostConfig(tenantId, { period = PERIOD, jobAds, agencyFees, tools, other, currency } = {}) {
  const existing = await getCostConfig(tenantId, period);
  const data = {
    jobAds: jobAds != null ? Math.round(Number(jobAds)) : existing?.jobAds ?? 0,
    agencyFees: agencyFees != null ? Math.round(Number(agencyFees)) : existing?.agencyFees ?? 0,
    tools: tools != null ? Math.round(Number(tools)) : existing?.tools ?? 0,
    other: other != null ? Math.round(Number(other)) : existing?.other ?? 0,
    currency: currency ?? existing?.currency ?? "PKR",
  };
  if (existing) {
    return prisma.recruitmentCostConfig.update({ where: { id: existing.id }, data });
  }
  return prisma.recruitmentCostConfig.create({ data: { tenantId: tenantId ?? null, period, ...data } });
}
