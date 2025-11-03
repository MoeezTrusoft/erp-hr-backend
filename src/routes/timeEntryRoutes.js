import express from "express";
import {
  getTimeEntries,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  clockIn,
  clockOut,
  startBreak,
  endBreak,
  getCurrentStatus
} from "../controllers/timeEntryController.js";


const router = express.Router();

router.get("/", getTimeEntries);
router.post("/", createTimeEntry);
router.put("/:id", updateTimeEntry);
router.delete("/:id", deleteTimeEntry);
router.post("/clock-in", clockIn);
router.post("/clock-out", clockOut);
router.post("/break-start", startBreak);
router.post("/break-end", endBreak);
router.get("/current-status", getCurrentStatus);

export default router;