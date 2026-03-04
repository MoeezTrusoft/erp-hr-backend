import * as svc from "../services/gdpr.service.js";

export const exportData = async (req, res) => {
  try {
    const data = await svc.exportEmployeeData(req.params.employeeId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const eraseData = async (req, res) => {
  try {
    const data = await svc.eraseEmployeeData(req.params.employeeId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
