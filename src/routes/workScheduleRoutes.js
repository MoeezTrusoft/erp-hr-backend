import express from "express";
import {
    getWorkSchedules,
    createWorkSchedule,
    updateWorkSchedule,
    deleteWorkSchedule
} from "../controllers/workScheduleController.js";


const router = express.Router();

router.get("/", getWorkSchedules);
router.post("/", createWorkSchedule);
router.put("/:id", updateWorkSchedule);
router.delete("/:id", deleteWorkSchedule);

export default router;