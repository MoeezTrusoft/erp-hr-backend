import * as goalAlignmentService from "../services/goalAlignment.service.js";
import { actorOf, respondPerformanceError, tenantOf } from "./performance.respond.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped goal-alignment service so tenant B cannot read/mutate tenant A's goals.

export const createGoalAlignment = async (req, res) => {
  try {
    const alignment = await goalAlignmentService.createGoalAlignmentService(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, alignment });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const getGoalAlignments = async (req, res) => {
  try {
    // D16: the router declares `:goalId` (it used to be `:id` while the
    // controller read `goalId`, so the lookup was always undefined).
    const alignments = await goalAlignmentService.getGoalAlignmentsService(req.params.goalId, tenantOf(req));
    res.status(200).json({ success: true, alignments });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const deleteGoalAlignment = async (req, res) => {
  try {
    const result = await goalAlignmentService.deleteGoalAlignmentService(req.params.id, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};
