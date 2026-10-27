// src/lib/employee-names.util.js
//
// Recruitment Phase 7: screens that list referrals, recruiters, alert
// recipients, approvers and authors showed bare employee ids. This is the one
// way every recruitment read turns those ids into display names, so the same
// person reads the same on every screen.
//
// Rules:
//   * one query per read, never one per row (ids are collected, de-duplicated
//     and fetched together);
//   * the caller's tenant only: an id from another tenant, or an id that no
//     longer resolves, reads as null (the screen keeps its id fallback);
//   * only the display name leaves this module: no email, phone or code.
//
// The caller passes its own client (a transaction or the singleton prisma), so
// the lookup runs under the caller's RLS context (src/lib may not import
// src/services).
import { scopedEmployeeWhere } from "./tenancy.js";

const MAX_IDS = 500;

/** The display name for an Employee row: "First Last", else employee_name. */
export function employeeDisplayName(employee) {
    if (!employee) return null;
    const first = String(employee.first_name ?? "").trim();
    const last = String(employee.last_name ?? "").trim();
    const joined = [first, last].filter(Boolean).join(" ");
    if (joined) return joined;
    const fallback = String(employee.employee_name ?? "").trim();
    return fallback || null;
}

/** Positive integer ids from any mix of numbers, numeric strings and blanks. */
export function collectEmployeeIds(values) {
    const ids = new Set();
    for (const value of values ?? []) {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    return [...ids].slice(0, MAX_IDS);
}

/**
 * Map<employeeId, displayName> for the given ids under the tenant.
 * @param {object} db  a Prisma client or transaction
 * @param {string} tenantId
 * @param {Iterable<number|string|null|undefined>} values
 * @returns {Promise<Map<number, string>>}
 */
export async function employeeNamesById(db, tenantId, values) {
    const ids = collectEmployeeIds(values);
    const names = new Map();
    if (!ids.length || !tenantId) return names;
    const rows = await db.employee.findMany({
        where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
        select: { id: true, first_name: true, last_name: true, employee_name: true },
    });
    for (const row of rows) {
        const name = employeeDisplayName(row);
        if (name) names.set(row.id, name);
    }
    return names;
}

/** The name for one id from a map built by employeeNamesById (null if unknown). */
export const nameOf = (names, value) => {
    const id = Number(value);
    return Number.isInteger(id) ? (names.get(id) ?? null) : null;
};
