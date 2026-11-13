import {
  createCalibrationSessionService,
  adjustRatingService,
  getAllCalibrationSessionsService,
  finalizeCalibrationService,
} from "../services/calibration.service.js";

// ➕ Create calibration session
export const createCalibrationSession = async (req, res) => {
  try {
    const createdBy = req.user?.userId;
    const session = await createCalibrationSessionService(req.body, createdBy, req.user?.tenantId ?? null);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    res.status(error.status || (error.name === "ZodError" ? 422 : 400)).json({ success: false, message: error.message });
  }
};

// 🧾 Adjust rating
export const adjustRating = async (req, res) => {
  try {
    const calibrated_by_employee_id = req.user?.userId;
    const adjustment = await adjustRatingService(req.body,calibrated_by_employee_id, req.user?.tenantId ?? null);
    res.status(200).json({ success: true, data: adjustment });
  } catch (error) {
    res.status(error.status || (error.name === "ZodError" ? 422 : 400)).json({ success: false, message: error.message });
  }
};

// 📋 Get all calibration sessions
export const getAllCalibrationSessions = async (req, res) => {
  try {
    const sessions = await getAllCalibrationSessionsService(req.user?.tenantId ?? null);
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    res.status(error.status || (error.name === "ZodError" ? 422 : 400)).json({ success: false, message: error.message });
  }
};

// 🔒 Finalize calibration
export const finalizeCalibration = async (req, res) => {
  try {
    const finalizedBy = req.user?.userId;
    const result = await finalizeCalibrationService(req.params.id,finalizedBy, req.user?.tenantId ?? null);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(error.status || (error.name === "ZodError" ? 422 : 400)).json({ success: false, message: error.message });
  }
};
