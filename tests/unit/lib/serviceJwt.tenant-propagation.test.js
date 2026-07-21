// Service-to-service tenant propagation — the outbound half of the tenancy
// fence. Proves HR's service-token signers embed the caller's VERIFIED tenant
// (from the ambient mcpCtx) as a `tid` claim, and expose it as an X-Tenant-Id
// header, so peer calls (HR→RBAC/PM/DAM) carry tenant context instead of
// dropping it. No DB — pure signing/context logic, runs anywhere in CI.
import { describe, it, expect, beforeAll } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { mcpCtx } from '../../../src/mcp/context.js';
import { signServiceJwt, ambientTenantHeader } from '../../../src/lib/serviceJwt.js';

const T = '14c350e8-0000-4000-8000-00000000abcd';
const decode = (tok) => (tok ? jwt.decode(tok) : null);

beforeAll(() => {
    // HS256 lane needs a shared secret; EdDSA lane is exercised in-cluster.
    process.env.SERVICE_JWT_SECRET = process.env.SERVICE_JWT_SECRET || 'test-service-secret';
});

describe('S2S tenant propagation — tid claim', () => {
    it('embeds the ambient tenant as tid when signing inside a tenant context', () => {
        const payload = mcpCtx.run({ user: { tenantId: T } }, () => decode(signServiceJwt()));
        expect(payload).toBeTruthy();
        expect(payload.tid).toBe(T);
    });

    it('omits tid when there is no ambient tenant context (backward compatible)', () => {
        const payload = decode(signServiceJwt());
        expect(payload).toBeTruthy();
        expect(payload.tid).toBeUndefined();
    });

    it('honors an explicit tid override (system opt-out) over the ambient tenant', () => {
        const payload = mcpCtx.run({ user: { tenantId: T } }, () => decode(signServiceJwt({ tid: null })));
        expect(payload.tid).toBeNull();
    });

    it('does not clobber other explicit claims when adding the ambient tid', () => {
        const payload = mcpCtx.run({ user: { tenantId: T } }, () => decode(signServiceJwt({ scope: 'x' })));
        expect(payload.tid).toBe(T);
        expect(payload.scope).toBe('x');
    });
});

describe('S2S tenant propagation — X-Tenant-Id header', () => {
    it('emits X-Tenant-Id inside a tenant context', () => {
        const h = mcpCtx.run({ user: { tenantId: T } }, () => ambientTenantHeader());
        expect(h).toEqual({ 'X-Tenant-Id': T });
    });

    it('emits nothing outside a tenant context', () => {
        expect(ambientTenantHeader()).toEqual({});
    });

    it('emits nothing when the ambient tenant is blank', () => {
        const h = mcpCtx.run({ user: { tenantId: '   ' } }, () => ambientTenantHeader());
        expect(h).toEqual({});
    });
});
