import express from "express";
import { authenticateCaptureDevice } from "../services/attendanceCapture.service.js";
import {
  readBiometricChallenge,
  requestBiometricVerification,
  submitBiometricSample,
} from "../services/attendanceBiometric.service.js";
import logger from "../lib/logger.js";

const router = express.Router();
const handler = (fn) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const device = await authenticateCaptureDevice(
      req.body?.sn,
      req.get("X-Intake-Key"),
    );
    const data = await fn(req, device);
    res.status(200).json({ success: true, data });
  } catch (err) {
    // Never log submitted images, templates, credentials, or engine responses.
    logger.warn(
      { status: err.status || 500 },
      "Biometric capture could not complete",
    );
    res
      .status(err.status || 500)
      .json({
        success: false,
        message: err.status
          ? err.message
          : "Biometric capture unavailable; retry safely",
      });
  }
};
router.post(
  "/challenge",
  handler((req, device) =>
    requestBiometricVerification({
      device,
      employeeCode: req.body.employeeCode,
      modality: req.body.modality,
      slot: req.body.slot,
      direction: req.body.direction,
    }),
  ),
);
router.post(
  "/challenge/read",
  handler((req, device) =>
    readBiometricChallenge({ device, id: req.body.challengeId }),
  ),
);
router.post(
  "/sample",
  handler((req, device) =>
    submitBiometricSample({
      device,
      input: req.body,
      signature: req.get("X-Biometric-Signature"),
    }),
  ),
);
export default router;
