import *as goalService from "../services/goal.service.js";

export const createGoal = async (req, res) => {
  try {
    const goal = await goalService.createGoalService(req.body);
    res.status(201).json({ success: true, goal });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getGoals = async (req, res) => {
  try {
    const { employeeId } = req.query;
    const goals = await goalService.getGoalsService(employeeId);
    res.status(200).json({ success: true, goals });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateGoal = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await goalService.updateGoalService(id, req.body);
    res.status(200).json({ success: true, goal: updated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const approveGoal = async (req, res) => {
  try {
    const { id } = req.params;
    const { approverId, status } = req.body;
    const goal = await goalService.approveGoalService(id, approverId, status);
    res.status(200).json({ success: true, goal });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const addGoalProgress = async (req, res) => {
  try {
    const progress = await goalService.addGoalProgressService(req.body);
    res.status(201).json({ success: true, progress });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getGoalProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = await goalService.getGoalProgressService(id);
    res.status(200).json({ success: true, updates });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
