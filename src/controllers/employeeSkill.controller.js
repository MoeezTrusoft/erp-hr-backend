import * as svc from "../services/employeeSkill.service.js";

export const listSkills = async (req, res) => {
  try {
    const data = await svc.listSkills();
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const createSkill = async (req, res) => {
  try {
    const data = await svc.createSkill(req.body);
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getEmployeeSkills = async (req, res) => {
  try {
    const data = await svc.getEmployeeSkills(req.params.employeeId);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const addEmployeeSkill = async (req, res) => {
  try {
    const data = await svc.addEmployeeSkill({ ...req.body, employeeId: req.params.employeeId });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const removeEmployeeSkill = async (req, res) => {
  try {
    await svc.removeEmployeeSkill(req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
