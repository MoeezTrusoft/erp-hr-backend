// src/services/payrollRuleConfig.service.js
//
// Payroll Setup → Pay Rules. One PayrollRuleConfig row per tenant holds the six
// policy toggles + the garnishment cap. Reads fold the verified tenant via
// scopedWhere(tenantId, where); the multi-step upsert runs inside a
// tenantTransaction so the FORCE-RLS tenant GUC is set for both the read and the
// create/update (PayrollRuleConfig is an RLS model — see src/lib/rlsTenant.js).
import prisma from "../lib/prisma.js";
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
  // HR-PAYROLL-EOBI-01. Off for every tenant until someone deliberately turns
  // it on; see the rate/ceiling validation below.
  "eobiEnabled",
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
    // HR-PAYROLL-EOBI-01 — disabled by default. The rate and ceiling are the
    // figures the original hardcoded comment named, not ones confirmed against
    // a filed return, so they only take effect once a tenant opts in.
    eobiEnabled: false,
    eobiEmployeeRatePct: 1,
    eobiWageCeilingMinor: 1700000,
    status: "DRAFT",
    version: 1,
  };
}

export async function getPayrollRules({ tenantId }) {
  const row = await prisma.payrollRuleConfig.findUnique({ where: { tenantId } });
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

  // HR-PAYROLL-EOBI-01 — both guard a statutory deduction, so a typo here comes
  // out of somebody's pay. A 0 ceiling would silently charge nothing, which is
  // indistinguishable from the rule being off, so it is rejected as a mistake.
  if (toggles.eobiEmployeeRatePct !== undefined) {
    const pct = Number(toggles.eobiEmployeeRatePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw badRequest("eobiEmployeeRatePct must be a number between 0 and 100");
    }
    data.eobiEmployeeRatePct = pct;
  }
  if (toggles.eobiWageCeilingMinor !== undefined) {
    const ceiling = Number(toggles.eobiWageCeilingMinor);
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      throw badRequest("eobiWageCeilingMinor must be a whole number of minor units greater than 0");
    }
    data.eobiWageCeilingMinor = ceiling;
  }

  const row = await tenantTransaction(prisma, async (tx) => {
    return tx.payrollRuleConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data, status: "DRAFT", version: 1 },
      update: { ...data, status: "DRAFT", version: { increment: 1 } },
    });
  });

  logger.info({ id: row.id }, "payroll rules updated");
  return row;
}
