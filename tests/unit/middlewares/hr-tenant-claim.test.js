// T-P2.1 / X-02 — HR must source the request tenant from the VERIFIED
// service-JWT claim (req.internalService.tenantId → req.user.tenantId), never
// the spoofable x-tenant-id header. Drives internalServiceGuard directly so we
// can observe req.user after it runs.
import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.SERVICE_JWT_SECRET = 'hr-tenant-test-secret';

let internalServiceGuard;
beforeAll(async () => {
  ({ internalServiceGuard } = await import('../../../src/middlewares/internalService.middleware.js'));
});

// hr verifies with SERVICE_JWT_SECRET, issuer erp-gateway, audience internal,
// and reads tenant from claims.tenantId ?? claims.tid.
function mintSvcJwt(claims) {
  return jwt.sign(
    { iss: 'erp-gateway', aud: 'internal', sub: 'svc:test', act: { type: 'service', id: 'test' }, ...claims },
    process.env.SERVICE_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

const mockRes = () => {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn(() => res);
  return res;
};

describe('T-P2.1 HR tenant resolution', () => {
  test('sets req.user.tenantId from the verified tid (uuid STRING, verbatim), IGNORING a spoofed x-tenant-id', async () => {
    // REQ-007 — tid is now an opaque RBAC Company.uuid string, NOT an int. It
    // must be threaded onto req.user.tenantId untouched (never Number()/parseInt).
    const TENANT_UUID = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
    const token = mintSvcJwt({ tid: TENANT_UUID });
    const req = {
      headers: { 'x-service-authorization': `Bearer ${token}`, 'x-tenant-id': '999' },
      user: { userId: 1, tenantId: null }, // as attachHrContext leaves it (no header trust)
    };
    const res = mockRes();
    const next = jest.fn();

    await internalServiceGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.tenantId).toBe(TENANT_UUID); // verbatim uuid, not the spoofed 999
    expect(typeof req.user.tenantId).toBe('string'); // never numeric-coerced
  });

  test('a verified token with no tenant claim yields null tenant (no header leakage)', async () => {
    const token = mintSvcJwt({}); // no tid
    const req = {
      headers: { 'x-service-authorization': `Bearer ${token}`, 'x-tenant-id': '999' },
      user: { userId: 1, tenantId: null },
    };
    const res = mockRes();
    const next = jest.fn();

    await internalServiceGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.tenantId).toBeNull(); // never the spoofed 999
  });
});
