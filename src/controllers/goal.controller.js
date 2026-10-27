import * as goalService from "../services/goal.service.js";
import { actorOf, respondPerformanceError, tenantOf } from "./performance.respond.js";

export const createGoal = async (req, res) => {
  try {
    const goal = await goalService.createGoalService(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, goal });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const getGoals = async (req, res) => {
  try {
    const { employeeId } = req.query || {};
    const goals = await goalService.getGoalsService(employeeId, tenantOf(req));
    res.status(200).json({ success: true, goals });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const updateGoal = async (req, res) => {
  try {
    const updated = await goalService.updateGoalService(req.params.id, req.body, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, goal: updated });
  } catch (error) {
    // API-2 — a stale write surfaces as 412 (HR-4120) with currentVersion.
    respondPerformanceError(req, res, error);
  }
};

export const approveGoal = async (req, res) => {
  try {
    const { status } = req.body || {};
    const goal = await goalService.approveGoalService(req.params.id, status, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, goal });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const addGoalProgress = async (req, res) => {
  try {
    const progress = await goalService.addGoalProgressService(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, progress });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const getGoalProgress = async (req, res) => {
  try {
    const updates = await goalService.getGoalProgressService(req.params.id, tenantOf(req));
    res.status(200).json({ success: true, updates });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};
