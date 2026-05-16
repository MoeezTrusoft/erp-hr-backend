import express from "express";
import * as ctrl from "../controllers/employeeLifecycle.controller.js";

const router = express.Router();

router.post("/", ctrl.logLifecycleEvent);
router.get("/", ctrl.listLifecycleEvents);
router.get("/employee/:employeeId", ctrl.getEmployeeLifecycleHistory);

export default router;
