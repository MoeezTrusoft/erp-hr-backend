// src/routes/health.routes.js — liveness + readiness endpoints.
//
// Per BE-§7.3 the service must expose:
//   /healthz  — cheap, no I/O. The process is up and can serve.
//   /readyz   — honest dependency probe. Returns 503 with the failure
//               reason when a hard dependency is unavailable so the
//               orchestrator (k8s / gateway) can route traffic away.
//
// The default export is a factory so tests can inject a fake prisma
// without booting the real client. server.js calls it with the
// singleton.
import express from "express";

export function createHealthRouter({ prisma, now = () => new Date() } = {}) {
    const router = express.Router();

    router.get("/healthz", (_req, res) => {
        res.status(200).json({
            status: "ok",
            service: "erp-hr-backend",
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: now().toISOString(),
        });
    });

    router.get("/readyz", async (_req, res) => {
        const checks = { database: { status: "unknown" } };
        let httpStatus = 200;
        if (!prisma) {
            checks.database.status = "fail";
            checks.database.error = "prisma client not configured";
            httpStatus = 503;
        } else {
            try {
                await prisma.$queryRaw`SELECT 1`;
                checks.database.status = "ok";
            } catch (err) {
                checks.database.status = "fail";
                checks.database.error = err?.message || "unknown database error";
                httpStatus = 503;
            }
        }
        res.status(httpStatus).json({
            status: httpStatus === 200 ? "ready" : "not_ready",
            service: "erp-hr-backend",
            checks,
            timestamp: now().toISOString(),
        });
    });

    return router;
}

export default createHealthRouter;
