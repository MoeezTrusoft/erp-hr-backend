import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import client from "prom-client";

import logRoutes from "./routes/log.route.js";
import hrRoutes from "./routes/hr.routes.js";
import attendanceRoutes from "./routes/attendance.routes.js";
import performanceRoutes from "./routes/performance.routes.js";
import positionRoutes from "./routes/position.routes.js";
import requisitionRoutes from "./routes/requisition.routes.js";
import traningCategoryRoutes from "./routes/trainingCategory.routes.js";
import traningCourseRoutes from "./routes/trainingCourse.routes.js";
import traningEnrollmentRoutes from "./routes/trainingEnrollment.routes.js";
import performanceCycleRoutes from "./routes/performanceCycleRoutes.js";
import performanceTemplateRoutes from "./routes/performanceTemplateRoutes.js";
import goalsRoutes from "./routes/goal.routes.js";
import goalAllignmentRoutes from "./routes/goalAlignment.routes.js";
import performanceReviewRoutes from "./routes/performanceReview.routes.js";
import calibrationRoutes from "./routes/calibration.routes.js";
import calibrationReportRoutes from "./routes/calibrationReport.routes.js";
import timeAttendanceRoutes from "./routes/timeAttendanceRoutes.js";
import leaveRoutes from "./routes/leave.routes.js";
import holidayRoutes from "./routes/holiday.routes.js";
import payrollRoutes from "./routes/payrollRoutes.js";
import trainingRoutes from "./routes/trainingRoutes.js";
import { analyticsRoutes } from "./routes/analytics.js";
import recruitmentRoutes from "./routes/recruitment.routes.js";
import emergencyContactRoutes from "./routes/emergencyContacts.routes.js";
import employeeMediaRoutes from "./routes/employee.mediaRoute.js";
import dashboardLayoutRoutes from "./routes/dashboardLayout.routes.js";

import onboardingRoutes from "./routes/onboarding.routes.js";
import interviewRoutes from "./routes/interview.routes.js";
import offerRoutes from "./routes/offer.routes.js";
import talentPoolRoutes from "./routes/talentPool.routes.js";
import learningPathRoutes from "./routes/learningPath.routes.js";
import trainingSessionRoutes from "./routes/trainingSession.routes.js";
import certificationRoutes from "./routes/certification.routes.js";
import employeeSkillRoutes from "./routes/employeeSkill.routes.js";
import employeeLifecycleRoutes from "./routes/employeeLifecycle.routes.js";
import offboardingRoutes from "./routes/offboarding.routes.js";
import orgChartRoutes from "./routes/orgChart.routes.js";
import selfRoutes from "./routes/self.routes.js";
import complianceRoutes from "./routes/compliance.routes.js";
import developmentPlanRoutes from "./routes/developmentPlan.routes.js";
import reimbursementRoutes from "./routes/reimbursement.routes.js";
import gdprRoutes from "./routes/gdpr.routes.js";

import { startReviewReminderScheduler } from "./services/reminderScheduler.service.js";
import mcpRouter from "./mcp/mcpRouter.js";

dotenv.config();
const app = express();
const register = new client.Registry();

app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

app.use("/api/employee", hrRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/performance", performanceRoutes);
app.use("/api/positions", positionRoutes);
app.use("/api/requisitions", requisitionRoutes);
app.use("/api/train_cat", traningCategoryRoutes);
app.use("/api/course", traningCourseRoutes);
app.use("/api/enrollment", traningEnrollmentRoutes);
app.use("/api/log", logRoutes);
app.use("/api/performance/cycles", performanceCycleRoutes);
app.use("/api/performance/templates", performanceTemplateRoutes);
app.use("/api/goals", goalsRoutes);
app.use("/api/goal-alignments", goalAllignmentRoutes);
app.use("/api/PerformanceReview", performanceReviewRoutes);
app.use("/api/calibration", calibrationRoutes);
app.use("/api/calibration/reports", calibrationReportRoutes);
app.use("/api/time-attendance", timeAttendanceRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/holidays", holidayRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/training", trainingRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/recruitment", recruitmentRoutes);
app.use("/api/emergency-contacts", emergencyContactRoutes);
app.use("/api/employee-media", employeeMediaRoutes);
app.use("/api/dashboard-layout", dashboardLayoutRoutes);

app.use("/api/onboarding", onboardingRoutes);
app.use("/api/interviews", interviewRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/talent-pool", talentPoolRoutes);
app.use("/api/learning-paths", learningPathRoutes);
app.use("/api/training-sessions", trainingSessionRoutes);
app.use("/api/certifications", certificationRoutes);
app.use("/api/skills", employeeSkillRoutes);
app.use("/api/employee-lifecycle", employeeLifecycleRoutes);
app.use("/api/offboarding", offboardingRoutes);
app.use("/api/org-chart", orgChartRoutes);
app.use("/api/self", selfRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/development-plans", developmentPlanRoutes);
app.use("/api/reimbursements", reimbursementRoutes);
app.use("/api/gdpr", gdprRoutes);

startReviewReminderScheduler();

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/mcp", mcpRouter);

app.get("/", (_req, res) => res.json({ message: "HR Service Running 🏢" }));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
