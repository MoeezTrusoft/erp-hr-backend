import express from "express";
import * as ctrl from "../controllers/interview.controller.js";

const router = express.Router();

router.post("/", ctrl.scheduleInterview);
router.get("/", ctrl.listInterviews);
router.put("/:id", ctrl.updateInterview);
router.post("/:id/scorecards", ctrl.submitScorecard);
router.get("/:id/scorecards", ctrl.getScorecards);

export default router;
