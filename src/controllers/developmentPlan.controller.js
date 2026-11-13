import * as svc from "../services/developmentPlan.service.js";
import { respondServerError } from '../utils/httpError.js';

export const createPlan = async (req, res) => {
  try {
    const data = await svc.createPlan(req.body);
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listPlans = async (req, res) => {
  try {
    const data = await svc.listPlans({ employeeId: req.query.employeeId });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const addPlanItem = async (req, res) => {
  try {
    const data = await svc.addPlanItem({ ...req.body, planId: req.params.id });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listPlanItems = async (req, res) => {
  try {
    const data = await svc.listPlanItems(req.params.id);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const updatePlanItem = async (req, res) => {
  try {
    const data = await svc.updatePlanItem(req.params.id, req.body);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
