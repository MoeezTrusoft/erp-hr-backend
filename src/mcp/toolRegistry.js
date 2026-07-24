import { registerEmployeeTools } from "./tools/employeeTools.js";
import { registerAttendanceTools } from "./tools/attendanceTools.js";
import { registerLeaveTools } from "./tools/leaveTools.js";
import { registerPayrollTools } from "./tools/payrollTools.js";
import { registerPerformanceTools } from "./tools/performanceTools.js";
import { registerRecruitmentTools } from "./tools/recruitmentTools.js";
import { registerOnboardingTools } from "./tools/onboardingTools.js";
import { registerLearningTools } from "./tools/learningTools.js";
import { registerComplianceTools } from "./tools/complianceTools.js";
import { registerBenefitTools } from "./tools/benefitTools.js";
import { registerAnalyticsTools } from "./tools/analyticsTools.js";
import { registerSelfTools } from "./tools/selfTools.js";
import { registerResumeTools } from "./tools/resumeTools.js";
import { registerOrgChartTools } from "./tools/orgChartTools.js";
import { registerPositionMgmtTools } from "./tools/positionMgmtTools.js";
import { registerProfileActionTools } from "./tools/profileActionTools.js";
import { registerRequisitionMgmtTools } from "./tools/requisitionMgmtTools.js";
import { registerCandidatePipelineTools } from "./tools/candidatePipelineTools.js";
import { registerInterviewMgmtTools } from "./tools/interviewMgmtTools.js";
import { registerOfferMgmtTools } from "./tools/offerMgmtTools.js";
import { registerTalentPoolMgmtTools } from "./tools/talentPoolMgmtTools.js";
import { registerRecruitmentAnalyticsTools } from "./tools/recruitmentAnalyticsTools.js";
import { registerOnboardingMgmtTools } from "./tools/onboardingMgmtTools.js";
import { registerRecruitmentExtraTools } from "./tools/recruitmentExtraTools.js";
import { registerOnboardingDashboardTools } from "./tools/onboardingDashboardTools.js";
import { registerOnboardingDetailTools } from "./tools/onboardingDetailTools.js";
import { registerOnboardingScheduleTools } from "./tools/onboardingScheduleTools.js";
import { registerOnboardingPortalTools } from "./tools/onboardingPortalTools.js";
import { registerTimeAttendanceTools } from "./tools/timeAttendanceTools.js";
import { registerLeaveManagementTools } from "./tools/leaveManagementTools.js";
import { registerOvertimeShiftTools } from "./tools/overtimeShiftTools.js";
import { registerOvertimeManagerTools } from "./tools/overtimeManagerTools.js";
import { registerShiftTemplateSwapTools } from "./tools/shiftTemplateSwapTools.js";
import { registerOrgTools } from "./tools/orgTools.js";
import { registerCatalogTools } from "./tools/catalogTools.js";
import { registerReportsTools } from "./tools/reportsTools.js";
import { registerTimesheetReportTools } from "./tools/timesheetReportTools.js";
import { registerAttendanceOpsTools } from "./tools/attendanceOpsTools.js";
import { inferToolAnnotations } from "./utils/toolAnnotations.js";
import { isZodRawShape } from "./utils/isZodRawShape.js";

// API-6 — inject standard MCP tool annotations at the single registration seam.
//
// Rather than edit ~230 `server.tool(...)` call sites across 33 files, we wrap
// the McpServer's `tool` method once here. For every registration we infer the
// annotations from the tool NAME verb (inferToolAnnotations) and splice them in
// as the SDK's `annotations` argument — the position immediately before the
// trailing callback. The SDK (server/mcp.js) then advertises them verbatim in
// tools/list (annotations: tool.annotations).
//
// The splice is defensive: if a call site already passes an explicit annotations
// object (a non-ZodRawShape object that is not the callback), we merge our
// inferred hints UNDER the explicit ones so a hand-authored annotation always
// wins. Otherwise we insert a fresh annotations arg.
//
// The overload we support (and the one every existing site uses) is
//   tool(name, description, paramsSchema, callback)
// which becomes
//   tool(name, description, paramsSchema, annotations, callback).
// We also handle the schema-less form tool(name, description, callback).
function withAnnotationInjection(server) {
  if (server.__hrAnnotationsWrapped) return server;
  const originalTool = server.tool.bind(server);

  server.tool = function wrappedTool(name, ...rest) {
    // Never let annotation injection break registration — fall back to the
    // original call if anything about the arg shape is unexpected.
    try {
      if (typeof name !== "string" || rest.length === 0) {
        return originalTool(name, ...rest);
      }
      // The callback is the trailing function argument.
      const cbIndex = rest.length - 1;
      if (typeof rest[cbIndex] !== "function") {
        return originalTool(name, ...rest);
      }

      const inferred = inferToolAnnotations(name);

      // Is the arg just before the callback an explicit annotations object
      // (an object that is neither a ZodRawShape schema)? If so, merge.
      const preCb = rest[cbIndex - 1];
      const isExplicitAnnotations =
        cbIndex - 1 >= 0 &&
        preCb !== null &&
        typeof preCb === "object" &&
        !isZodRawShape(preCb);

      if (isExplicitAnnotations) {
        const merged = { ...inferred, ...preCb };
        const next = rest.slice();
        next[cbIndex - 1] = merged;
        return originalTool(name, ...next);
      }

      // No explicit annotations — splice the inferred object before the callback.
      const next = [...rest.slice(0, cbIndex), inferred, rest[cbIndex]];
      return originalTool(name, ...next);
    } catch {
      return originalTool(name, ...rest);
    }
  };

  server.__hrAnnotationsWrapped = true;
  return server;
}

export function registerAllTools(server) {
  withAnnotationInjection(server);
  registerEmployeeTools(server);
  registerAttendanceTools(server);
  registerLeaveTools(server);
  registerPayrollTools(server);
  registerPerformanceTools(server);
  registerRecruitmentTools(server);
  registerOnboardingTools(server);
  registerLearningTools(server);
  registerComplianceTools(server);
  registerBenefitTools(server);
  registerAnalyticsTools(server);
  registerSelfTools(server);
  registerResumeTools(server);
  registerOrgChartTools(server);
  registerPositionMgmtTools(server);
  registerProfileActionTools(server);
  registerRequisitionMgmtTools(server);
  registerCandidatePipelineTools(server);
  registerInterviewMgmtTools(server);
  registerOfferMgmtTools(server);
  registerTalentPoolMgmtTools(server);
  registerRecruitmentAnalyticsTools(server);
  registerOnboardingMgmtTools(server);
  registerRecruitmentExtraTools(server);
  registerOnboardingDashboardTools(server);
  registerOnboardingDetailTools(server);
  registerOnboardingScheduleTools(server);
  registerOnboardingPortalTools(server);
  registerTimeAttendanceTools(server);
  registerLeaveManagementTools(server);
  registerOvertimeShiftTools(server);
  registerOvertimeManagerTools(server);
  registerShiftTemplateSwapTools(server);
  registerOrgTools(server);
  registerCatalogTools(server);
  registerReportsTools(server);
  registerTimesheetReportTools(server);
  registerAttendanceOpsTools(server);
}
