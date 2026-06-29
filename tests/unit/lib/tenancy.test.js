// C.2 / T-P2.2 / T-P2.6 — shared HR tenancy helper.
//
// The payroll surface (HR-04) folded the verified tenant into every where-clause
// with a LOCAL `withTenant`. C.2 extends tenant scoping to the REMAINING
// tenant-bearing HR tables (leave/attendance/performance/training/recruitment/…)
// the SAME way, so the helper is promoted to src/lib/tenancy.js and shared.
//
// Contract:
//   withTenant(tenantId, where?)  → folds `tenantId` into the where-clause,
//        fail-closed: a null/undefined tenant matches ONLY null-tenant rows
//        (legacy/unbackfilled), never another tenant's data.
//   requireTenant(tenantId)       → fail-closed assertion: a write/sensitive
//        path that MUST run inside a tenant throws when none is present, so a
//        missing tenant can never silently span tenants.
//   tenantData(tenantId, data?)   → stamps tenantId onto a create's data.
import { describe, it, expect } from '@jest/globals';
import { withTenant, requireTenant, tenantData } from '../../../src/lib/tenancy.js';

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

describe('withTenant', () => {
    it('folds the tenantId into an empty where-clause', () => {
        expect(withTenant(TENANT_A)).toEqual({ tenantId: TENANT_A });
    });

    it('preserves the caller predicate and adds the tenant scope', () => {
        expect(withTenant(TENANT_A, { id: 7, status: 'active' })).toEqual({
            id: 7,
            status: 'active',
            tenantId: TENANT_A,
        });
    });

    it('is fail-closed: a null tenant scopes to null-tenant rows only', () => {
        expect(withTenant(null, { id: 1 })).toEqual({ id: 1, tenantId: null });
        expect(withTenant(undefined, { id: 1 })).toEqual({ id: 1, tenantId: null });
    });

    it('never lets a caller-supplied tenantId override the verified one', () => {
        // Even if a stray tenantId leaks into the predicate, the verified tenant wins.
        expect(withTenant(TENANT_A, { tenantId: TENANT_B }).tenantId).toBe(TENANT_A);
    });

    it('keeps distinct tenants isolated', () => {
        expect(withTenant(TENANT_A).tenantId).not.toBe(withTenant(TENANT_B).tenantId);
    });
});

describe('requireTenant', () => {
    it('returns the tenant when present', () => {
        expect(requireTenant(TENANT_A)).toBe(TENANT_A);
    });

    it('throws fail-closed when the tenant is missing (null/undefined/empty)', () => {
        expect(() => requireTenant(null)).toThrow(/tenant/i);
        expect(() => requireTenant(undefined)).toThrow(/tenant/i);
        expect(() => requireTenant('')).toThrow(/tenant/i);
    });
});

describe('tenantData', () => {
    it('stamps the tenantId onto create data', () => {
        expect(tenantData(TENANT_A, { name: 'x' })).toEqual({ name: 'x', tenantId: TENANT_A });
    });

    it('fail-closed stamps null for a missing tenant (never another tenant)', () => {
        expect(tenantData(null, { name: 'x' })).toEqual({ name: 'x', tenantId: null });
    });

    it('the verified tenant overrides any tenantId already in data', () => {
        expect(tenantData(TENANT_A, { tenantId: TENANT_B }).tenantId).toBe(TENANT_A);
    });
});
