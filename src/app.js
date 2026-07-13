// src/app.js
//
// Testable Express app factory for erp-hr-backend.
//
// `createApp()` returns a fully-wired Express app -- same middleware
// chain, same route mounts, same internal-secret gate as the running
// service -- but does **no** I/O on its own: no `app.listen`, no
// socket.io server, no attendance bootstrap, no scheduler, no signal
// handlers. Those live in src/server.js, which imports this factory
// and bolts on the runtime side of the process.
//
// Why a factory and not a singleton:
//   src/server.js calls `dotenv.config()` after ESM imports have been
//   hoisted. The factory pattern means env-driven config (CORS allow-
//   list, etc.) is evaluated when server.js explicitly calls
//   `createApp()` -- AFTER dotenv has run -- not at import time.
//
// What this file is allowed to do:
//   * Wire express middleware (json, cors, attachRequestId, attachHrContext)
//   * Mount the same routes as before, in the same order
//   * Mount the internal-secret gate on /api
//   * Mount the health router (no I/O at registration time)
//   * Define the /metrics endpoint
//
// What this file MUST NOT do:
//   * Import any module whose top level starts I/O (attendance bootstrap,
//     reminder scheduler, attendance listener, socket server)
//   * Call app.listen / createServer
//   * Register process signal handlers
import express from "express";
import cors from "cors";
import client from "prom-client";
import prisma from "./lib/prisma.js";
import { createHealthRouter } from "./routes/health.routes.js";
import { createComplianceHealthRouter } from "./routes/complianceHealth.routes.js";

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
import hrContractRoutes from "./routes/hrContract.routes.js";
import { attachHrContext } from "./middlewares/hrContext.middleware.js";
import { internalServiceGuard } from "./middlewares/internalService.middleware.js";
import { attachInternalBoundaryMetric } from "./lib/authMetrics.js";
import {
    createHttpMetricsMiddleware,
    attachHttpRequestDurationMetric,
} from "./lib/httpMetrics.js";
import { attachRequestId } from "./utils/apiContract.js";
import { attachCorrelationId } from "./middlewares/correlationId.middleware.js";
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
import benefitRoutes from "./routes/benefit.routes.js";
import resumeRoutes from "./routes/resume.routes.js";

import mcpRouter from "./mcp/mcpRouter.js";

export const createApp = () => {
    const app = express();
    const register = new client.Registry();
    // Surface the inbound-boundary counter on /metrics so the
    // X-Internal-Secret → service-JWT sunset is observable from the
    // same exposition the rest of the service uses. attachInternal-
    // BoundaryMetric is idempotent across createApp() calls.
    attachInternalBoundaryMetric(register);
    // A-RED (08-sota-roadmap §DO-NOW #2): surface the shared
    // http_request_duration_seconds histogram on this app's /metrics so
    // Prometheus/Grafana can compute Rate / Error / p95 per route.
    attachHttpRequestDurationMetric(register);

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
            "X-Service-Authorization",
            "X-Internal-Secret",
            // C.2 / T-P2.2 — clients send Idempotency-Key on mutating HR calls.
            "Idempotency-Key",
        ],
        optionsSuccessStatus: 204,
    }));

    app.use(attachRequestId);
    // A.5: read/mint x-correlation-id, bind a per-request child logger on
    // req.log, echo the header on the response. Mounted before the route tree
    // (and before the /api guard) so EVERY request — including health probes
    // and rejected calls — is traceable end-to-end.
    app.use(attachCorrelationId);
    app.use(attachHrContext);

    // A-RED (08-sota-roadmap §DO-NOW #2): observe inbound request duration into
    // the http_request_duration_seconds histogram (exposed on this app's
    // /metrics). Mounted BEFORE the route tree (and the /api guard) so it times
    // every request via res 'finish'/'close'. Purely observational — never
    // alters response/auth/tenancy.
    app.use(createHttpMetricsMiddleware());

    // HR routes
    // Browser clients should reach this service through the API gateway. The gateway
    // is responsible for rewriting /hr/api/hr/* to /api/hr/* and injecting the
    // internal secret plus x-user-* context headers before requests arrive here.
    app.use("/api", internalServiceGuard);
    app.use("/api/hr", hrContractRoutes);
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
    app.use("/api/benefits", benefitRoutes);
    app.use("/api/resume", resumeRoutes);

    app.get("/metrics", async (_req, res) => {
        res.setHeader("Content-Type", register.contentType);
        res.end(await register.metrics());
    });

    // SECURITY: the /mcp boundary MUST verify the gateway's service-JWT (same as
    // /api above + rbac/comms /mcp) — NOT merely trust a present x-mcp-internal
    // header. Without internalServiceGuard, any caller reaching this service with
    // a non-empty x-mcp-internal could spoof tenant/permissions in the MCP ctx and
    // bypass every HR tool gate (payroll/SSN/bank/benefits/GDPR). [HR-MCP-AUTH-01]
    app.use("/mcp", internalServiceGuard, mcpRouter);

    app.get("/", (_req, res) => res.json({ message: "HR Service Running 🏢" }));

    // /healthz (liveness) + /readyz (readiness; pings DB via singleton).
    app.use(createHealthRouter({ prisma }));

    // A.6: GET /compliance — readyz-style conformance assertion (verify key
    // present, outbox dispatcher heartbeat, key/cert expiry). Mounted at the
    // top level alongside /readyz so probes reach it without the /api guard.
    app.use(createComplianceHealthRouter());

    return app;
};

export default createApp;
