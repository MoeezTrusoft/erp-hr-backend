import express from "express";
import * as ctrl from "../controllers/gdpr.controller.js";

const router = express.Router();

router.get("/export/:employeeId", ctrl.exportData);
router.delete("/erase/:employeeId", ctrl.eraseData);

export default router;
