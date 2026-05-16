import express from "express";
import * as ctrl from "../controllers/developmentPlan.controller.js";

const router = express.Router();

router.post("/", ctrl.createPlan);
router.get("/", ctrl.listPlans);
router.post("/:id/items", ctrl.addPlanItem);
router.get("/:id/items", ctrl.listPlanItems);
router.put("/items/:id", ctrl.updatePlanItem);

export default router;
