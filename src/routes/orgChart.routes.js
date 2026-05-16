import express from "express";
import * as ctrl from "../controllers/orgChart.controller.js";

const router = express.Router();

router.get("/", ctrl.getOrgChart);
router.get("/:employeeId", ctrl.getOrgSubtree);

export default router;
