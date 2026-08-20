// HR-ATT-DEVICE-INTAKE-01 — public-facing biometric intake.
//
// Mounted OUTSIDE the /api gateway-JWT guard: the biometric device (or the host
// iclock receiver forwarding for it) cannot present a gateway service-JWT. The
// route is instead gated by a dedicated shared secret header, X-Intake-Key, and
// is only reachable inside the cluster / from the trusted host — never via the
// public gateway, which does not proxy this path.

import express from "express";
import { ingestDevicePunches } from "../services/attendance.device-intake.service.js";
import logger from "../lib/logger.js";

const router = express.Router();

function intakeKeyGuard(req, res, next) {
    const expected = process.env.HR_ATTENDANCE_INTAKE_KEY;
    if (!expected) {
        return res.status(500).json({ success: false, message: "Intake key is not configured" });
    }
    const got = req.get("X-Intake-Key");
    if (!got || got !== expected) {
        return res.status(403).json({ success: false, message: "Invalid intake key" });
    }
    return next();
}

// POST /device-attendance/iclock-ingest
// body: { sn: string, rows: string[] }  (rows = raw tab-separated ATTLOG lines)
router.post("/iclock-ingest", intakeKeyGuard, async (req, res) => {
    try {
        const { sn, rows } = req.body || {};
        const tenantId = process.env.HR_ATTENDANCE_INTAKE_TENANT_ID;
        if (!tenantId) {
            return res.status(500).json({ success: false, message: "Intake tenant is not configured" });
        }
        if (!sn || !Array.isArray(rows)) {
            return res.status(400).json({ success: false, message: "sn and rows[] are required" });
        }
        const summary = await ingestDevicePunches({ sn, rows, tenantId });
        return res.json({ success: true, summary });
    } catch (err) {
        logger.error({ err: err?.message }, "device intake route failed");
        return res.status(err?.status || 500).json({ success: false, message: err?.message || "intake failed" });
    }
});

export default router;
