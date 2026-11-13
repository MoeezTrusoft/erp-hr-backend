import { runController } from "./_runner.js";
import { getAllReviews, createPerformanceReview, updateReview, addFeedback, listEmployeeNineBox } from "../../controllers/performance.controller.js";
import { getGoals, createGoal, updateGoal, approveGoal, addGoalProgress } from "../../controllers/goal.controller.js";
import { getAllCalibrationSessions, createCalibrationSession, finalizeCalibration, adjustRating } from "../../controllers/calibration.controller.js";
import { createPlan } from "../../controllers/developmentPlan.controller.js";

export const mcpListPerformanceReviews = (user) => runController(getAllReviews, { user });
export const mcpListGoals = (user) => runController(getGoals, { user });
export const mcpListCalibrationSessions = (user) => runController(getAllCalibrationSessions, { user });
// Analytics grid binds to this resource and categorises EMPLOYEES on a
// performance × potential matrix, so return per-employee nine-box aggregates
// (derived from scored reviews) rather than the competency catalog.
export const mcpListPerformanceMetrics = (user) => runController(listEmployeeNineBox, { user });

export const mcpCreateGoal = (user, data) => runController(createGoal, { user, body: data });
export const mcpUpdateGoal = (user, id, data) => runController(updateGoal, { user, params: { id: String(id) }, body: data });
export const mcpApproveGoal = (user, id, data) => runController(approveGoal, { user, params: { id: String(id) }, body: data });
export const mcpRecordGoalProgress = (user, data) => runController(addGoalProgress, { user, body: data });

export const mcpCreatePerformanceReview = (user, data) => runController(createPerformanceReview, { user, body: data });
export const mcpUpdatePerformanceReview = (user, id, data) => runController(updateReview, { user, params: { id: String(id) }, body: data });
export const mcpAddPerformanceFeedback = (user, data) => runController(addFeedback, { user, body: data });

export const mcpCreateCalibration = (user, data) => runController(createCalibrationSession, { user, body: data });
export const mcpFinalizeCalibration = (user, id, data = {}) => runController(finalizeCalibration, { user, params: { id: String(id) }, body: data });
export const mcpAdjustCalibrationRating = (user, data) => runController(adjustRating, { user, body: data });

export const mcpCreateDevelopmentPlan = (user, data) => runController(createPlan, { user, body: data });
