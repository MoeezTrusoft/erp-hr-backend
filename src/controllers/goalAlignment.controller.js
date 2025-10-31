import *as goalAlignmentService from "../services/goalAlignment.service.js";

export const createGoalAlignment = async (req, res) => {
  try {
    const alignment = await goalAlignmentService.createGoalAlignmentService(req.body);
    res.status(201).json({ success: true, alignment });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getGoalAlignments = async (req, res) => {
  try {
    const { goalId } = req.params;
    const alignments = await goalAlignmentService.getGoalAlignmentsService(goalId);
    res.status(200).json({ success: true, alignments });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteGoalAlignment = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await goalAlignmentService.deleteGoalAlignmentService(id);
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
