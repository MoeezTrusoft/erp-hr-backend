import { runController } from "./_runner.js";
import {
  getDashboardKPIs,
  getRecruitmentDashboard,
  getPerformanceDashboard,
  getHeadcountReport,
  getTurnoverReport,
  getSalaryReport,
  getLeaveBalancesReport,
  getAbsenceReport,
  getEEOReport,
  getRecruitmentPipelineReport,
  exportReport,
} from "../../controllers/analyticsController.js";

export const mcpGetAnalyticsDashboardOverview = (user) => runController(getDashboardKPIs, { user });
export const mcpGetAnalyticsDashboardRecruitment = (user) => runController(getRecruitmentDashboard, { user });
export const mcpGetAnalyticsDashboardPerformance = (user) => runController(getPerformanceDashboard, { user });

export const mcpGetAnalyticsHeadcount = (user) => runController(getHeadcountReport, { user, query: { startDate: "2026-01-01", endDate: "2026-12-31" } });
export const mcpGetAnalyticsTurnover = (user) => runController(getTurnoverReport, { user, query: { startDate: "2026-01-01", endDate: "2026-12-31" } });
export const mcpGetAnalyticsSalary = (user) => runController(getSalaryReport, { user });
export const mcpGetAnalyticsLeaveBalances = (user) => runController(getLeaveBalancesReport, { user });
export const mcpGetAnalyticsAbsence = (user) => runController(getAbsenceReport, { user, query: { startDate: "2026-01-01", endDate: "2026-12-31" } });
export const mcpGetAnalyticsEeo = (user) => runController(getEEOReport, { user });
export const mcpGetAnalyticsRecruitmentPipeline = (user) => runController(getRecruitmentPipelineReport, { user });

export const mcpExportAnalyticsReport = (user, data) =>
  runController(exportReport, {
    user,
    body: {
      ...data,
      format: String(data?.format || "CSV").toLowerCase() === "csv" ? "excel" : String(data?.format || "excel").toLowerCase(),
    },
  });
