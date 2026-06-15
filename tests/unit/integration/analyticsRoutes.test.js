// tests/unit/integration/analyticsRoutes.test.js
//
// The original file used the legacy `jest.mock(...)` helper (a no-op
// under ESM) and reached into Express 5 router internals. It was parked
// behind describe.skip pending an ESM rewrite. Rather than delete the
// suite — which would silently shrink coverage of the analytics route
// layer — we rewire it on the same ESM mocking pattern used by
// `analytics.integration.test.js` and intentionally restrict it to
// routes the sibling does *not* exercise:
//
//   sibling covers:  headcount happy + service-error,
//                    dashboards/overview happy,
//                    export excel + missing-param 400.
//
//   this file adds:  turnover happy + missing-param 400,
//                    salary happy (HR_ADMIN),
//                    salary 403 for non-privileged role,
//                    export PDF happy,
//                    export invalid format → 400,
//                    export salary report blocked for non-privileged role.
//
// No production source is touched in this lane.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGenerateTurnoverReport = jest.fn();
const mockGenerateSalaryReport = jest.fn();
const mockExportReport = jest.fn();

// Mock only the analytics service surface this file exercises; the
// controller never reads any other export from the module under these
// routes.
jest.unstable_mockModule('../../../src/services/analyticsService.js', () => ({
    generateHeadcountReport: jest.fn(),
    generateTurnoverReport: mockGenerateTurnoverReport,
    generateSalaryReport: mockGenerateSalaryReport,
    generateLeaveBalancesReport: jest.fn(),
    generateAbsenceReport: jest.fn(),
    generateEEOReport: jest.fn(),
    generateRecruitmentPipelineReport: jest.fn(),
    getDashboardKPIs: jest.fn(),
    getPositionDashboard: jest.fn(),
    getRecruitmentDashboard: jest.fn(),
    getPerformanceDashboard: jest.fn(),
    exportReport: mockExportReport,
}));

const { analyticsRoutes } = await import('../../../src/routes/analytics.js');

const buildApp = (user) => {
    const app = express();
    app.use(express.json());
    if (user) {
        app.use((req, _res, next) => {
            req.user = user;
            next();
        });
    }
    app.use('/api/analytics', analyticsRoutes);
    return app;
};

const HR_ADMIN = { tenantId: 1, role: 'HR_ADMIN', id: 1 };
const EMPLOYEE = { tenantId: 1, role: 'EMPLOYEE', id: 7 };

describe('Analytics Routes — non-duplicate coverage vs analytics.integration.test.js', () => {
    beforeEach(() => {
        mockGenerateTurnoverReport.mockReset();
        mockGenerateSalaryReport.mockReset();
        mockExportReport.mockReset();
    });

    describe('GET /api/analytics/reports/turnover', () => {
        test('returns the turnover report and forwards the query filters to the service', async () => {
            const mockReport = [
                { position: 'Developer', terminations: 2, turnoverRate: 3.3 },
                { position: 'Analyst', terminations: 1, turnoverRate: 1.7 },
            ];
            mockGenerateTurnoverReport.mockResolvedValue(mockReport);

            const response = await request(buildApp(HR_ADMIN))
                .get('/api/analytics/reports/turnover')
                .query({
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    positionId: '1',
                    terminationType: 'voluntary',
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockReport);
            expect(response.body.metadata.filters).toEqual({
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                positionId: '1',
                terminationType: 'voluntary',
            });
            expect(mockGenerateTurnoverReport).toHaveBeenCalledWith({
                tenantId: 1,
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                positionId: '1',
                terminationType: 'voluntary',
                userRole: 'HR_ADMIN',
            });
        });

        test('returns 400 when startDate/endDate are missing', async () => {
            const response = await request(buildApp(HR_ADMIN))
                .get('/api/analytics/reports/turnover');

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/required parameters/i);
            expect(mockGenerateTurnoverReport).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/analytics/reports/salary', () => {
        test('returns the salary report for privileged roles', async () => {
            const mockReport = [
                { position: 'Developer', min: 50000, max: 120000, avg: 80000, employeeCount: 12 },
            ];
            mockGenerateSalaryReport.mockResolvedValue(mockReport);

            const response = await request(buildApp(HR_ADMIN))
                .get('/api/analytics/reports/salary')
                .query({ positionId: '1' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockReport);
            expect(mockGenerateSalaryReport).toHaveBeenCalledWith({
                tenantId: 1,
                positionId: '1',
                jobGrade: undefined,
                location: undefined,
                userRole: 'HR_ADMIN',
            });
        });

        test('returns 403 for non-privileged roles and never reaches the service', async () => {
            const response = await request(buildApp(EMPLOYEE))
                .get('/api/analytics/reports/salary');

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/insufficient permissions/i);
            expect(mockGenerateSalaryReport).not.toHaveBeenCalled();
        });
    });

    describe('POST /api/analytics/reports/export', () => {
        test('exports a PDF report with the correct Content-Type and Content-Disposition', async () => {
            const mockPdf = Buffer.from('Mock PDF content');
            mockExportReport.mockResolvedValue(mockPdf);

            const response = await request(buildApp(HR_ADMIN))
                .post('/api/analytics/reports/export')
                .send({
                    reportType: 'turnover',
                    format: 'pdf',
                    filters: { startDate: '2024-01-01', endDate: '2024-01-31' },
                });

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('application/pdf');
            expect(response.headers['content-disposition']).toContain('.pdf');
            expect(response.headers['content-disposition']).toContain('turnover_report');
            expect(mockExportReport).toHaveBeenCalledWith(
                expect.objectContaining({
                    reportType: 'turnover',
                    format: 'pdf',
                    tenantId: 1,
                    userRole: 'HR_ADMIN',
                })
            );
        });

        test('returns 400 when format is neither excel nor pdf', async () => {
            const response = await request(buildApp(HR_ADMIN))
                .post('/api/analytics/reports/export')
                .send({ reportType: 'headcount', format: 'csv' });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/excel.*pdf/i);
            expect(mockExportReport).not.toHaveBeenCalled();
        });

        test('returns 403 when a non-privileged role tries to export salary data', async () => {
            const response = await request(buildApp(EMPLOYEE))
                .post('/api/analytics/reports/export')
                .send({ reportType: 'salary', format: 'excel' });

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/insufficient permissions/i);
            expect(mockExportReport).not.toHaveBeenCalled();
        });
    });
});
