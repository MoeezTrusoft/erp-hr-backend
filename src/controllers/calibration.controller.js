import {
  createCalibrationSessionService,
  adjustRatingService,
  getAllCalibrationSessionsService,
  finalizeCalibrationService,
} from "../services/calibration.service.js";

// ➕ Create calibration session
export const createCalibrationSession = async (req, res) => {
  try {
    const createdBy = req.headers['employee-id'];
    const session = await createCalibrationSessionService(req.body, createdBy);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// 🧾 Adjust rating
export const adjustRating = async (req, res) => {
  try {
    const calibrated_by_employee_id = req.headers['employee-id'];
    const adjustment = await adjustRatingService(req.body,calibrated_by_employee_id);
    res.status(200).json({ success: true, data: adjustment });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// 📋 Get all calibration sessions
export const getAllCalibrationSessions = async (req, res) => {
  try {
    const sessions = await getAllCalibrationSessionsService();
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// 🔒 Finalize calibration
export const finalizeCalibration = async (req, res) => {
  try {
    const finalizedBy = req.headers['employee-id'];
    const result = await finalizeCalibrationService(req.params.id,finalizedBy);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
