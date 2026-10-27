import {
  createCalibrationSessionService,
  adjustRatingService,
  getAllCalibrationSessionsService,
  finalizeCalibrationService,
} from "../services/calibration.service.js";
import { respondServerError } from "../utils/httpError.js";
import { actorOf, respondPerformanceError, tenantOf } from "./performance.respond.js";

// ➕ Create calibration session
export const createCalibrationSession = async (req, res) => {
  try {
    const session = await createCalibrationSessionService(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

// 🧾 Adjust rating
export const adjustRating = async (req, res) => {
  try {
    const adjustment = await adjustRatingService(req.body, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, data: adjustment });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

// 📋 Get all calibration sessions
export const getAllCalibrationSessions = async (req, res) => {
  try {
    const sessions = await getAllCalibrationSessionsService(tenantOf(req));
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

// 🔒 Finalize calibration
export const finalizeCalibration = async (req, res) => {
  try {
    const result = await finalizeCalibrationService(req.params.id, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};
