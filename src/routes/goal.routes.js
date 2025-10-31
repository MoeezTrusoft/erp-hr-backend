import express from "express";
import {
  createGoal,
  getGoals,
  updateGoal,
  approveGoal,
  addGoalProgress,
  getGoalProgress,
} from "../controllers/goal.controller.js";

const router = express.Router();

router.post("/", createGoal); // Create goal
router.get("/", getGoals); // Get all or by employeeId
router.put("/:id", updateGoal); // Update goal

router.put("/approve/:id", approveGoal); // Approve/reject
router.post("/progress", addGoalProgress); // Add progress update
router.get("/progress/:id", getGoalProgress); // View progress updates

export default router;
