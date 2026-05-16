import * as svc from "../services/compliance.service.js";

export const createChecklist = async (req, res) => {
  try {
    const createdById = req.headers["x-employee-id"] || null;
    const data = await svc.createChecklist({ ...req.body, createdById });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listChecklists = async (_req, res) => {
  try {
    const data = await svc.listChecklists();
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const addChecklistItem = async (req, res) => {
  try {
    const data = await svc.addChecklistItem({ ...req.body, checklistId: req.params.id });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listChecklistItems = async (req, res) => {
  try {
    const data = await svc.listChecklistItems(req.params.id);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const updateItem = async (req, res) => {
  try {
    const data = await svc.updateItem(req.params.id, req.body);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const uploadEvidence = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const data = await svc.uploadEvidence(req.params.id, req.files[0]);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
