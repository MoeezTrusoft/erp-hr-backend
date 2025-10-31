import express from "express";
import {
  createCalibrationSession,
  adjustRating,
  getAllCalibrationSessions,
  finalizeCalibration,
} from "../controllers/calibration.controller.js";

const router = express.Router();

router.post("/", createCalibrationSession);          // Create session
router.post("/adjust", adjustRating);                // Adjust rating
router.get("/", getAllCalibrationSessions);          // Get all sessions
router.put("/finalize/:id", finalizeCalibration);   // Finalize calibration

export default router;
