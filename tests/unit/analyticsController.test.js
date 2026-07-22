import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Mock the analytics service
const mockGenerateHeadcountReport = jest.fn();
const mockGenerateTurnoverReport = jest.fn();
const mockGenerateSalaryReport = jest.fn();
const mockGenerateLeaveBalancesReport = jest.fn();
const mockGenerateAbsenceReport = jest.fn();
const mockGenerateEEOReport = jest.fn();
const mockGenerateRecruitmentPipelineReport = jest.fn();
const mockGetDashboardKPIs = jest.fn();
const mockGetDepartmentDashboard = jest.fn();
const mockGetRecruitmentDashboard = jest.fn();
const mockGetPerformanceDashboard = jest.fn();
const mockExportReport = jest.fn();

jest.unstable_mockModule('../../src/services/analyticsService.js', () => ({
    generateHeadcountReport: mockGenerateHeadcountReport,
    generateTurnoverReport: mockGenerateTurnoverReport,
    generateSalaryReport: mockGenerateSalaryReport,
    generateLeaveBalancesReport: mockGenerateLeaveBalancesReport,
    generateAbsenceReport: mockGenerateAbsenceReport,
    generateEEOReport: mockGenerateEEOReport,
    generateRecruitmentPipelineReport: mockGenerateRecruitmentPipelineReport,
    getDashboardKPIs: mockGetDashboardKPIs,
    getDepartmentDashboard: mockGetDepartmentDashboard,
    getRecruitmentDashboard: mockGetRecruitmentDashboard,
    getPerformanceDashboard: mockGetPerformanceDashboard,
    exportReport: mockExportReport,
}));

// Import controller after mocking
const {
    getHeadcountReport,
    getTurnoverReport,
    getSalaryReport,
    getLeaveBalancesReport,
    getAbsenceReport,
    getEEOReport,
    getRecruitmentPipelineReport,
    getDashboardKPIs,
    getDepartmentDashboard,
    getRecruitmentDashboard,
    getPerformanceDashboard,
    exportReport,
    healthCheck
} = await import('../../src/controllers/analyticsController.js');

// Create a test app with proper middleware
const createTestApp = (user = null) => {
    const app = express();
    app.use(express.json());

    // Add user to request if provided
    app.use((req, res, next) => {
        if (user) {
            req.user = user;
        }
        next();
    });

    // Register routes
    app.get('/api/analytics/reports/headcount', getHeadcountReport);
    app.get('/api/analytics/reports/turnover', getTurnoverReport);
    app.get('/api/analytics/reports/salary', getSalaryReport);
    app.get('/api/analytics/reports/leave-balances', getLeaveBalancesReport);
    app.get('/api/analytics/reports/absence', getAbsenceReport);
    app.get('/api/analytics/reports/eeo', getEEOReport);
    app.get('/api/analytics/reports/recruitment-pipeline', getRecruitmentPipelineReport);
    app.get('/api/analytics/dashboards/overview', getDashboardKPIs);
    app.get('/api/analytics/dashboards/department', getDepartmentDashboard);
    app.get('/api/analytics/dashboards/recruitment', getRecruitmentDashboard);
    app.get('/api/analytics/dashboards/performance', getPerformanceDashboard);
    app.post('/api/analytics/reports/export', exportReport);
    app.get('/api/analytics/health', healthCheck);

    return app;
};

describe('Analytics Controller', () => {
    const mockUser = {
        tenantId: 1,
        role: 'HR_ADMIN',
        departmentId: 5,
        id: 1
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getHeadcountReport', () => {
        test('should return headcount report successfully', async () => {
            const mockReport = {
                summary: { totalHeadcount: 100 },
                byDepartment: [{ departmentId: 1, currentCount: 50 }]
            };

            mockGenerateHeadcountReport.mockResolvedValue(mockReport);

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/headcount')
                .query({ startDate: '2024-01-01', endDate: '2024-01-31' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockReport);
            expect(mockGenerateHeadcountReport).toHaveBeenCalledWith({
                tenantId: 1,
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                departmentId: undefined,
                location: undefined,
                userRole: 'HR_ADMIN'
            });
        });

        test('should return 400 for missing date parameters', async () => {
            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/headcount');

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('required parameters');
        });

        test('should handle service errors', async () => {
            mockGenerateHeadcountReport.mockRejectedValue(new Error('Database error'));

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/headcount')
                .query({ startDate: '2024-01-01', endDate: '2024-01-31' });

            // ERR-3: a 5xx must NOT leak the raw error.message. The controller
            // now returns the canonical ErrorEnvelope with a generic message +
            // stable HR-5000 code; the real 'Database error' lives only in the
            // server logs.
            expect(response.status).toBe(500);
            expect(response.body.error).toBeDefined();
            expect(response.body.error.code).toBe('HR-5000');
            expect(response.body.error.message).toBe('Internal server error');
            expect(JSON.stringify(response.body)).not.toContain('Database error');
        });
    });

    describe('getSalaryReport', () => {
        test('should return salary report for authorized user', async () => {
            const mockReport = {
                summary: { average: 75000 },
                byDepartment: []
            };

            mockGenerateSalaryReport.mockResolvedValue(mockReport);

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/salary');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });

        test('should return 403 for unauthorized user', async () => {
            const unauthorizedUser = {
                tenantId: 1,
                role: 'EMPLOYEE'
            };

            const app = createTestApp(unauthorizedUser);
            const response = await request(app)
                .get('/api/analytics/reports/salary');

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Insufficient permissions');
        });
    });

    describe('exportReport', () => {
        test('should export report successfully', async () => {
            const mockExportData = Buffer.from('mock excel data');
            mockExportReport.mockResolvedValue(mockExportData);

            const exportRequest = {
                reportType: 'headcount',
                format: 'excel',
                filters: { startDate: '2024-01-01', endDate: '2024-01-31' }
            };

            const app = createTestApp(mockUser);
            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send(exportRequest);

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('spreadsheetml');
            expect(response.headers['content-disposition']).toContain('headcount_report');
        });

        test('should return 400 for missing parameters', async () => {
            const app = createTestApp(mockUser);
            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
        });
    });
});