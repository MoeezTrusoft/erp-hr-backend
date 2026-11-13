// src/lib/tenancy.js — shared tenant-scoping helpers for erp-hr-backend.
//
// C.2 / T-P2.2 / T-P2.6 — the payroll (C4) surface (HR-04) was tenant-scoped by
// folding the VERIFIED tenant into every where-clause via a local `withTenant`.
// C.2 extends the same pattern to the REMAINING tenant-bearing HR tables
// (leave / attendance / performance / training / recruitment / onboarding /
// offboarding / …). The helper is promoted here and shared; payrollService
// re-imports it.
//
// TENANT PROVENANCE (T-P2.1 / X-02): the tenant is the RBAC Company.uuid string
// (REQ-007). It arrives ONLY on req.user.tenantId, set by internalServiceGuard
// from the VERIFIED service-JWT claim — NEVER from the spoofable x-tenant-id
// header. Controllers thread that value into the service call as `tenantId`.
//
// Interactive requests require a UUID tenant at the F-06 HTTP/ORM boundaries.
// The null behavior below is retained only for explicit legacy migration and
// backfill callers while nullable columns are reconciled.
//
//   * The verified tenant ALWAYS wins over any tenantId that leaked into the
//     caller's predicate / create-data — a forged tenantId can never override
//     the value resolved from the signed claim.

/**
 * Fold the verified tenant into a Prisma where-clause.
 * @param {string|null|undefined} tenantId  verified RBAC Company.uuid
 * @param {object} [where]                   caller predicate
 * @returns {object} where-clause with the tenant scope applied
 */
export const withTenant = (tenantId, where = {}) => ({
    ...where,
    tenantId: tenantId ?? null,
});

/**
 * Fail-closed assertion for paths that MUST run inside a tenant (sensitive
 * writes / cross-tenant-risky reads). Throws when no tenant is present so a
 * missing tenant is a hard error, never a silent span across tenants.
 * @param {string|null|undefined} tenantId
 * @returns {string} the tenantId (when valid)
 */
export const requireTenant = (tenantId) => {
    if (tenantId === null || tenantId === undefined || tenantId === '') {
        const err = new Error('Tenant context is required (fail-closed)');
        err.code = 'HR-TENANT-REQUIRED';
        err.statusCode = 400;
        throw err;
    }
    return tenantId;
};

/**
 * Stamp the tenant onto create data. Null is reserved for explicit legacy
 * migration/backfill callers; interactive traffic is rejected before this.
 * @param {string|null|undefined} tenantId
 * @param {object} [data]
 * @returns {object} data with tenantId applied
 */
export const tenantData = (tenantId, data = {}) => ({
    ...data,
    tenantId: tenantId ?? null,
});

/**
 * C.2 — backward-compatible scoping for the REMAINING HR services.
 *
 * Many existing service signatures (and their tests/legacy callers) call the
 * read/write helpers WITHOUT a tenant. To thread the verified tenant into those
 * services without breaking the legacy path, `tenantId === undefined` means
 * "no tenant scoping requested" and the predicate is returned untouched. A
 * PRESENT value (including `null`) applies `withTenant`; null is migration-only.
 *
 * This is the single shared definition of the leave/payroll `scopedWhere`
 * shim so every newly-threaded service folds the tenant the SAME way.
 * @param {string|null|undefined} tenantId
 * @param {object} [where]
 * @returns {object}
 */
export const scopedWhere = (tenantId, where = {}) =>
    tenantId === undefined ? where : withTenant(tenantId, where);

/**
 * C.2 — backward-compatible create-stamp counterpart to scopedWhere. When no
 * tenant is requested (`undefined`) the data is returned untouched (legacy);
 * a present value (including null) stamps the tenant (migration-only for null).
 * @param {string|null|undefined} tenantId
 * @param {object} [data]
 * @returns {object}
 */
export const scopedData = (tenantId, data = {}) =>
    tenantId === undefined ? data : tenantData(tenantId, data);

/**
 * C.2 — the Employee table carries the tenant under the snake_case column
 * `tenant_id` (REQ-007), NOT the camelCase `tenantId` the C.2 tables use. Use
 * this when scoping an Employee where-clause so the predicate names the real
 * column. Same back-compat contract as scopedWhere (`undefined` = no scope).
 * @param {string|null|undefined} tenantId
 * @param {object} [where]
 * @returns {object}
 */
export const scopedEmployeeWhere = (tenantId, where = {}) =>
    tenantId === undefined ? where : { ...where, tenant_id: tenantId ?? null };
