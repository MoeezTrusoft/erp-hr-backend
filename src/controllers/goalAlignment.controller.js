import *as goalAlignmentService from "../services/goalAlignment.service.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped goal-alignment service so tenant B cannot read/mutate tenant A's goals.
const tenantOf = (req) => req.user?.tenantId;

export const createGoalAlignment = async (req, res) => {
  try {
    const createdBy = req.headers['employee-id'];

    const alignment = await goalAlignmentService.createGoalAlignmentService({ ...req.body, tenantId: tenantOf(req) }, createdBy);
    res.status(201).json({ success: true, alignment });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getGoalAlignments = async (req, res) => {
  try {
    const { goalId } = req.params;
    const alignments = await goalAlignmentService.getGoalAlignmentsService(goalId, tenantOf(req));
    res.status(200).json({ success: true, alignments });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteGoalAlignment = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedBy = req.headers['employee-id'];
    const result = await goalAlignmentService.deleteGoalAlignmentService(id, deletedBy, tenantOf(req));
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
