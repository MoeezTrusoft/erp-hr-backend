import * as svc from "../services/orgChart.service.js";

export const getOrgChart = async (_req, res) => {
  try {
    const data = await svc.getOrgChart();
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const getOrgSubtree = async (req, res) => {
  try {
    const data = await svc.getOrgSubtree(req.params.employeeId);
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
