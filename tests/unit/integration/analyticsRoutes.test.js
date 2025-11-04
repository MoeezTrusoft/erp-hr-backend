import request from 'supertest';
import express from 'express';
import { analyticsRoutes } from '../../routes/analytics.js';
import * as analyticsService from '../../services/analyticsService.js';

// Mock the analytics service
jest.mock('../../services/analyticsService.js');

const app = express();
app.use(express.json());
app.use('/api/analytics', analyticsRoutes);

// Mock authentication middleware
app.use((req, res, next) => {
    // Simulate authenticated user - in real app, this would be from JWT
    req.user = {
        tenantId: 1,
        role: 'HR_ADMIN',
        departmentId: 5,
        id: 1
    };
    next();
});

describe('Analytics Routes Integration Tests', () => {
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

            analyticsService.generateHeadcountReport.mockResolvedValue(mockReport);

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

            expect(analyticsService.generateHeadcountReport).toHaveBeenCalledWith({
                tenantId: 1,
                startDate: '2024-01-01',
                endDate: '2024-01-31',
                departmentId: '1',
                location: 'New York',
                userRole: 'HR_ADMIN'
            });
        });

        test('should handle service errors gracefully', async () => {
            analyticsService.generateHeadcountReport.mockRejectedValue(new Error('Database connection timeout'));

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

    describe('GET /api/analytics/reports/turnover', () => {
        test('should return turnover report with calculated rates', async () => {
            const mockReport = {
                summary: {
                    totalTerminations: 5,
                    overallTurnoverRate: 3.3,
                    averageHeadcount: 150,
                    voluntaryRate: 80,
                    involuntaryRate: 20
                },
                byDepartment: [
                    { departmentId: 1, terminations: 3, turnoverRate: 4.0 }
                ],
                terminatedEmployees: [
                    { id: 1, name: 'John Doe', departmentId: 1, terminationDate: '2024-01-15', jobTitle: 'Developer' }
                ],
                timeframe: { startDate: '2024-01-01', endDate: '2024-01-31' }
            };

            analyticsService.generateTurnoverReport.mockResolvedValue(mockReport);

            const response = await request(app)
                .get('/api/analytics/reports/turnover')
                .query({
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    departmentId: '1',
                    terminationType: 'voluntary'
                });

            expect(response.status).toBe(200);
            expect(response.body.data.summary.overallTurnoverRate).toBe(3.3);
            expect(response.body.data.terminatedEmployees).toHaveLength(1);
        });
    });

    describe('GET /api/analytics/reports/salary', () => {
        test('should return salary report for authorized roles', async () => {
            const mockReport = {
                summary: {
                    min: 45000,
                    max: 150000,
                    average: 75000,
                    median: 72000,
                    totalPayroll: 7500000
                },
                byDepartment: [
                    { departmentId: 1, averageSalary: 80000, employeeCount: 50 }
                ],
                distribution: [
                    { range: '45000 - 66000', count: 20 }
                ],
                employeeCount: 100
            };

            analyticsService.generateSalaryReport.mockResolvedValue(mockReport);

            const response = await request(app)
                .get('/api/analytics/reports/salary')
                .query({ departmentId: '1' });

            expect(response.status).toBe(200);
            expect(response.body.data.summary.average).toBe(75000);
            expect(response.body.data.byDepartment[0].employeeCount).toBe(50);
        });

        test('should return 403 for unauthorized roles', async () => {
            // Temporarily change user role to unauthorized
            const originalUser = app._router.stack[1].handle;
            app._router.stack[1].handle = (req, res, next) => {
                req.user = { tenantId: 1, role: 'EMPLOYEE' };
                next();
            };

            const response = await request(app)
                .get('/api/analytics/reports/salary');

            expect(response.status).toBe(403);
            expect(response.body.error).toContain('Insufficient permissions');

            // Restore original user
            app._router.stack[1].handle = originalUser;
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

            analyticsService.getDashboardKPIs.mockResolvedValue(mockKPIs);

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
            analyticsService.exportReport.mockResolvedValue(mockExcelData);

            const exportRequest = {
                reportType: 'headcount',
                format: 'excel',
                filters: {
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    departmentId: 1
                }
            };

            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send(exportRequest);

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('spreadsheetml');
            expect(response.headers['content-disposition']).toContain('.xlsx');
            expect(response.body).toEqual(mockExcelData);
        });

        test('should export report in PDF format', async () => {
            const mockPdfData = Buffer.from('Mock PDF File Content');
            analyticsService.exportReport.mockResolvedValue(mockPdfData);

            const exportRequest = {
                reportType: 'turnover',
                format: 'pdf',
                filters: {
                    startDate: '2024-01-01',
                    endDate: '2024-01-31'
                }
            };

            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send(exportRequest);

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('pdf');
            expect(response.headers['content-disposition']).toContain('.pdf');
        });

        test('should validate export parameters', async () => {
            const response = await request(app)
                .post('/api/analytics/reports/export')
                .send({}); // Missing required parameters

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
        });
    });

    describe('Role-Based Access Control', () => {
        test('department manager should only access their department data', async () => {
            // Set up department manager user
            const originalUser = app._router.stack[1].handle;
            app._router.stack[1].handle = (req, res, next) => {
                req.user = { tenantId: 1, role: 'DEPARTMENT_MANAGER', departmentId: 5 };
                next();
            };

            const mockReport = {
                summary: { totalHeadcount: 25 },
                byDepartment: [{ departmentId: 5, currentCount: 25 }]
            };

            analyticsService.generateHeadcountReport.mockResolvedValue(mockReport);

            const response = await request(app)
                .get('/api/analytics/reports/headcount')
                .query({
                    startDate: '2024-01-01',
                    endDate: '2024-01-31',
                    departmentId: '5'
                });

            expect(response.status).toBe(200);

            // Verify service was called with department filter
            expect(analyticsService.generateHeadcountReport).toHaveBeenCalledWith(
                expect.objectContaining({
                    departmentId: '5',
                    userRole: 'DEPARTMENT_MANAGER'
                })
            );

            // Restore original user
            app._router.stack[1].handle = originalUser;
        });
    });
}); 