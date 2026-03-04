import express from "express";
import * as ctrl from "../controllers/compliance.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/checklists", ctrl.createChecklist);
router.get("/checklists", ctrl.listChecklists);
router.post("/checklists/:id/items", ctrl.addChecklistItem);
router.get("/checklists/:id/items", ctrl.listChecklistItems);
router.put("/items/:id", ctrl.updateItem);
router.post("/items/:id/evidence", dynamicUpload, ctrl.uploadEvidence);

export default router;
