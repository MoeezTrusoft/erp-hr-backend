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

// Import routes after mocking
const { analyticsRoutes } = await import('../../src/routes/analytics.js');

const createTestApp = (user = null) => {
    const app = express();
    app.use(express.json());

    // Add user to request if provided
    if (user) {
        app.use((req, res, next) => {
            req.user = user;
            next();
        });
    }

    app.use('/api/analytics', analyticsRoutes);
    return app;
};

describe('Analytics Routes Integration Tests', () => {
    const mockUser = {
        tenantId: 1,
        role: 'HR_ADMIN',
        departmentId: 5,
        id: 1
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/analytics/reports/headcount', () => {
        test('should return headcount report with valid parameters', async () => {
            const mockReport = {
                summary: { totalHeadcount: 150, departmentCount: 5 },
                byDepartment: [
                    { departmentId: 1, currentCount: 50, trend: 5.2 },
                    { departmentId: 2, currentCount: 30, trend: -2.1 }
                ],
                timeframe: { startDate: '2024-01-01', endDate: '2024-01-31' }
            };

            mockGenerateHeadcountReport.mockResolvedValue(mockReport);

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/headcount')
                .query({
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    departmentId: '1',
                    location: 'New York'
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockReport);
            expect(response.body.metadata.filters).toEqual({
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                departmentId: '1',
                location: 'New York'
            });

            expect(mockGenerateHeadcountReport).toHaveBeenCalledWith({
                tenantId: 1,
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                departmentId: '1',
                location: 'New York',
                userRole: 'HR_ADMIN'
            });
        });

        test('should handle service errors gracefully', async () => {
            mockGenerateHeadcountReport.mockRejectedValue(new Error('Database connection timeout'));

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/reports/headcount')
                .query({
                    startDate: '2024-01-01',
                    endDate: '2024-01-31'
                });

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Database connection timeout');
        });
    });

    describe('GET /api/analytics/dashboards/overview', () => {
        test('should return comprehensive dashboard KPIs', async () => {
            const mockKPIs = {
                workforce: {
                    currentHeadcount: 150,
                    headcountTrend: 2.5,
                    turnoverRate: 3.3,
                    absenteeismRate: 2.1
                },
                recruitment: {
                    openPositions: 12,
                    averageTimeToFill: 45,
                    offerAcceptanceRate: 75
                },
                performance: {
                    reviewCompletionRate: 85,
                    averageRating: 3.8,
                    goalAchievementRate: 72
                },
                financial: {
                    totalPayroll: 1500000,
                    payrollAccuracy: 98,
                    costPerHire: 5000
                },
                lastUpdated: '2024-01-15T10:30:00.000Z'
            };

            mockGetDashboardKPIs.mockResolvedValue(mockKPIs);

            const app = createTestApp(mockUser);
            const response = await request(app)
                .get('/api/analytics/dashboards/overview')
                .query({ timeframe: 'current_quarter' });

            expect(response.status).toBe(200);
            expect(response.body.data.workforce.currentHeadcount).toBe(150);
            expect(response.body.data.recruitment.openPositions).toBe(12);
            expect(response.body.data.performance.reviewCompletionRate).toBe(85);
            expect(response.body.metadata.timeframe).toBe('current_quarter');
        });
    });

    describe('POST /api/analytics/reports/export', () => {
        test('should export report in Excel format', async () => {
            const mockExcelData = Buffer.from('Mock Excel File Content');
            mockExportReport.mockResolvedValue(mockExcelData);

            const exportRequest = {
                reportType: 'headcount',
                format: 'excel',
                filters: {
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    departmentId: 1
                }
            };

            const app = createTestApp(mockUser);
            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send(exportRequest);

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('spreadsheetml');
            expect(response.headers['content-disposition']).toContain('.xlsx');
        });

        test('should validate export parameters', async () => {
            const app = createTestApp(mockUser);
            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send({}); // Missing required parameters

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
        });
    });
});