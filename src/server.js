// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import emergencyContactRoutes from "./routes/emergencyContacts.routes.js";
import employeeMediaRoutes from "./routes/employee.mediaRoute.js";
import hrContractRoutes from "./routes/hrContract.routes.js";
import { attachHrContext } from "./middlewares/hrContext.middleware.js";
import { attachRequestId } from "./utils/apiContract.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});
const app = express();
// Create a registry
const register = new client.Registry();
app.use(express.json());

const allowedOrigins = process.env.ALLOWED_DOMAINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) || [];

app.use(cors({
  origin: (origin, callback) => {
    // allow server-to-server calls; browser calls must be explicitly allowed
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "X-Request-ID",
  ],
  optionsSuccessStatus: 204,
}));

const requireInternalService = (req, res, next) => {
  const configuredSecret = process.env.INTERNAL_SERVICE_SECRET;
  const requestSecret = req.headers["x-internal-secret"];

  if (!configuredSecret) {
    return res.status(500).json({
      success: false,
      message: "Internal service secret is not configured",
    });
  }

  if (requestSecret !== configuredSecret) {
    return res.status(403).json({
      success: false,
      message: "Direct service access is not allowed",
    });
  }

  next();
};

app.use(attachRequestId);
app.use(attachHrContext);

// HR routes
app.use("/api", requireInternalService);
app.use("/api/hr", hrContractRoutes);
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
app.use("/api/emergency-contacts",emergencyContactRoutes)
app.use("/api/employee-media", employeeMediaRoutes);


startReviewReminderScheduler();
// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/", (req, res) => res.json({ message: "HR Service Running 🏢" }));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
