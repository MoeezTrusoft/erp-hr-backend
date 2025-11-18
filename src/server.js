// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
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
import performanceReviewRoutes from "./routes/performanceReview.routes.js"
import { startReviewReminderScheduler } from "./services/reminderScheduler.service.js";
import calibrationRoutes from "./routes/calibration.routes.js";
import calibrationReportRoutes from "./routes/calibrationReport.routes.js";
import client from "prom-client";
import timeAttendanceRoutes from './routes/timeAttendanceRoutes.js';
import leaveRoutes from './routes/leave.routes.js';
import holidayRoutes from './routes/holiday.routes.js';
import payrollRoutes from './routes/payrollRoutes.js';
import trainingRoutes from './routes/trainingRoutes.js';
import { analyticsRoutes } from './routes/analytics.js';
import recruitmentRoutes from "./routes/recruitment.routes.js";


dotenv.config();
const app = express();
// Create a registry
const register = new client.Registry();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

// HR routes
app.use("/api/employee", hrRoutes);
app.use("/api/attendance", attendanceRoutes);//no
app.use("/api/performance", performanceRoutes);
app.use("/api/positions", positionRoutes);
app.use("/api/requisitions", requisitionRoutes);
app.use("/api/train_cat", traningCategoryRoutes);//no
app.use("/api/course", traningCourseRoutes);//no
app.use("/api/enrollment", traningEnrollmentRoutes);//no
app.use("/api/log", logRoutes);
app.use("/api/performance/cycles", performanceCycleRoutes);
app.use("/api/performance/templates", performanceTemplateRoutes);
app.use("/api/goals", goalsRoutes)
app.use("/api/goal-alignments", goalAllignmentRoutes)
app.use("/api/PerformanceReview", performanceReviewRoutes)
app.use("/api/calibration", calibrationRoutes);
app.use("/api/calibration/reports", calibrationReportRoutes);//done

app.use('/api/time-attendance', timeAttendanceRoutes);//done
app.use('/api/leaves', leaveRoutes);//done
app.use('/api/holidays', holidayRoutes);//done

app.use('/api/payroll', payrollRoutes);//done
app.use('/api/training', trainingRoutes);//done
app.use('/api/analytics', analyticsRoutes); //done
app.use("/api/recruitment", recruitmentRoutes);


startReviewReminderScheduler();
// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/", (req, res) => res.json({ message: "HR Service Running 🏢" }));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
