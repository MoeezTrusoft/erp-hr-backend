import {
  getCalibrationOverviewService,
  getAverageByDepartmentService,
  getAverageByManagerService,
  getCycleComparisonService,
} from "../services/calibrationReport.service.js";

export const getCalibrationOverview = async (req, res) => {
  try {
    const data = await getCalibrationOverviewService();
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getAverageByDepartment = async (req, res) => {
  try {
    const data = await getAverageByDepartmentService();
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getAverageByManager = async (req, res) => {
  try {
    const data = await getAverageByManagerService();
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getCycleComparison = async (req, res) => {
  try {
    const { cycleId } = req.params;
    const data = await getCycleComparisonService(cycleId);
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

