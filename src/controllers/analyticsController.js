import * as analyticsService from '../services/analyticsService.js';

/**
 * Standard Report Controllers
 */
export const getHeadcountReport = async (req, res) => {
    try {
        const { startDate, endDate, positionId, location } = req.query;
        const user = req.user;

        // Validate required parameters
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required parameters'
            });
        }

        const result = await analyticsService.generateHeadcountReport({
            tenantId: user.tenantId,
            startDate,
            endDate,
            positionId,
            location,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { startDate, endDate, positionId, location }
            }
        });
    } catch (error) {
        console.error('Headcount Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getTurnoverReport = async (req, res) => {
    try {
        const { startDate, endDate, positionId, terminationType } = req.query;
        const user = req.user;

        // Validate required parameters
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required parameters'
            });
        }

        const result = await analyticsService.generateTurnoverReport({
            tenantId: user.tenantId,
            startDate,
            endDate,
            positionId,
            terminationType,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { startDate, endDate, positionId, terminationType }
            }
        });
    } catch (error) {
        console.error('Turnover Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getSalaryReport = async (req, res) => {
    try {
        const { positionId, jobGrade, location } = req.query;
        const user = req.user;

        // Check permissions for salary data
        if (!['HR_ADMIN', 'HR_MANAGER', 'EXECUTIVE'].includes(user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to access salary data'
            });
        }

        const result = await analyticsService.generateSalaryReport({
            tenantId: user.tenantId,
            positionId,
            jobGrade,
            location,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { positionId, jobGrade, location }
            }
        });
    } catch (error) {
        console.error('Salary Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getLeaveBalancesReport = async (req, res) => {
    try {
        const { positionId, employeeId } = req.query;
        const user = req.user;

        const result = await analyticsService.generateLeaveBalancesReport({
            tenantId: user.tenantId,
            positionId,
            employeeId,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { positionId, employeeId }
            }
        });
    } catch (error) {
        console.error('Leave Balances Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getAbsenceReport = async (req, res) => {
    try {
        const { startDate, endDate, positionId, absenceType } = req.query;
        const user = req.user;

        // Validate required parameters
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required parameters'
            });
        }

        const result = await analyticsService.generateAbsenceReport({
            tenantId: user.tenantId,
            startDate,
            endDate,
            positionId,
            absenceType,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { startDate, endDate, positionId, absenceType }
            }
        });
    } catch (error) {
        console.error('Absence Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getEEOReport = async (req, res) => {
    try {
        const { positionId, location } = req.query;
        const user = req.user;

        const result = await analyticsService.generateEEOReport({
            tenantId: user.tenantId,
            positionId,
            location,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { positionId, location }
            }
        });
    } catch (error) {
        console.error('EEO Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getRecruitmentPipelineReport = async (req, res) => {
    try {
        const { status, positionId, hiringManagerId } = req.query;
        const user = req.user;

        const result = await analyticsService.generateRecruitmentPipelineReport({
            tenantId: user.tenantId,
            status,
            positionId,
            hiringManagerId,
            userRole: user.role
        });

        res.json({
            success: true,
            data: result,
            metadata: {
                generatedAt: new Date().toISOString(),
                filters: { status, positionId, hiringManagerId }
            }
        });
    } catch (error) {
        console.error('Recruitment Pipeline Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Dashboard Controllers
 */
export const getDashboardKPIs = async (req, res) => {
    try {
        const { timeframe = 'current_quarter' } = req.query;
        const user = req.user;

        const kpis = await analyticsService.getDashboardKPIs({
            tenantId: user.tenantId,
            timeframe,
            userRole: user.role
        });

        res.json({
            success: true,
            data: kpis,
            metadata: {
                generatedAt: new Date().toISOString(),
                timeframe
            }
        });
    } catch (error) {
        console.error('Dashboard KPIs Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getPositionDashboard = async (req, res) => {
    try {
        const { positionId, timeframe = 'current_quarter' } = req.query;
        const user = req.user;

        // Validate positionId for position managers
        if (user.role === 'DEPARTMENT_MANAGER' && !positionId) {
            return res.status(400).json({
                success: false,
                error: 'positionId is required for position managers'
            });
        }

        const dashboard = await analyticsService.getPositionDashboard({
            tenantId: user.tenantId,
            positionId: positionId || user.positionId,
            timeframe,
            userRole: user.role
        });

        res.json({
            success: true,
            data: dashboard,
            metadata: {
                generatedAt: new Date().toISOString(),
                timeframe
            }
        });
    } catch (error) {
        console.error('Position Dashboard Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getRecruitmentDashboard = async (req, res) => {
    try {
        const { timeframe = 'current_quarter' } = req.query;
        const user = req.user;

        // Check permissions for recruitment data
        if (!['HR_ADMIN', 'HR_MANAGER', 'RECRUITER'].includes(user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to access recruitment data'
            });
        }

        const dashboard = await analyticsService.getRecruitmentDashboard({
            tenantId: user.tenantId,
            timeframe,
            userRole: user.role
        });

        res.json({
            success: true,
            data: dashboard,
            metadata: {
                generatedAt: new Date().toISOString(),
                timeframe
            }
        });
    } catch (error) {
        console.error('Recruitment Dashboard Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

export const getPerformanceDashboard = async (req, res) => {
    try {
        const { timeframe = 'current_quarter' } = req.query;
        const user = req.user;

        // Check permissions for performance data
        if (!['HR_ADMIN', 'HR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to access performance data'
            });
        }

        const dashboard = await analyticsService.getPerformanceDashboard({
            tenantId: user.tenantId,
            timeframe,
            userRole: user.role
        });

        res.json({
            success: true,
            data: dashboard,
            metadata: {
                generatedAt: new Date().toISOString(),
                timeframe
            }
        });
    } catch (error) {
        console.error('Performance Dashboard Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Export Controller
 */
export const exportReport = async (req, res) => {
    try {
        const { reportType, format, filters } = req.body;
        const user = req.user;

        // Validate required parameters
        if (!reportType || !format) {
            return res.status(400).json({
                success: false,
                error: 'reportType and format are required parameters'
            });
        }

        // Validate format
        if (!['excel', 'pdf'].includes(format)) {
            return res.status(400).json({
                success: false,
                error: 'format must be either "excel" or "pdf"'
            });
        }

        // Check permissions for sensitive reports
        if (reportType === 'salary' && !['HR_ADMIN', 'HR_MANAGER', 'EXECUTIVE'].includes(user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to export salary data'
            });
        }

        const result = await analyticsService.exportReport({
            tenantId: user.tenantId,
            reportType,
            format,
            filters: filters || {},
            userRole: user.role
        });

        // Set appropriate headers for download
        const contentType = format === 'excel'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf';

        const extension = format === 'excel' ? 'xlsx' : 'pdf';
        const filename = `${reportType}_report_${Date.now()}.${extension}`;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        res.send(result);
    } catch (error) {
        console.error('Export Report Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Health Check Controller
 */
export const healthCheck = async (req, res) => {
    try {
        // Test database connection and basic functionality
        const testResult = await analyticsService.getDashboardKPIs({
            tenantId: 1, // Default tenant for health check
            timeframe: 'current_month',
            userRole: 'HR_ADMIN'
        });

        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: 'connected',
            services: 'operational'
        });
    } catch (error) {
        console.error('Health Check Error:', error);
        res.status(503).json({
            success: false,
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
};

export { getPositionDashboard as getDepartmentDashboard };
