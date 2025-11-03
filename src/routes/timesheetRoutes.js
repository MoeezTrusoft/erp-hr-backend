import express from "express";
import {
    getTimesheets,
    getTimesheetById,
    createTimesheet,
    submitTimesheet,
    approveTimesheet,
    rejectTimesheet
} from "../controllers/timesheetController.js";


const router = express.Router();

router.get("/",  getTimesheets);
router.post("/",  createTimesheet);
router.get("/:id",  getTimesheetById);
router.post("/:id/submit",  submitTimesheet);
router.post("/:id/approve",  approveTimesheet);
router.post("/:id/reject",  rejectTimesheet);

export default router;