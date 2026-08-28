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
import { registerLeaveReportTools } from "./tools/leaveReportTools.js";
import { registerOvertimeShiftReportTools } from "./tools/overtimeShiftReportTools.js";
import { registerAuditTrailTools } from "./tools/auditTrailTools.js";
import { registerSalaryComponentTools } from "./tools/salaryComponentTools.js";
import { registerPayrollRuleTools } from "./tools/payrollRuleTools.js";
import { registerPayrollConfigTools } from "./tools/payrollConfigTools.js";
import { registerPayrollSetupActionsTools } from "./tools/payrollSetupActionsTools.js";
import { registerPayrollPreviewTools } from "./tools/payrollPreviewTools.js";
import { registerPayrollDashboardTools } from "./tools/payrollDashboardTools.js";
import { registerMyPayslipTools } from "./tools/myPayslipTools.js";
import { registerClaimsTools } from "./tools/claimsTools.js";
import { registerOnboardingPortalScreenTools } from "./tools/onboardingPortalScreenTools.js";
import { registerEmployeeImportTools } from "./tools/employeeImportTools.js";
import { registerAttendanceImportTools } from "./tools/attendanceImportTools.js";
import { registerRegionTools } from "./tools/regionTools.js";
import { registerHolidayCalendarTools } from "./tools/holidayCalendarTools.js";
import { registerPerformanceConfigTools } from "./tools/performanceConfigTools.js";
import { registerSkillTools } from "./tools/skillTools.js";
import { registerTrainingSessionTools } from "./tools/trainingSessionTools.js";
import { registerTagTools } from "./tools/tagTools.js";
import { registerOffboardingTaskTools } from "./tools/offboardingTaskTools.js";
import { registerLeavePolicyTools } from "./tools/leavePolicyTools.js";
import { registerTimesheetTools } from "./tools/timesheetTools.js";
import { registerOvertimeWorkScheduleTools } from "./tools/overtimeWorkScheduleTools.js";
import { registerApplicationTools } from "./tools/applicationTools.js";
import { registerLearningPathTools } from "./tools/learningPathTools.js";
import { registerLifecycleComplianceTools } from "./tools/lifecycleComplianceTools.js";
import { registerDevelopmentPlanTools } from "./tools/developmentPlanTools.js";
import { registerLoanTools } from "./tools/loanTools.js";
import { registerDeductionTools } from "./tools/deductionTools.js";
import { inferToolAnnotations } from "./utils/toolAnnotations.js";
import { isZodRawShape } from "./utils/isZodRawShape.js";
import { normalizeError } from "../middlewares/error.middleware.js";
import { toJsonRpcError } from "./utils/mcpErrorMap.js";
import defaultLogger from "../lib/logger.js";
import { mcpCtx } from "./context.js";

// API-6 + ERR-3/ERR-2 (ARCH-05 §6–§7, ARCH-01 §4/§13) — central error seam.
//
// The MCP SDK's CallToolRequestSchema handler renders ANY error a tool callback
// throws as `createToolError(error.message)` — i.e. the RAW prisma/ORM/stack
// text, with NO HR-nnnn code and NO status (DEFECT_LEAK + DEFECT_CONTRACT). A
// malformed payload that reaches a handler which throws a DB error would surface
// a 5xx-grade raw message. We wrap every tool callback ONCE at the single
// registration seam so a thrown error is normalized through the SAME
// normalizeError()/buildErrorEnvelope() pipeline the REST terminal middleware
// uses: generic message + HR-nnnn code for 5xx (no ORM/stack leak), client-safe
// message + code for 4xx, and a leak-safe CallToolResult carrying code+status+
// message. This is the MCP twin of the REST errorHandler (error.middleware.js).

