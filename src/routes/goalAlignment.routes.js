import express from "express";
import {
  createGoalAlignment,
  getGoalAlignments,
  deleteGoalAlignment,
} from "../controllers/goalAlignment.controller.js";

const router = express.Router();

router.post("/", createGoalAlignment);             // Create alignment (parent → child)
router.get("/:goalId", getGoalAlignments);         // All active alignments touching a goal
router.delete("/:id", deleteGoalAlignment);        // Archive an alignment edge

export default router;
