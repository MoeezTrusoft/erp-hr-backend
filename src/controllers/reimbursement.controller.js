import * as svc from "../services/reimbursement.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped reimbursement service so tenant B cannot read/mutate tenant A's claims.
const tenantOf = (req) => req.user?.tenantId;

export const createClaim = async (req, res) => {
  try {
    const employeeId = req.body.employeeId || req.headers["x-employee-id"];
    const data = await svc.createClaim({ ...req.body, employeeId, tenantId: tenantOf(req) });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listClaims = async (req, res) => {
  try {
    const data = await svc.listClaims({ employeeId: req.query.employeeId, status: req.query.status, tenantId: tenantOf(req) });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const uploadReceipt = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const data = await svc.uploadReceipt(req.params.id, req.files[0], tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const submitClaim = async (req, res) => {
  try {
    const data = await svc.submitClaim(req.params.id, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const approveClaim = async (req, res) => {
  try {
    const approverId = req.body.approverId || req.headers["x-employee-id"];
    const data = await svc.approveClaim(req.params.id, approverId, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
