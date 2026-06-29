import {
  getCalibrationOverviewService,
  getAverageByDepartmentService,
  getAverageByManagerService,
  getCycleComparisonService,
} from "../services/calibrationReport.service.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped calibration reads so a tenant's calibration stats never fold in another
// tenant's ratings.
const tenantOf = (req) => req.user?.tenantId;

export const getCalibrationOverview = async (req, res) => {
  try {
    const data = await getCalibrationOverviewService(tenantOf(req));
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getAverageByDepartment = async (req, res) => {
  try {
    const data = await getAverageByDepartmentService(tenantOf(req));
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getAverageByManager = async (req, res) => {
  try {
    const data = await getAverageByManagerService(tenantOf(req));
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getCycleComparison = async (req, res) => {
  try {
    const { cycleId } = req.params;
    const data = await getCycleComparisonService(cycleId, tenantOf(req));
    res.status(200).json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

