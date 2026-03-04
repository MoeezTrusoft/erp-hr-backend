import * as svc from "../services/reimbursement.service.js";

export const createClaim = async (req, res) => {
  try {
    const employeeId = req.body.employeeId || req.headers["x-employee-id"];
    const data = await svc.createClaim({ ...req.body, employeeId });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listClaims = async (req, res) => {
  try {
    const data = await svc.listClaims({ employeeId: req.query.employeeId, status: req.query.status });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const uploadReceipt = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const data = await svc.uploadReceipt(req.params.id, req.files[0]);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const submitClaim = async (req, res) => {
  try {
    const data = await svc.submitClaim(req.params.id);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const approveClaim = async (req, res) => {
  try {
    const approverId = req.body.approverId || req.headers["x-employee-id"];
    const data = await svc.approveClaim(req.params.id, approverId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
