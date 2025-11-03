import express from "express";
import timeEntryRoutes from "./timeEntryRoutes.js";
import timesheetRoutes from "./timesheetRoutes.js";
import overtimeRoutes from "./overtimeRoutes.js";
import workScheduleRoutes from "./workScheduleRoutes.js";

const router = express.Router();

router.use("/entries", timeEntryRoutes);
router.use("/timesheets", timesheetRoutes);
router.use("/overtime-rules", overtimeRoutes);
router.use("/work-schedules", workScheduleRoutes);

export default router;