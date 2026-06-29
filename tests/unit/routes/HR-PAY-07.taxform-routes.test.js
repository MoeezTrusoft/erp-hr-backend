// HR-PAY-07 / HR-SEC-05 — the year-end tax-form endpoints are deny-by-default
// permission-gated AND tenant-scoped.
//
// Mounts the REAL payrollRoutes behind the repo's real attachHrContext, with a
// MOCKED taxFormService + c4Access, then asserts:
//   * no hr:payroll permission → 403 (service never called).
//   * with hr:payroll VIEW → 200 (structured JSON) / file download (export).
//   * a cross-tenant request threads the verified tenant through to the service.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const svcMock = {
    generateYearEndTaxForms: jest.fn(),
    exportYearEndTaxForms: jest.fn(),
};
jest.unstable_mockModule('../../../src/services/taxFormService.js', () => svcMock);
jest.unstable_mockModule('../../../src/lib/c4Access.js', () => ({ auditC4Read: jest.fn().mockResolvedValue(undefined) }));

const { attachHrContext } = await import('../../../src/middlewares/hrContext.middleware.js');
const { default: payrollRoutes } = await import('../../../src/routes/payrollRoutes.js');

const app = express();
app.use(express.json());
// stamp a verified tenant the way internalServiceGuard would (NOT from a header).
app.use((req, _res, next) => { req._tenant = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'; next(); });
app.use(attachHrContext);
app.use((req, _res, next) => { if (req.user) req.user.tenantId = req._tenant; next(); });
app.use('/api/payroll', payrollRoutes);

const asUser = (req, { permissions = {} } = {}) =>
    req
        .set('x-user-id', '7')
        .set('x-employee-id', '7')
        .set('x-user-roles', JSON.stringify(['HR_ADMIN']))
        .set('x-user-permissions', JSON.stringify(permissions));

beforeEach(() => {
    svcMock.generateYearEndTaxForms.mockReset();
    svcMock.exportYearEndTaxForms.mockReset();
    svcMock.generateYearEndTaxForms.mockResolvedValue({
        taxYear: 2025, currency: 'USD', w2: [], form1099: [], summary: { taxYear: 2025 },
    });
    svcMock.exportYearEndTaxForms.mockResolvedValue({
        formType: 'W-2', format: 'csv', filename: 'w2-2025.csv', contentType: 'text/csv',
        content: 'tax_year,...\n', summary: { exportedCount: 3 },
    });
});

describe('permission gate (deny-by-default)', () => {
    it('a caller WITHOUT hr:payroll is forbidden (403); the service is never called', async () => {
        const res = await asUser(request(app).get('/api/payroll/tax-forms/2025'), {
            permissions: { 'hr:employee': ['VIEW'] },
        });
        expect(res.status).toBe(403);
        expect(svcMock.generateYearEndTaxForms).not.toHaveBeenCalled();
    });

    it('an UNAUTHENTICATED caller is forbidden (403) on the export route too', async () => {
        const res = await request(app).get('/api/payroll/tax-forms/2025/export?formType=w2');
        expect(res.status).toBe(403);
        expect(svcMock.exportYearEndTaxForms).not.toHaveBeenCalled();
    });
});

describe('authorized access (no over-deny) + tenant threading', () => {
    it('hr:payroll VIEW → 200 structured JSON, with the verified tenant threaded', async () => {
        const res = await asUser(request(app).get('/api/payroll/tax-forms/2025'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(svcMock.generateYearEndTaxForms).toHaveBeenCalledTimes(1);
        expect(svcMock.generateYearEndTaxForms.mock.calls[0][1]).toMatchObject({
            tenantId: '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007',
        });
    });

    it('export → 200 with a CSV download attachment', async () => {
        const res = await asUser(request(app).get('/api/payroll/tax-forms/2025/export?formType=w2&format=csv'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('w2-2025.csv');
        expect(res.headers['x-tax-form-type']).toBe('W-2');
        expect(svcMock.exportYearEndTaxForms.mock.calls[0][1]).toMatchObject({ formType: 'w2', format: 'csv' });
    });
});

describe('error mapping', () => {
    it('an invalid tax year (service 400) maps to 400 with its code', async () => {
        svcMock.generateYearEndTaxForms.mockRejectedValue(
            Object.assign(new Error('bad year'), { statusCode: 400, code: 'HR-1400' }),
        );
        const res = await asUser(request(app).get('/api/payroll/tax-forms/abc'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('HR-1400');
    });
});
