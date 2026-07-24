// src/services/payrollCalendar.service.js — Payroll Setup › Cycle & Calendar.
//
// The PayrollCalendar model is a SINGLETON per tenant (one row): the payroll
// cycle configuration — pay frequency, period start/end anchors, attendance
// cutoff, approvals-close, and the pay-date rule. Any edit re-drafts the config
// (status → DRAFT) and bumps the version so a published cycle is never mutated
// silently.
//
// Tenant scoping is fail-closed via scopedWhere/scopedData (../lib/tenancy.js);
// the write goes through tenantTransaction so it passes FORCE-RLS. pino only.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";

// Schema-level defaults, surfaced as the shape returned before a tenant has
// saved a calendar (id:null ⇒ "not yet persisted").
const DEFAULT_CALENDAR = {
    id: null,
    payFrequency: "MONTHLY",
    periodStartAnchor: "FIRST_OF_MONTH",
    periodStartDate: null,
    periodEndAnchor: "LAST_OF_MONTH",
    periodEndDate: null,
    attendanceCutoff: null,
    approvalsClose: null,
    payDateAnchor: "LAST_OF_MONTH",
    payDate: null,
    payDateWeekendShift: true,
    status: "DRAFT",
    version: 0,
};

const EDITABLE_FIELDS = [
    "payFrequency",
    "periodStartAnchor",
    "periodStartDate",
    "periodEndAnchor",
    "periodEndDate",
    "attendanceCutoff",
    "approvalsClose",
    "payDateAnchor",
    "payDate",
    "payDateWeekendShift",
];

const DATE_FIELDS = new Set([
    "periodStartDate",
    "periodEndDate",
    "attendanceCutoff",
    "approvalsClose",
    "payDate",
]);

function coerceField(key, value) {
    if (value === null || value === undefined) return null;
    if (DATE_FIELDS.has(key)) {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
            throw Object.assign(new Error(`${key} must be a valid date`), { status: 400 });
        }
        return d;
    }
    if (key === "payDateWeekendShift") return Boolean(value);
    return value;
}

export async function getCalendar({ tenantId } = {}) {
    const row = await prisma.payrollCalendar.findFirst({ where: scopedWhere(tenantId, {}) });
    return row || { ...DEFAULT_CALENDAR };
}

export async function upsertCalendar({ tenantId, ...fields } = {}) {
    // Build the patch from only the editable fields the caller actually sent.
    const data = {};
    for (const key of EDITABLE_FIELDS) {
        if (fields[key] !== undefined) data[key] = coerceField(key, fields[key]);
    }
    // Any edit re-drafts the config.
    data.status = "DRAFT";

    return tenantTransaction(prisma, async (tx) => {
        const existing = await tx.payrollCalendar.findFirst({ where: scopedWhere(tenantId, {}) });
        if (existing) {
            const updated = await tx.payrollCalendar.update({
                where: { id: existing.id },
                data: { ...data, version: (existing.version || 0) + 1 },
            });
            logger.info({ id: updated.id, tenantId, version: updated.version }, "payroll calendar updated");
            return updated;
        }
        const created = await tx.payrollCalendar.create({
            data: scopedData(tenantId, { ...data, version: 1 }),
        });
        logger.info({ id: created.id, tenantId }, "payroll calendar created");
        return created;
    });
}

// Last day of a given (1-based) month, respecting leap years.
function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * resolvePayDate — compute the effective pay date for a month.
 *
 * Anchor rules (payDateAnchor):
 *   LAST_OF_MONTH  → the last calendar day of the month.
 *   FIRST_OF_MONTH → the 1st of the month.
 *   FIXED_DATE     → the day-of-month taken from the configured payDate
 *                    (clamped to the month's length, so a "31" in February
 *                    lands on the last valid day).
 *
 * WEEKEND-SHIFT rule (payDateWeekendShift, default true): if the anchored day
 * falls on a Saturday or Sunday, the pay date is pulled EARLIER to the nearest
 * preceding Friday (Sat → -1 day, Sun → -2 days). Pulling earlier (never later)
 * guarantees employees are never paid AFTER the scheduled date. When the flag is
 * off, the anchored day is returned as-is.
 *
 * Returns an ISO date string (YYYY-MM-DD).
 */
export function resolvePayDate({ tenantId, year, month, calendar } = {}) {
    // calendar may be injected (tests / batch); otherwise fall back to defaults.
    const cfg = calendar || DEFAULT_CALENDAR;
    const y = Number(year);
    const m = Number(month); // 1-based
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
        throw Object.assign(new Error("year and month (1-12) are required"), { status: 400 });
    }

    let day;
    switch (cfg.payDateAnchor) {
        case "FIRST_OF_MONTH":
            day = 1;
            break;
        case "FIXED_DATE": {
            const configured = cfg.payDate ? new Date(cfg.payDate).getUTCDate() : 1;
            day = Math.min(configured, lastDayOfMonth(y, m));
            break;
        }
        case "LAST_OF_MONTH":
        default:
            day = lastDayOfMonth(y, m);
            break;
    }

    let date = new Date(Date.UTC(y, m - 1, day));

    if (cfg.payDateWeekendShift) {
        const dow = date.getUTCDay(); // 0=Sun … 6=Sat
        if (dow === 6) date = new Date(date.getTime() - 1 * 86400000); // Sat → Fri
        else if (dow === 0) date = new Date(date.getTime() - 2 * 86400000); // Sun → Fri
    }

    return date.toISOString().slice(0, 10);
}

/**
 * isAttendanceLocked — is attendance editing locked for this tenant right now?
 *
 * Returns true when the calendar's attendanceCutoff is set AND the given
 * instant `at` (default: now) is at or past the cutoff. The FE / shift & OT
 * edit paths call this to block changes once the cutoff has passed. When no
 * cutoff is configured the window is never locked (returns false).
 */
export async function isAttendanceLocked({ tenantId, at } = {}) {
    const row = await prisma.payrollCalendar.findFirst({ where: scopedWhere(tenantId, {}) });
    if (!row || !row.attendanceCutoff) return false;
    const now = at ? new Date(at) : new Date();
    if (Number.isNaN(now.getTime())) return false;
    return now.getTime() >= new Date(row.attendanceCutoff).getTime();
}
