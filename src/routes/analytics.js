import express from 'express';
import {
    getHeadcountReport,
    getTurnoverReport,
    getSalaryReport,
    getLeaveBalancesReport,
    getAbsenceReport,
    getEEOReport,
    getRecruitmentPipelineReport,
    getDashboardKPIs,
    getPositionDashboard,
    getRecruitmentDashboard,
    getPerformanceDashboard,
    getPayrollKpis,
    exportReport,
    healthCheck
} from '../controllers/analyticsController.js';

const router = express.Router();

// Standard Reports
router.get('/reports/headcount', getHeadcountReport);
router.get('/reports/turnover', getTurnoverReport);
router.get('/reports/salary', getSalaryReport);
router.get('/reports/leave-balances', getLeaveBalancesReport);
router.get('/reports/absence', getAbsenceReport);
router.get('/reports/eeo', getEEOReport);
router.get('/reports/recruitment-pipeline', getRecruitmentPipelineReport);

// Dashboards
router.get('/dashboards/overview', getDashboardKPIs);
router.get('/dashboards/position', getPositionDashboard); // Changed from department to position
router.get('/dashboards/recruitment', getRecruitmentDashboard);
router.get('/dashboards/performance', getPerformanceDashboard);
router.get('/dashboards/payroll-kpis', getPayrollKpis); // HR-KPI-06

// Export
router.post('/reports/export', exportReport);

// Health Check
router.get('/health', healthCheck);

export { router as analyticsRoutes };