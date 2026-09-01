// src/services/attendanceDeductionRule.service.js
//
// Payroll Setup → Attendance Deductions. One row per (tenant, ruleKey):
// "N occurrences in a period cost X days of salary".
//
// Every rule ships DISABLED and stays that way until a dry run has been read.
// The reason is concrete: 460 of 1628 August shifts were single-scan, so turning
// MISSING_CHECKOUT on at N=1/X=0.5 would deduct ~230 days across 64 people in a
// single month for what is a device artefact, not absenteeism.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// MISSING_CHECKIN and MISSING_CHECKOUT are separate keys on purpose. A missing
// check-out is routine on this hardware; a missing check-in is rare and more
// serious. One shared counter would let the noisy one consume the threshold and
// mask the real signal.
export const DEDUCTION_RULE_KEYS = [
  "DISAPPROVED_LEAVE",
  "LATE",
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "EARLY_CHECKOUT",
];

const PERIOD_SCOPES = ["PAY_PERIOD", "MONTH"];

function defaultRule(ruleKey) {
  return {
    id: null,
    ruleKey,
    enabled: false,
    // triggerCount 1 = per occurrence, which is how DISAPPROVED_LEAVE is used.
    triggerCount: 1,
    deductionDays: 0.5,
    periodScope: "PAY_PERIOD",
    maxDeductionDaysPerPeriod: null,
    status: "DRAFT",
    version: 1,
  };
}

/** All five rules, falling back to an unsaved default for any not yet configured. */
export async function listDeductionRules({ tenantId }) {
  const rows = await prisma.attendanceDeductionRule.findMany({
    where: { tenantId },
    orderBy: { ruleKey: "asc" },
  });
  const byKey = new Map(rows.map((r) => [r.ruleKey, r]));
  return DEDUCTION_RULE_KEYS.map((key) => byKey.get(key) ?? defaultRule(key));
}

export async function upsertDeductionRule({ tenantId, ruleKey, ...input }) {
  if (!DEDUCTION_RULE_KEYS.includes(ruleKey)) {
    throw badRequest(`ruleKey must be one of: ${DEDUCTION_RULE_KEYS.join(", ")}`);
  }

  const data = {};

  if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);

  if (input.triggerCount !== undefined) {
    const n = Number(input.triggerCount);
    if (!Number.isInteger(n) || n < 1) throw badRequest("triggerCount must be a whole number >= 1");
    data.triggerCount = n;
  }

  if (input.deductionDays !== undefined) {
    const n = Number(input.deductionDays);
    // Fractional days are the point (0.5 = half day). Cap at 31 so a typo cannot
    // wipe out a month's salary in one rule.
    if (!Number.isFinite(n) || n < 0 || n > 31) {
      throw badRequest("deductionDays must be a number between 0 and 31");
    }
    data.deductionDays = n;
  }

  if (input.periodScope !== undefined) {
    const scope = String(input.periodScope).trim().toUpperCase();
    if (!PERIOD_SCOPES.includes(scope)) {
      throw badRequest(`periodScope must be one of: ${PERIOD_SCOPES.join(", ")}`);
    }
    data.periodScope = scope;
  }

  if (input.maxDeductionDaysPerPeriod !== undefined) {
    if (input.maxDeductionDaysPerPeriod === null) {
      data.maxDeductionDaysPerPeriod = null;
    } else {
      const n = Number(input.maxDeductionDaysPerPeriod);
      if (!Number.isFinite(n) || n < 0 || n > 31) {
        throw badRequest("maxDeductionDaysPerPeriod must be null or a number between 0 and 31");
      }
      data.maxDeductionDaysPerPeriod = n;
    }
  }

  const row = await tenantTransaction(prisma, async (tx) => {
    return tx.attendanceDeductionRule.upsert({
      where: { tenantId_ruleKey: { tenantId, ruleKey } },
      create: { tenantId, ruleKey, ...data, status: "DRAFT", version: 1 },
      update: { ...data, status: "DRAFT", version: { increment: 1 } },
    });
  });

  logger.info({ id: row.id, ruleKey, enabled: row.enabled }, "attendance deduction rule updated");
  return row;
}
