import express from "express";
import * as ctrl from "../controllers/talentPool.controller.js";

const router = express.Router();

router.get("/", ctrl.listPools);
router.post("/", ctrl.addToPool);
router.delete("/:id", ctrl.removeFromPool);
router.get("/candidates", ctrl.getCandidatesInPool);

export default router;
