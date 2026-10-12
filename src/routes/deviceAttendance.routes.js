import express from "express";
import {
  authenticateCaptureDevice,
  receiveCapture,
  captureHeartbeat,
} from "../services/attendanceCapture.service.js";
import logger from "../lib/logger.js";
import biometricRoutes from './attendanceBiometric.routes.js';
const router = express.Router();
router.use('/biometric', biometricRoutes);
router.post("/iclock-ingest", async (req, res) => {
  try {
    const { sn, rows } = req.body || {};
    await authenticateCaptureDevice(sn, req.get("X-Intake-Key"));
    const summary = await receiveCapture({
      sn,
      rows,
      requestKey: req.get("Idempotency-Key"),
    });
    return res.status(202).json({ success: true, summary });
  } catch (err) {
    logger.warn({ status: err.status || 500 }, "Device capture rejected");
    return res
      .status(err.status || 500)
      .json({
        success: false,
        message: err.status
          ? err.message
          : "Attendance receipt could not be stored; retry the submission",
      });
  }
});
router.post("/heartbeat", async (req, res) => {
  try {
    const device = await authenticateCaptureDevice(
      req.body?.sn,
      req.get("X-Intake-Key"),
    );
    await captureHeartbeat({ device, deviceTime: req.body?.deviceTime });
    res.json({ success: true });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({
        success: false,
        message: err.status ? err.message : "Heartbeat failed",
      });
  }
});
export default router;
