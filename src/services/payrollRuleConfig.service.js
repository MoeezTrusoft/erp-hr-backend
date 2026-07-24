// src/services/payrollRuleConfig.service.js
//
// Payroll Setup → Pay Rules. One PayrollRuleConfig row per tenant holds the six
// policy toggles + the garnishment cap. Reads fold the verified tenant via
// scopedWhere(tenantId, where); the multi-step upsert runs inside a
// tenantTransaction so the FORCE-RLS tenant GUC is set for both the read and the
// create/update (PayrollRuleConfig is an RLS model — see src/lib/rlsTenant.js).
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// The six boolean policy toggles editable on the Pay Rules screen.
const BOOL_KEYS = [
  "midMonthJoinerProration",
  "midMonthExitSettlement",
  "lwpRecovery",
  "complianceHold",
  "garnishmentRecovery",
  "offCycleRelease",
];

// A DRAFT default row (id:null) when the tenant has no PayrollRuleConfig yet.
function defaultRules() {
  return {
    id: null,
    midMonthJoinerProration: true,
    midMonthExitSettlement: true,
    lwpRecovery: true,
    complianceHold: true,
    garnishmentRecovery: true,
    garnishmentCapPct: 33,
    offCycleRelease: true,
    status: "DRAFT",
    version: 1,
  };
}

export async function getPayrollRules({ tenantId }) {
  const row = await prisma.payrollRuleConfig.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: [{ id: "asc" }],
  });
  return row ?? defaultRules();
}

export async function updatePayrollRules({ tenantId, ...toggles }) {
  // Build the change-set from ONLY the provided keys.
  const data = {};
  for (const key of BOOL_KEYS) {
    if (toggles[key] !== undefined) data[key] = Boolean(toggles[key]);
  }
  if (toggles.garnishmentCapPct !== undefined) {
    const pct = Number(toggles.garnishmentCapPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw badRequest("garnishmentCapPct must be a number between 0 and 100");
    }
    data.garnishmentCapPct = pct;
  }

  const row = await tenantTransaction(prisma, async (tx) => {
    const existing = await tx.payrollRuleConfig.findFirst({
      where: scopedWhere(tenantId, {}),
      orderBy: [{ id: "asc" }],
    });

    // Editing the config always returns it to DRAFT and bumps the version.
    if (!existing) {
      return tx.payrollRuleConfig.create({
        data: { ...data, status: "DRAFT", version: 1 },
      });
    }
    return tx.payrollRuleConfig.update({
      where: { id: existing.id },
      data: { ...data, status: "DRAFT", version: (existing.version ?? 1) + 1 },
    });
  });

  logger.info({ id: row.id }, "payroll rules updated");
  return row;
}
