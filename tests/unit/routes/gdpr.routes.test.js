// HR-SEC-07 — GDPR export/erase routes must be authenticated + permission-gated.
//
// Finding (audit-reports/12-comprehensive-gap-register.md, A-HR rows / HOLE 1):
//   gdpr.routes.js mounts /export/:employeeId and /erase/:employeeId with NO
//   authenticate, NO permission gate and NO tenant scope, so ANY caller past the
//   service boundary (or a wrong-tenant caller) can export or IRREVERSIBLY ERASE
//   any employee by raw id.
//
// These specs mount the REAL router behind the repo's real attachHrContext +
// requireHrUser pattern (the same context the gateway provides) and a MOCKED
// gdpr.service, then assert:
//   (red, pre-fix) an unauthenticated export and a no-permission erase return 200.
//   (green, post-fix) unauthenticated → 401, authenticated-but-unprivileged → 403,
//   a legitimate DPO (hr:gdpr) → 200 (no over-deny), cross-tenant → 404.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const svcMock = {
    exportEmployeeData: jest.fn(),
    eraseEmployeeData: jest.fn(),
};
jest.unstable_mockModule('../../../src/services/gdpr.service.js', () => svcMock);

const { attachHrContext } = await import('../../../src/middlewares/hrContext.middleware.js');
const { default: gdprRoutes } = await import('../../../src/routes/gdpr.routes.js');

// Build an app that wires the gdpr router exactly as src/app.js does (after the
// internal-service boundary): attachHrContext populates req.user from the
// gateway-resolved headers, then the router enforces its own gates.
const app = express();
app.use(express.json());
app.use(attachHrContext);
app.use('/api/gdpr', gdprRoutes);

// Helper: a request carrying a gateway-resolved identity + entitlement blob.
const asUser = (req, { permissions = {}, tenant = 'tenant-a' } = {}) =>
    req
        .set('x-user-id', '7')
        .set('x-user-roles', JSON.stringify(['DPO']))
        .set('x-user-permissions', JSON.stringify(permissions));

beforeEach(() => {
    svcMock.exportEmployeeData.mockReset();
    svcMock.eraseEmployeeData.mockReset();
    svcMock.exportEmployeeData.mockResolvedValue({ employee: { id: 42 } });
    svcMock.eraseEmployeeData.mockResolvedValue({ success: true, employeeId: 42 });
});

describe('HR-SEC-07 — authentication gate', () => {
    it('UNAUTHENTICATED export is rejected (401) and the service is never called', async () => {
        const res = await request(app).get('/api/gdpr/export/42'); // no identity headers
        expect(res.status).toBe(401);
        expect(svcMock.exportEmployeeData).not.toHaveBeenCalled();
    });

    it('UNAUTHENTICATED erase is rejected (401)', async () => {
        const res = await request(app).delete('/api/gdpr/erase/42');
        expect(res.status).toBe(401);
        expect(svcMock.eraseEmployeeData).not.toHaveBeenCalled();
    });
});

describe('HR-SEC-07 — permission gate (deny-by-default)', () => {
    it('an authenticated caller WITHOUT hr:gdpr cannot export (403)', async () => {
        const res = await asUser(request(app).get('/api/gdpr/export/42'), {
            permissions: { 'hr:employee': ['VIEW'] },
        });
        expect(res.status).toBe(403);
        expect(svcMock.exportEmployeeData).not.toHaveBeenCalled();
    });

    it('an authenticated caller WITHOUT hr:gdpr cannot erase (403)', async () => {
        const res = await asUser(request(app).delete('/api/gdpr/erase/42'), {
            permissions: { 'hr:gdpr': ['VIEW'] }, // VIEW != DELETE
        });
        expect(res.status).toBe(403);
        expect(svcMock.eraseEmployeeData).not.toHaveBeenCalled();
    });
});

describe('HR-SEC-07 — legitimate DPO access still works (no over-deny)', () => {
    it('a DPO with hr:gdpr VIEW can export (200)', async () => {
        const res = await asUser(request(app).get('/api/gdpr/export/42'), {
            permissions: { 'hr:gdpr': ['VIEW', 'DELETE'] },
        });
        expect(res.status).toBe(200);
        expect(svcMock.exportEmployeeData).toHaveBeenCalledTimes(1);
    });

    it('a DPO with hr:gdpr DELETE can erase (200)', async () => {
        const res = await asUser(request(app).delete('/api/gdpr/erase/42'), {
            permissions: { 'hr:gdpr': ['VIEW', 'DELETE'] },
        });
        expect(res.status).toBe(200);
        expect(svcMock.eraseEmployeeData).toHaveBeenCalledTimes(1);
    });

    it('a cross-tenant target (service throws 404) maps to 404, never acts on data', async () => {
        svcMock.eraseEmployeeData.mockRejectedValue(
            Object.assign(new Error('Employee not found in tenant'), { statusCode: 404 })
        );
        const res = await asUser(request(app).delete('/api/gdpr/erase/999'), {
            permissions: { 'hr:gdpr': ['VIEW', 'DELETE'] },
        });
        expect(res.status).toBe(404);
    });
});
