import * as svc from "../services/employeeLifecycle.service.js";

export const logLifecycleEvent = async (req, res) => {
  try {
    const performedById = req.headers["x-employee-id"] || null;
    const data = await svc.logEvent({ ...req.body, performedById });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getEmployeeLifecycleHistory = async (req, res) => {
  try {
    const data = await svc.getEmployeeHistory(req.params.employeeId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listLifecycleEvents = async (req, res) => {
  try {
    const { type, page, limit } = req.query;
    const data = await svc.listEvents({ type, page: Number(page) || 1, limit: Number(limit) || 20 });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
