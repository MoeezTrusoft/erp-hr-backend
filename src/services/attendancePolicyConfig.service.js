// src/services/attendancePolicyConfig.service.js
//
// Payroll Setup → Attendance Policy. One AttendancePolicyConfig row per tenant
// holds the thresholds the attendance evaluator reads. Mirrors
// payrollRuleConfig.service.js: reads go straight through the RLS extension,
// the upsert runs inside tenantTransaction so the FORCE-RLS tenant GUC is set
// for both the read and the create/update.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// Minutes-valued knobs: whole numbers, never negative.
const MINUTE_KEYS = [
  "graceMinutes",
  "halfDayAfterMinutes",
  "earlyLeaveGraceMin",
  "checkoutLeniencyMin",
  "overtimeAfterMinutes",
  "duplicatePunchWindowMin",
];

// Percent-of-rostered-shift bands. Deliberately NOT absolute hours: this fleet
// runs 3h shifts (EMG 15:30-18:30) alongside 12h ones (Homenet 22:00-10:00), so
// a fixed "<4h = absent" rule would mark whole teams absent every day.
const PERCENT_KEYS = ["fullDayMinPercent", "halfDayMinPercent"];

const BOOL_KEYS = ["overtimeNeedsApproval"];

// Service-level fallback for a tenant with no row yet. id:null marks it as
// unsaved so the UI can tell "never configured" from "configured to defaults".
export function defaultAttendancePolicy() {
  return {
    id: null,
    graceMinutes: 0,
    halfDayAfterMinutes: 30,
    earlyLeaveGraceMin: 0,
    checkoutLeniencyMin: 240,
    overtimeAfterMinutes: 45,
    overtimeNeedsApproval: true,
    fullDayMinPercent: 90,
    halfDayMinPercent: 50,
    duplicatePunchWindowMin: 5,
    shiftGapHours: 11,
    defaultShiftStart: "09:00",
    status: "DRAFT",
    version: 1,
  };
}

export async function getAttendancePolicy({ tenantId }) {
  const row = await prisma.attendancePolicyConfig.findUnique({ where: { tenantId } });
  return row ?? defaultAttendancePolicy();
}

export async function updateAttendancePolicy({ tenantId, ...input }) {
  const data = {};

  for (const key of MINUTE_KEYS) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < 0) throw badRequest(`${key} must be a whole number >= 0`);
    data[key] = n;
  }

  for (const key of PERCENT_KEYS) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw badRequest(`${key} must be a number between 0 and 100`);
    }
    data[key] = n;
  }

  for (const key of BOOL_KEYS) {
    if (input[key] !== undefined) data[key] = Boolean(input[key]);
  }

  if (input.shiftGapHours !== undefined) {
    const n = Number(input.shiftGapHours);
    // Below 2h the gap would split a single shift on a meal break; above 23h a
    // whole day collapses into one session.
    if (!Number.isInteger(n) || n < 2 || n > 23) {
      throw badRequest("shiftGapHours must be a whole number between 2 and 23");
    }
    data.shiftGapHours = n;
  }

  if (input.defaultShiftStart !== undefined) {
    const raw = String(input.defaultShiftStart).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
      throw badRequest("defaultShiftStart must be HH:MM (24-hour)");
    }
    data.defaultShiftStart = raw;
  }

  // Cross-field: a half day can never require more of the shift than a full day.
  // Validate against the effective row, not just the payload, so changing one
  // side alone cannot produce an inverted pair.
  const current = await getAttendancePolicy({ tenantId });
  const full = data.fullDayMinPercent ?? current.fullDayMinPercent;
  const half = data.halfDayMinPercent ?? current.halfDayMinPercent;
  if (half > full) {
    throw badRequest("halfDayMinPercent must be <= fullDayMinPercent");
  }

  const row = await tenantTransaction(prisma, async (tx) => {
    return tx.attendancePolicyConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data, status: "DRAFT", version: 1 },
      update: { ...data, status: "DRAFT", version: { increment: 1 } },
    });
  });

  logger.info({ id: row.id }, "attendance policy updated");
  return row;
}
