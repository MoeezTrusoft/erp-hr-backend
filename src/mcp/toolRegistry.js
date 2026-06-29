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

export function registerAllTools(server) {
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
}
