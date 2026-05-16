import * as svc from "../services/offboarding.service.js";

export const createOffboarding = async (req, res) => {
  try {
    const createdById = req.headers["x-employee-id"] || null;
    const data = await svc.createOffboarding({ ...req.body, createdById });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getOffboarding = async (req, res) => {
  try {
    const data = await svc.getOffboarding(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getOffboardingByEmployee = async (req, res) => {
  try {
    const data = await svc.getOffboardingByEmployee(req.params.employeeId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const updateOffboarding = async (req, res) => {
  try {
    const data = await svc.updateOffboarding(req.params.id, req.body);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const addOffboardingTask = async (req, res) => {
  try {
    const data = await svc.addTask({ ...req.body, checklistId: req.params.id });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const updateOffboardingTask = async (req, res) => {
  try {
    const data = await svc.updateTask(req.params.taskId, req.body);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const uploadExitInterview = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const data = await svc.uploadExitInterview(req.params.id, req.files[0]);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
