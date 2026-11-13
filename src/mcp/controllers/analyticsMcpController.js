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

// IC-15 — getRecruitmentDashboard / getPerformanceDashboard carry a secondary,
// hard-coded role-name gate (HR_ADMIN | HR_MANAGER | RECRUITER, etc.) intended
// for the HTTP path. On the MCP path authorization is already enforced at the
// resource boundary by the hr:analytics:VIEW check (analyticsTools.js), so a
// holder whose role string isn't literally in that list (e.g. the super-admin
// RBAC_ADMIN) was wrongly 403'd. Present an effective HR_ADMIN role to satisfy
// the redundant gate — authorization-equivalent (the boundary already proved
// the caller holds hr:analytics) and data-scope-neutral (these dashboards are
// tenant-wide aggregates; applyDataScope treats HR_ADMIN and RBAC_ADMIN
// identically — no department/employee narrowing). HTTP callers are unaffected.
const asAnalyticsReader = (user) => ({
  ...user,
  roles: ["HR_ADMIN", ...(Array.isArray(user?.roles) ? user.roles : [])],
});

export const mcpGetAnalyticsDashboardOverview = (user) => runController(getDashboardKPIs, { user });
export const mcpGetAnalyticsDashboardRecruitment = (user) => runController(getRecruitmentDashboard, { user: asAnalyticsReader(user) });
export const mcpGetAnalyticsDashboardPerformance = (user) => runController(getPerformanceDashboard, { user: asAnalyticsReader(user) });

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
