import express from "express";
import {
  getCalibrationOverview,
  getAverageByDepartment,
  getAverageByManager,
  getCycleComparison,
} from "../controllers/calibrationReport.controller.js";

const router = express.Router();

router.get("/overview", getCalibrationOverview);
router.get("/by-department", getAverageByDepartment);
router.get("/by-manager", getAverageByManager);
router.get("/comparison/:cycleId", getCycleComparison);

export default router;
