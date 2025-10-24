// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
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

import client from "prom-client";

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
// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/", (req, res) => res.json({message: "HR Service Running 🏢"}));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
