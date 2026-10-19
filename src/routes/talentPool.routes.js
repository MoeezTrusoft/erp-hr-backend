import express from "express";
import * as ctrl from "../controllers/talentPool.controller.js";

const router = express.Router();

router.get("/", ctrl.listPools);
router.post("/", ctrl.addToPool);
router.delete("/:id", ctrl.removeFromPool);
router.get("/candidates", ctrl.getCandidatesInPool);

// FR-10 residue — the invitation lifecycle, segmentation and the pool retention
// sweep. Declared BEFORE the "/:id" routes below so "invitations" and "segment"
// are never parsed as a pool id.
router.get("/invitations", ctrl.listInvitations);
router.put("/invitations/:id", ctrl.respondToInvitationCtrl);
router.post("/segment", ctrl.segmentPool);
router.post("/retention/sweep", ctrl.retentionSweep);

export default router;
