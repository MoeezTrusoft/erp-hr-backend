// HR-BANKFILE-03 / HR-PAY-04 — the bank disbursement endpoint is deny-by-default
// permission-gated AND tenant-scoped.
//
// Mounts the REAL payrollRoutes behind the repo's real attachHrContext (the same
// gateway-resolved identity/entitlement context) with a MOCKED bankFileService +
// c4Access, then asserts:
//   * no hr:payroll permission → 403 (service never called).
//   * with hr:payroll VIEW → 200, file streamed as an attachment.
//   * a cross-tenant run id (service throws 404) → 404 (never another tenant's file).
//   * a non-FINALIZED run (service throws 409) → 409.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const bankSvcMock = { generateBankDisbursementFile: jest.fn() };
jest.unstable_mockModule('../../../src/services/bankFileService.js', () => bankSvcMock);
// keep the C4 audit side-effect (prisma-backed) out of the route test.
jest.unstable_mockModule('../../../src/lib/c4Access.js', () => ({ auditC4Read: jest.fn().mockResolvedValue(undefined) }));

const { attachHrContext } = await import('../../../src/middlewares/hrContext.middleware.js');
const { default: payrollRoutes } = await import('../../../src/routes/payrollRoutes.js');

const app = express();
app.use(express.json());
app.use(attachHrContext);
app.use('/api/payroll', payrollRoutes);

const asUser = (req, { permissions = {} } = {}) =>
    req
        .set('x-user-id', '7')
        .set('x-employee-id', '7')
        .set('x-user-roles', JSON.stringify(['HR_ADMIN']))
        .set('x-user-permissions', JSON.stringify(permissions));

beforeEach(() => {
    bankSvcMock.generateBankDisbursementFile.mockReset();
    bankSvcMock.generateBankDisbursementFile.mockResolvedValue({
        format: 'nacha',
        filename: 'disbursement-run-10.ach',
        contentType: 'text/plain',
        content: '1...file...',
        summary: { runId: 10, rowCount: 2, totalMinor: 450049, currency: 'USD' },
    });
});

describe('permission gate (deny-by-default)', () => {
    it('a caller WITHOUT hr:payroll is forbidden (403) and the service is never called', async () => {
        const res = await asUser(request(app).get('/api/payroll/runs/10/bank-file'), {
            permissions: { 'hr:employee': ['VIEW'] },
        });
        expect(res.status).toBe(403);
        expect(bankSvcMock.generateBankDisbursementFile).not.toHaveBeenCalled();
    });

    it('an UNAUTHENTICATED caller (no entitlement blob) is forbidden (403)', async () => {
        const res = await request(app).get('/api/payroll/runs/10/bank-file');
        expect(res.status).toBe(403);
        expect(bankSvcMock.generateBankDisbursementFile).not.toHaveBeenCalled();
    });
});

describe('authorized export (no over-deny)', () => {
    it('hr:payroll VIEW → 200 with the file as a download attachment', async () => {
        const res = await asUser(request(app).get('/api/payroll/runs/10/bank-file?format=nacha'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('disbursement-run-10.ach');
        expect(bankSvcMock.generateBankDisbursementFile).toHaveBeenCalledTimes(1);
        // the controller threads the format + actor through to the service.
        expect(bankSvcMock.generateBankDisbursementFile.mock.calls[0][1]).toMatchObject({ format: 'nacha' });
    });
});

describe('error mapping (tenant scope + status gate)', () => {
    it('a cross-tenant run id (service 404) maps to 404', async () => {
        bankSvcMock.generateBankDisbursementFile.mockRejectedValue(
            Object.assign(new Error('Payroll run 10 not found'), { statusCode: 404, code: 'HR-1210' }),
        );
        const res = await asUser(request(app).get('/api/payroll/runs/10/bank-file'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('HR-1210');
    });

    it('a non-FINALIZED run (service 409) maps to 409', async () => {
        bankSvcMock.generateBankDisbursementFile.mockRejectedValue(
            Object.assign(new Error('not FINALIZED'), { statusCode: 409, code: 'HR-1211' }),
        );
        const res = await asUser(request(app).get('/api/payroll/runs/10/bank-file'), {
            permissions: { 'hr:payroll': ['VIEW'] },
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('HR-1211');
    });
});
