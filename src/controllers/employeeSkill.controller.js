import * as svc from "../services/employeeSkill.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped employee-skill service so tenant B cannot read/mutate tenant A's skills.
const tenantOf = (req) => req.user?.tenantId;

export const listSkills = async (req, res) => {
  try {
    const data = await svc.listSkills(tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const createSkill = async (req, res) => {
  try {
    const data = await svc.createSkill({ ...req.body, tenantId: tenantOf(req) });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getEmployeeSkills = async (req, res) => {
  try {
    const data = await svc.getEmployeeSkills(req.params.employeeId, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const addEmployeeSkill = async (req, res) => {
  try {
    const data = await svc.addEmployeeSkill({ ...req.body, employeeId: req.params.employeeId, tenantId: tenantOf(req) });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const removeEmployeeSkill = async (req, res) => {
  try {
    await svc.removeEmployeeSkill(req.params.id, tenantOf(req));
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
