import express from "express";
import {
  createGoalAlignment,
  getGoalAlignments,
  deleteGoalAlignment,
} from "../controllers/goalAlignment.controller.js";

const router = express.Router();

router.post("/", createGoalAlignment);           // Create alignment
router.get("/:id", getGoalAlignments);       // Get all alignments (for a specific goal)
router.delete("/:id", deleteGoalAlignment);      // Delete alignment

export default router;
