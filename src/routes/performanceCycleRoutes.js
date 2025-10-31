import express from "express";
import { createCycle, deleteCycle, getAllCycles, getCycleById, updateCycle } from "../controllers/performanceCycleController.js";

const router = express.Router();

router.post("/", createCycle);
router.get("/", getAllCycles);
router.get("/:id", getCycleById);
router.put("/:id", updateCycle);
router.delete("/:id", deleteCycle);

export default router;
