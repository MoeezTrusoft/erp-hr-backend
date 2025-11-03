// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import logRoutes from "./routes/log.route.js";
import hrRoutes from "./routes/hr.routes.js";
import attendanceRoutes from "./routes/attendance.routes.js";
import leaveRoutes from "./routes/leave.routes.js";
import holidayRoutes from "./routes/holiday.routes.js";
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


dotenv.config();
const app = express();
// Create a registry
const register = new client.Registry();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

// HR routes
app.use("/api/employee", hrRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/holidays", holidayRoutes);
app.use("/api/performance", performanceRoutes);
app.use("/api/positions", positionRoutes);
app.use("/api/requisitions", requisitionRoutes);
app.use("/api/train_cat", traningCategoryRoutes);
app.use("/api/course", traningCourseRoutes);
app.use("/api/enrollment", traningEnrollmentRoutes);
app.use("/api/log", logRoutes);
app.use("/api/performance/cycles", performanceCycleRoutes);
app.use("/api/performance/templates", performanceTemplateRoutes);
app.use("/api/goals", goalsRoutes)
app.use("/api/goal-alignments", goalAllignmentRoutes)
app.use("/api/PerformanceReview", performanceReviewRoutes)
app.use("/api/calibration", calibrationRoutes);
app.use("/api/calibration/reports", calibrationReportRoutes);

app.use('/api/time-attendance', timeAttendanceRoutes);


startReviewReminderScheduler();
// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/", (req, res) => res.json({ message: "HR Service Running 🏢" }));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