// Map a thrown error to a leak-safe MCP CallToolResult (isError:true), mirroring
// the SAME envelope shape the per-handler withToolError() wrapper emits
// ({ error, status, code, jsonrpc }) so clients/tests see one consistent
// contract regardless of which seam caught the error. The full error is logged
// server-side exactly once; the raw error text never reaches the caller.
function safeToolErrorResult(err, toolName = "unknown_tool") {
  const jsonrpc = toJsonRpcError(err);
  const norm = normalizeError(err);
  const store = mcpCtx.getStore();
  const log = store?.log || defaultLogger;
  const correlationId = store?.correlationId || undefined;
  if (norm.httpStatus >= 500) {
    log.error(
      { toolName, argsHash: null, err, code: jsonrpc.data.code, jsonrpcCode: jsonrpc.code },
      "MCP tool failed",
    );
  } else {
    log.warn(
      { toolName, code: jsonrpc.data.code, jsonrpcCode: jsonrpc.code, message: jsonrpc.message },
      "MCP tool rejected",
    );
  }
  const body = {
    error: jsonrpc.message,
    status: norm.httpStatus,
    code: jsonrpc.data.code,
    jsonrpc: { code: jsonrpc.code, data: jsonrpc.data },
  };
  if (correlationId) body.correlationId = correlationId;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// Wrap the trailing tool callback so thrown errors become leak-safe CallToolResults.
function withSafeToolCallbacks(server) {
  if (server.__hrSafeWrapped) return server;
  const originalTool = server.tool.bind(server);
  server.tool = function wrappedTool(name, ...rest) {
    try {
      if (typeof name !== "string" || rest.length === 0) {
        return originalTool(name, ...rest);
      }
      const cbIndex = rest.length - 1;
      if (typeof rest[cbIndex] !== "function") {
        return originalTool(name, ...rest);
      }
      const inferred = inferToolAnnotations(name);
      const preCb = rest[cbIndex - 1];
      const isExplicitAnnotations =
        cbIndex - 1 >= 0 &&
        preCb !== null &&
        typeof preCb === "object" &&
        !isZodRawShape(preCb);

      // Wrap the trailing callback so any thrown error is sanitized. Success
      // returns pass through untouched; only thrown errors are intercepted.
      const originalCb = rest[cbIndex];
      const wrappedCb = async (args, extra) => {
        try {
          return await originalCb(args, extra);
        } catch (err) {
          return safeToolErrorResult(err, name);
        }
      };

      let next;
      if (isExplicitAnnotations) {
        next = rest.slice();
        next[cbIndex - 1] = { ...inferred, ...preCb };
        next[cbIndex] = wrappedCb;
      } else {
        // `inferred` is spliced immediately before the original callback, so the
        // wrapped callback lands at the original callback's position + 1.
        next = [...rest.slice(0, cbIndex), inferred, wrappedCb];
      }
      return originalTool(name, ...next);
    } catch {
      return originalTool(name, ...rest);
    }
  };
  server.__hrSafeWrapped = true;
  return server;
}

export { withSafeToolCallbacks, safeToolErrorResult };

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
  withSafeToolCallbacks(server);
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
  registerLeaveReportTools(server);
  registerOvertimeShiftReportTools(server);
  registerAuditTrailTools(server);
  registerSalaryComponentTools(server);
  registerPayrollRuleTools(server);
  registerPayrollConfigTools(server);
  registerPayrollSetupActionsTools(server);
  registerPayrollPreviewTools(server);
  registerPayrollDashboardTools(server);
  registerMyPayslipTools(server);
  registerClaimsTools(server);
  registerOnboardingPortalScreenTools(server);
  registerEmployeeImportTools(server);
  registerAttendanceImportTools(server);
  registerRegionTools(server);
  registerHolidayCalendarTools(server);
  registerPerformanceConfigTools(server);
  registerSkillTools(server);
  registerTrainingSessionTools(server);
  registerTagTools(server);
  registerOffboardingTaskTools(server);
  registerLeavePolicyTools(server);
  registerTimesheetTools(server);
  registerOvertimeWorkScheduleTools(server);
  registerApplicationTools(server);
  registerLearningPathTools(server);
  registerLifecycleComplianceTools(server);
  registerDevelopmentPlanTools(server);
  registerLoanTools(server);
  registerDeductionTools(server);
}
